-- One review per order, and cancel reasons the customer app can show as sentences
-- (Arabic — English) instead of machine keys.

-- Keep the earliest review when an order was reviewed twice.
delete from public.reviews newer
using public.reviews older
where newer.order_id is not null
  and newer.order_id = older.order_id
  and (newer.created_at, newer.id) > (older.created_at, older.id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.reviews'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%(order_id)%'
  ) then
    alter table public.reviews add constraint reviews_order_id_key unique (order_id);
  end if;
end $$;

update public.orders
set cancel_reason = 'اتلغى تلقائيًا لأن المغسلة ما أكدتش في الوقت المحدد — Cancelled because the wash did not confirm before the appointment'
where cancel_reason = 'expired_unconfirmed';

update public.orders
set cancel_reason = 'أُغلق الطلب لأن الخدمة لم تبدأ بعد تسجيل الوصول — Closed because the service never started after check-in'
where cancel_reason = 'expired_not_started';

update public.orders
set cancel_reason = 'ألغاه العميل — Cancelled by the customer'
where cancel_reason = 'Cancelled by customer';

-- Older portal tests stored dotted keys (cancel.r1). The app shows this column as-is.
update public.orders
set cancel_reason = 'سبب الإلغاء اتسجل كرمز — Cancellation reason was stored as a code'
where cancel_reason ~ '^[A-Za-z0-9]+([._][A-Za-z0-9]+)+$';

create or replace function public.close_stale_orders()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id text;
  v_order public.orders%rowtype;
  v_closed integer := 0;
  v_unconfirmed text := 'اتلغى تلقائيًا لأن المغسلة ما أكدتش في الوقت المحدد — Cancelled because the wash did not confirm before the appointment';
  v_not_started text := 'أُغلق الطلب لأن الخدمة لم تبدأ بعد تسجيل الوصول — Closed because the service never started after check-in';
begin
  for v_order in
    select o.* from public.orders o
    where o.status = 'pending'
      and o.created_at < now() - interval '10 minutes'
      and o.scheduled_at > now()
      and not exists (
        select 1 from public.vendor_notifications n
        where n.href = '/orders/' || o.id and n.title ->> 'ar' like 'تذكير:%'
      )
  loop
    perform public.notify_wash(v_order.business_id, v_order.branch_id, 'new_booking',
      'تذكير: حجز بانتظار تأكيدك ' || v_order.number,
      coalesce((select name ->> 'ar' from public.branches where id = v_order.branch_id), '')
        || ' · ' || public.format_booking_time(v_order.scheduled_at)
        || ' · يُلغى تلقائيًا لو لم يُؤكَّد قبل الموعد',
      '/orders/' || v_order.id);
  end loop;

  for v_id in
    select id from public.orders
    where status = 'pending' and scheduled_at <= now()
    for update skip locked
  loop
    update public.orders
    set status = 'cancelled', cancel_reason = v_unconfirmed,
        cancelled_by_type = 'system', cancelled_by_id = 'auto_close',
        cancelled_at = now(), updated_at = now()
    where id = v_id;
    insert into public.order_events (order_id, status, actor_type, actor_id)
    values (v_id, 'cancelled', 'system', 'auto_close');
    v_closed := v_closed + 1;
  end loop;

  for v_id in
    select id from public.orders
    where status = 'confirmed'
      and scheduled_at + make_interval(mins => duration_min) < now() - interval '60 minutes'
    for update skip locked
  loop
    update public.orders set status = 'no_show', updated_at = now() where id = v_id;
    insert into public.order_events (order_id, status, actor_type, actor_id)
    values (v_id, 'no_show', 'system', 'auto_close');
    v_closed := v_closed + 1;
  end loop;

  for v_id in
    select id from public.orders
    where status = 'waiting'
      and scheduled_at + make_interval(mins => duration_min) < now() - interval '12 hours'
    for update skip locked
  loop
    update public.orders
    set status = 'cancelled', cancel_reason = v_not_started,
        cancelled_by_type = 'system', cancelled_by_id = 'auto_close',
        cancelled_at = now(), updated_at = now()
    where id = v_id;
    insert into public.order_events (order_id, status, actor_type, actor_id)
    values (v_id, 'cancelled', 'system', 'auto_close');
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$function$;

