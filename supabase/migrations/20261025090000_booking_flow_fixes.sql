-- Booking flow between the customer app, the partner portal and the Super Admin (2026-10-25).
--
-- Found while testing the three apps together:
--   1. A booking from the app was confirmed instantly. create_order honours branches.auto_confirm,
--      and the account scripts created every branch with auto_confirm = true (the platform default
--      is manual confirmation). The two script-made branches are switched back to manual here;
--      the wash can still turn auto-confirm on from Branches → booking rules.
--   2. Washes that are only "approved" (onboarding, not live) could take app bookings, and branches of
--      suspended/onboarding washes were listed in the app. Only active washes are listed and bookable now.
--   3. Offers: the panels treat an offer as live from its dates, but the database kept the status that
--      was stored when the offer was saved, so a "scheduled" offer never became "active" for the app
--      (and an expired one stayed "active"). Statuses are refreshed every 5 minutes, and create_order
--      uses the same rule as the panels (dates, not draft/disabled).
--   4. A customer rescheduling a confirmed booking kept it confirmed for a time the wash never agreed
--      to. With manual confirmation it goes back to "pending" for the wash to confirm again.
--   5. Customer notifications: an auto-confirmed booking said "under review" and never "confirmed";
--      cancellations didn't say who cancelled or why; no-shows and reschedules said nothing.

-- ── 1. Manual confirmation for the script-created branches ──
update public.branches set auto_confirm = false
where auto_confirm and id in ('br_2f8281b08a924537', 'br_4a180b79f36b4de3');

-- ── 2. Only active washes are listed and bookable ──
create or replace function public.is_business_live(p_business_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.businesses b where b.id = p_business_id and b.status = 'active');
$$;
revoke all on function public.is_business_live(text) from public;
grant execute on function public.is_business_live(text) to anon, authenticated;

drop policy if exists "Public read active branches" on public.branches;
create policy "Public read active branches" on public.branches
  for select to anon, authenticated
  using (active and public.is_business_live(business_id));

-- ── 3. Offer statuses follow their dates ──
create or replace function public.refresh_offer_statuses()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_n integer;
begin
  update public.offers o
  set status = s.live
  from (
    select id, (case when ends_at < now() then 'expired' when starts_at > now() then 'scheduled' else 'active' end)::public.offer_status as live
    from public.offers where status not in ('draft', 'disabled')
  ) s
  where o.id = s.id and o.status <> s.live;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.refresh_offer_statuses() from public, anon, authenticated;

select public.refresh_offer_statuses();
select cron.unschedule(jobid) from cron.job where jobname = 'refresh-offer-statuses';
select cron.schedule('refresh-offer-statuses', '*/5 * * * *', 'select public.refresh_offer_statuses()');

-- ── create_order: live washes only; offers by date like the panels ──
create or replace function public.create_order(p_branch_id text, p_vehicle_id text, p_primary_service_id text, p_scheduled_at timestamp with time zone, p_addon_service_ids text[] default '{}'::text[])
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_cust public.customers := public._booking_customer();
  v_branch public.branches%rowtype;
  v_vehicle public.vehicles%rowtype;
  v_primary public.services%rowtype;
  v_addons public.services[];
  v_addon_ids text[] := array(select distinct unnest(coalesce(p_addon_service_ids, '{}')));
  v_subtotal numeric;
  v_duration int;
  v_offer_id text;
  v_offer_type public.discount_type;
  v_offer_value numeric;
  v_discount numeric := 0;
  v_order public.orders%rowtype;
  v_status public.order_status;
begin
  select b.* into v_branch
  from public.branches b
  join public.businesses biz on biz.id = b.business_id
  where b.id = p_branch_id and b.active and biz.status = 'active';
  if not found then
    raise exception 'branch_unavailable';
  end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id and customer_id = v_cust.id;
  if not found then
    raise exception 'vehicle_not_found';
  end if;

  select * into v_primary
  from public.services
  where id = p_primary_service_id and branch_id = v_branch.id and type = 'primary' and active;
  if not found then
    raise exception 'service_not_found';
  end if;

  select coalesce(array_agg(s order by array_position(v_addon_ids, s.id)), '{}') into v_addons
  from public.services s
  where s.id = any (v_addon_ids) and s.branch_id = v_branch.id and s.type = 'addon' and s.active;
  if cardinality(v_addons) <> cardinality(v_addon_ids) then
    raise exception 'invalid_addon';
  end if;

  select v_primary.price + coalesce(sum(a.price), 0),
         v_primary.duration_min + coalesce(sum(a.duration_min), 0)::int
    into v_subtotal, v_duration
  from unnest(v_addons) as a;

  -- Best live offer for this branch; applies to the primary service only (same rule as the partner
  -- portal). Live = inside its dates and not draft/disabled. No categories = every service.
  select o.id, o.discount_type, o.discount_value,
         case when o.discount_type = 'percent'
              then round(v_primary.price * o.discount_value / 100.0)
              else least(o.discount_value, v_primary.price) end as amount
    into v_offer_id, v_offer_type, v_offer_value, v_discount
  from public.offers o
  join public.offer_branches ob on ob.offer_id = o.id and ob.branch_id = v_branch.id
  where o.status not in ('draft', 'disabled')
    and now() >= o.starts_at and now() < o.ends_at
    and (not exists (select 1 from public.offer_categories oc where oc.offer_id = o.id)
         or exists (select 1 from public.offer_categories oc where oc.offer_id = o.id and oc.category_id = v_primary.category_id))
  order by amount desc, o.id
  limit 1;
  v_discount := greatest(coalesce(v_discount, 0), 0);

  -- Serialize bookings per branch so two customers cannot take the last seat.
  perform pg_advisory_xact_lock(hashtext('carzone_slot:' || v_branch.id));
  perform public._assert_slot_bookable(v_branch, p_scheduled_at, v_duration);
  -- One booking per car at a time, at most 3 upcoming per customer.
  perform pg_advisory_xact_lock(hashtext('carzone_customer:' || v_cust.id));
  perform public._assert_customer_can_book(v_cust.id, v_vehicle.id, p_scheduled_at, v_duration);

  v_status := case when v_branch.auto_confirm then 'confirmed' else 'pending' end;

  insert into public.orders (
    number, source, customer_id, vehicle_id, plate, business_id, branch_id,
    offer_id, subtotal, discount_amount, discount_pct, discount_reason, total,
    duration_min, scheduled_at, status, payment_status
  ) values (
    public.next_order_number('app'), 'app', v_cust.id, v_vehicle.id, v_vehicle.plate,
    v_branch.business_id, v_branch.id,
    case when v_discount > 0 then v_offer_id end,
    v_subtotal,
    case when v_discount > 0 then v_discount end,
    case when v_discount > 0 and v_offer_type = 'percent' then v_offer_value end,
    case when v_discount > 0 then 'offer' end,
    v_subtotal - v_discount,
    v_duration, p_scheduled_at, v_status, 'pending'
  )
  returning * into v_order;

  insert into public.order_items (order_id, service_id, name, type, price, duration_min, position)
  select v_order.id, s.id, s.name, s.type, s.price, s.duration_min, s.pos
  from (
    select v_primary.id, v_primary.name, v_primary.type, v_primary.price, v_primary.duration_min, 0 as pos
    union all
    select t.id, t.name, t.type, t.price, t.duration_min, t.ordinality::int
    from unnest(v_addons) with ordinality as t
  ) as s(id, name, type, price, duration_min, pos);

  insert into public.order_events (order_id, status, actor_type, actor_id)
  values (v_order.id, 'pending', 'customer', v_cust.id);
  if v_status = 'confirmed' then
    insert into public.order_events (order_id, status, actor_type, actor_id)
    values (v_order.id, 'confirmed', 'system', 'auto_confirm');
  end if;

  return public._order_json(v_order.id);
end;
$function$;

-- ── 4. reschedule_order: a new time needs the wash's OK again (manual confirmation) ──
create or replace function public.reschedule_order(p_order_id text, p_scheduled_at timestamp with time zone)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_cust public.customers := public._booking_customer();
  v_order public.orders%rowtype;
  v_branch public.branches%rowtype;
  v_reconfirm boolean;
begin
  select * into v_order from public.orders where id = p_order_id and customer_id = v_cust.id for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status not in ('pending', 'confirmed') then
    raise exception 'order_not_reschedulable';
  end if;
  if v_order.scheduled_at = p_scheduled_at then
    return public._order_json(v_order.id);
  end if;

  select * into v_branch from public.branches where id = v_order.branch_id;
  perform pg_advisory_xact_lock(hashtext('carzone_slot:' || v_branch.id));
  perform public._assert_slot_bookable(v_branch, p_scheduled_at, v_order.duration_min, v_order.id);
  perform pg_advisory_xact_lock(hashtext('carzone_customer:' || v_cust.id));
  perform public._assert_customer_can_book(v_cust.id, v_order.vehicle_id, p_scheduled_at, v_order.duration_min, v_order.id);

  v_reconfirm := v_order.status = 'confirmed' and not v_branch.auto_confirm;

  update public.orders
  set scheduled_at = p_scheduled_at,
      status = case when v_reconfirm then 'pending'::public.order_status else status end,
      updated_at = now()
  where id = v_order.id;

  if v_reconfirm then
    insert into public.order_events (order_id, status, actor_type, actor_id)
    values (v_order.id, 'pending', 'customer', v_cust.id);
  end if;

  return public._order_json(v_order.id);
end;
$function$;

-- ── 5. Customer notifications that match what actually happened ──
create or replace function public.handle_order_status_notification()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_type text;
  v_title jsonb;
  v_body jsonb;
  v_when text;
  v_reason text;