create or replace function public.cancel_order(p_order_id text, p_reason text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cust public.customers := public._booking_customer();
  v_order public.orders%rowtype;
  v_free_min int;
  v_late boolean;
begin
  select * into v_order from public.orders where id = p_order_id and customer_id = v_cust.id for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if v_order.status not in ('pending', 'confirmed') then
    raise exception 'order_not_cancellable';
  end if;

  select free_cancel_min into v_free_min from public.branches where id = v_order.branch_id;
  v_late := v_order.scheduled_at - now() < make_interval(mins => coalesce(v_free_min, 60));

  update public.orders
  set status = 'cancelled',
      cancel_reason = left(coalesce(nullif(trim(p_reason), ''), 'ألغاه العميل — Cancelled by the customer'), 500),
      cancelled_at = now(),
      cancelled_by_type = 'customer',
      cancelled_by_id = v_cust.id,
      updated_at = now()
  where id = v_order.id;

  insert into public.order_events (order_id, status, actor_type, actor_id)
  values (v_order.id, 'cancelled', 'customer', v_cust.id);

  return public._order_json(v_order.id) || jsonb_build_object('late_cancel', v_late);
end;
$function$;

create or replace function public.handle_order_status_notification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_type text;
  v_title jsonb;
  v_body jsonb;
  v_when_ar text;
  v_when_en text;
  v_reason text;
begin
  if new.customer_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status not in ('pending', 'confirmed') then
    return new;
  end if;

  v_when_ar := public.format_booking_time(new.scheduled_at, 'ar');
  v_when_en := public.format_booking_time(new.scheduled_at, 'en');
  v_reason := nullif(trim(coalesce(new.cancel_reason, '')), '');

  if new.status = 'pending' then
    if tg_op = 'INSERT' then
      v_type := 'created';
      v_title := jsonb_build_object('ar', 'تم إرسال طلب الحجز', 'en', 'Booking request sent');
      v_body := jsonb_build_object('ar', 'طلبك رقم #' || new.number || ' وصل للمغسلة وبانتظار تأكيدها', 'en', 'Order #' || new.number || ' is waiting for the wash to confirm');
    else
      v_type := 'created';
      v_title := jsonb_build_object('ar', 'تم تغيير موعد الحجز', 'en', 'Booking rescheduled');
      v_body := jsonb_build_object('ar', 'الموعد الجديد لطلبك رقم #' || new.number || ' (' || v_when_ar || ') بانتظار تأكيد المغسلة', 'en', 'The new time for order #' || new.number || ' (' || v_when_en || ') is waiting for the wash to confirm');
    end if;
  elsif new.status = 'confirmed' then
    v_type := 'confirmed';
    v_title := jsonb_build_object('ar', 'تم تأكيد الحجز', 'en', 'Booking confirmed');
    v_body := jsonb_build_object('ar', 'تم تأكيد حجزك رقم #' || new.number || ' — ' || v_when_ar, 'en', 'Your booking #' || new.number || ' is confirmed for ' || v_when_en);
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
    v_type := 'cancelled';
    v_title := jsonb_build_object('ar', 'تم إغلاق الحجز لعدم الحضور', 'en', 'Booking closed: no show');
    v_body := jsonb_build_object('ar', 'تم إغلاق حجزك رقم #' || new.number || ' لأنك لم تحضر في الموعد', 'en', 'Booking #' || new.number || ' was closed because you did not arrive');
  elsif new.status = 'cancelled' then
    v_type := 'cancelled';
    v_title := jsonb_build_object('ar', 'تم إلغاء الحجز', 'en', 'Booking cancelled');
    v_body := case
      when new.cancelled_by_type = 'customer' then
        jsonb_build_object('ar', 'تم إلغاء حجزك رقم #' || new.number || ' بناءً على طلبك', 'en', 'Booking #' || new.number || ' was cancelled at your request')
      when new.cancelled_by_type = 'system' and v_reason in (
        'expired_unconfirmed',
        'اتلغى تلقائيًا لأن المغسلة ما أكدتش في الوقت المحدد — Cancelled because the wash did not confirm before the appointment'
      ) then
        jsonb_build_object('ar', 'تم إلغاء طلبك رقم #' || new.number || ' لأن المغسلة لم تؤكده قبل الموعد', 'en', 'Order #' || new.number || ' was cancelled because the wash did not confirm it in time')
      when new.cancelled_by_type = 'system' and v_reason in (
        'expired_not_started',
        'أُغلق الطلب لأن الخدمة لم تبدأ بعد تسجيل الوصول — Closed because the service never started after check-in'
      ) then
        jsonb_build_object('ar', 'تم إغلاق طلبك رقم #' || new.number || ' لأن الخدمة لم تبدأ — تواصل مع المغسلة لو محتاج مساعدة', 'en', 'Order #' || new.number || ' was closed because the service never started. Contact the wash if you need help')
      when new.cancelled_by_type = 'admin' then
        jsonb_build_object('ar', 'ألغت إدارة Wash Up حجزك رقم #' || new.number || coalesce(': ' || v_reason, ''), 'en', 'Wash Up cancelled booking #' || new.number || coalesce(': ' || v_reason, ''))
      else
        jsonb_build_object('ar', 'ألغت المغسلة حجزك رقم #' || new.number || coalesce(': ' || v_reason, ''), 'en', 'The wash cancelled booking #' || new.number || coalesce(': ' || v_reason, ''))
    end;
  else
    return new;
  end if;

  insert into public.customer_notifications (id, customer_id, type, title, body, href, order_id, read, created_at)
  values ('cn_' || new.id || '_' || new.status || '_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
          new.customer_id, v_type, v_title, v_body, '/booking_details?id=' || new.id, new.id, false, clock_timestamp())
  on conflict (id) do nothing;

  return new;
end;
$function$;

create or replace function public.wash_order_notifications()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_branch text;
  v_when text;
  v_customer_reason text;
begin
  select name ->> 'ar' into v_branch from public.branches where id = new.branch_id;
  v_when := public.format_booking_time(new.scheduled_at, 'ar');
  if tg_op = 'INSERT' then
    if new.source = 'app' then
      perform public.notify_wash(new.business_id, new.branch_id, 'new_booking',
        'حجز جديد من التطبيق ' || new.number,
        coalesce(v_branch, '') || ' · ' || v_when || case when new.status = 'pending' then ' · بانتظار تأكيدك' else ' · تم تأكيده تلقائيًا' end,
        '/orders/' || new.id);
    end if;
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if new.cancelled_by_type = 'customer' then
      v_customer_reason := nullif(nullif(new.cancel_reason, 'Cancelled by customer'), 'ألغاه العميل — Cancelled by the customer');
      perform public.notify_wash(new.business_id, new.branch_id, 'booking_cancelled',
        'العميل ألغى الحجز ' || new.number,
        coalesce(v_branch, '') || ' · ' || v_when || coalesce(' · ' || v_customer_reason, ''),
        '/orders/' || new.id);
    elsif new.cancelled_by_type = 'system' and new.cancel_reason in (
      'expired_unconfirmed',
      'اتلغى تلقائيًا لأن المغسلة ما أكدتش في الوقت المحدد — Cancelled because the wash did not confirm before the appointment'
    ) then
      perform public.notify_wash(new.business_id, new.branch_id, 'booking_cancelled',
        'انتهى وقت تأكيد الحجز ' || new.number,
        coalesce(v_branch, '') || ' · ' || v_when || ' · ألغي تلقائيًا لأنه لم يؤكَّد قبل الموعد',
        '/orders/' || new.id);
    elsif new.cancelled_by_type = 'system' and new.cancel_reason in (
      'expired_not_started',
      'أُغلق الطلب لأن الخدمة لم تبدأ بعد تسجيل الوصول — Closed because the service never started after check-in'
    ) then
      perform public.notify_wash(new.business_id, new.branch_id, 'booking_cancelled',
        'أُغلق طلب لم يبدأ ' || new.number,
        coalesce(v_branch, '') || ' · ' || v_when || ' · السيارة سُجّل وصولها ولم تبدأ الخدمة خلال 12 ساعة',
        '/orders/' || new.id);
    end if;
  elsif new.source = 'app' and new.scheduled_at is distinct from old.scheduled_at and new.status in ('pending', 'confirmed') then
    perform public.notify_wash(new.business_id, new.branch_id, 'new_booking',
      'العميل غيّر موعد الحجز ' || new.number,
      coalesce(v_branch, '') || ' · الموعد الجديد ' || v_when || case when new.status = 'pending' then ' · بانتظار تأكيدك' else '' end,
      '/orders/' || new.id);
  end if;
  return new;
end $function$;