begin
  if new.customer_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  -- A walk-in is standing at the wash: no "booking" notification for it.
  if tg_op = 'INSERT' and new.status not in ('pending', 'confirmed') then
    return new;
  end if;

  v_when := to_char(new.scheduled_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI');
  v_reason := nullif(trim(coalesce(new.cancel_reason, '')), '');

  if new.status = 'pending' then
    if tg_op = 'INSERT' then
      v_type := 'created';
      v_title := jsonb_build_object('ar', 'تم إرسال طلب الحجز', 'en', 'Booking request sent');
      v_body := jsonb_build_object('ar', 'طلبك رقم #' || new.number || ' وصل للمغسلة وبانتظار تأكيدها', 'en', 'Order #' || new.number || ' is waiting for the wash to confirm');
    else
      -- Types are limited to what the app knows (customer_notifications_type_check): a moved
      -- booking waiting for confirmation is a "created" one again.
      v_type := 'created';
      v_title := jsonb_build_object('ar', 'تم تغيير موعد الحجز', 'en', 'Booking rescheduled');
      v_body := jsonb_build_object('ar', 'الموعد الجديد لطلبك رقم #' || new.number || ' (' || v_when || ') بانتظار تأكيد المغسلة', 'en', 'The new time for order #' || new.number || ' (' || v_when || ') is waiting for the wash to confirm');
    end if;
  elsif new.status = 'confirmed' then
    v_type := 'confirmed';
    v_title := jsonb_build_object('ar', 'تم تأكيد الحجز', 'en', 'Booking confirmed');
    v_body := jsonb_build_object('ar', 'تم تأكيد حجزك رقم #' || new.number || ' — الموعد ' || v_when, 'en', 'Your booking #' || new.number || ' is confirmed for ' || v_when);
  elsif new.status = 'waiting' then
    v_type := 'waiting';
    v_title := jsonb_build_object('ar', 'تم تسجيل وصولك', 'en', 'Checked in');
    v_body := jsonb_build_object('ar', 'وصلت سيارتك للمغسلة وهي في الدور للطلب رقم #' || new.number, 'en', 'Your car is checked in and in the queue for order #' || new.number);
  elsif new.status = 'in_service' then
    v_type := 'in_service';
    v_title := jsonb_build_object('ar', 'بدأ غسيل سيارتك', 'en', 'Washing in progress');
    v_body := jsonb_build_object('ar', 'بدأ العمل على سيارتك للطلب رقم #' || new.number, 'en', 'Work on your car has started for order #' || new.number);
  elsif new.status = 'completed' then
    v_type := 'completed';
    v_title := jsonb_build_object('ar', 'سيارتك جاهزة', 'en', 'Your car is ready');
    v_body := jsonb_build_object('ar', 'خلصت الخدمة وسيارتك جاهزة للاستلام — الطلب رقم #' || new.number, 'en', 'Service done, your car is ready for pickup — order #' || new.number);
  elsif new.status = 'no_show' then
    v_type := 'cancelled'; -- the app has no "no_show" type; the booking is closed either way
    v_title := jsonb_build_object('ar', 'تم إغلاق الحجز لعدم الحضور', 'en', 'Booking closed: no show');
    v_body := jsonb_build_object('ar', 'تم إغلاق حجزك رقم #' || new.number || ' لأنك لم تحضر في الموعد', 'en', 'Booking #' || new.number || ' was closed because you did not arrive');
  elsif new.status = 'cancelled' then
    v_type := 'cancelled';
    v_title := jsonb_build_object('ar', 'تم إلغاء الحجز', 'en', 'Booking cancelled');
    v_body := case
      when new.cancelled_by_type = 'customer' then
        jsonb_build_object('ar', 'تم إلغاء حجزك رقم #' || new.number || ' بناءً على طلبك', 'en', 'Booking #' || new.number || ' was cancelled at your request')
      when new.cancelled_by_type = 'system' and v_reason = 'expired_unconfirmed' then
        jsonb_build_object('ar', 'تم إلغاء طلبك رقم #' || new.number || ' لأن المغسلة لم تؤكده قبل الموعد', 'en', 'Order #' || new.number || ' was cancelled because the wash did not confirm it in time')
      when new.cancelled_by_type = 'admin' then
        jsonb_build_object('ar', 'ألغت إدارة WashUp حجزك رقم #' || new.number || coalesce(': ' || v_reason, ''), 'en', 'WashUp cancelled booking #' || new.number || coalesce(': ' || v_reason, ''))
      else
        jsonb_build_object('ar', 'ألغت المغسلة حجزك رقم #' || new.number || coalesce(': ' || v_reason, ''), 'en', 'The wash cancelled booking #' || new.number || coalesce(': ' || v_reason, ''))
    end;
  else
    return new;
  end if;

  -- Timestamped id: a status can come back (reschedule → pending → confirmed again).
  insert into public.customer_notifications (id, customer_id, type, title, body, href, order_id, read, created_at)
  values ('cn_' || new.id || '_' || new.status || '_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
          new.customer_id, v_type, v_title, v_body, '/booking_details?id=' || new.id, new.id, false, clock_timestamp())
  on conflict (id) do nothing;

  return new;
end;
$function$;
revoke execute on function public.handle_order_status_notification() from public, anon, authenticated;
