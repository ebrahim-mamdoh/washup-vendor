-- Security hardening of the customer Data API (QA finding C2 + account takeover), 2026-10-21.
--
-- The customer app books, cancels and reschedules through SECURITY DEFINER RPCs (create_order,
-- cancel_order, reschedule_order) that price the order and enforce the state machine. The older
-- direct-write policies were still open, so a signed-in customer could insert or update orders,
-- order items and order events through the Data API with any price or status, and edit protected
-- columns of reviews, complaints and their own customer row. sync_customer_profile linked any
-- existing customer record to the caller by an unverified phone number (account takeover).
--
-- Rules after this migration (direct writes by the anon/authenticated roles only — the RPCs, the
-- partner portal and the Super Admin are not affected):
--   orders / order_items / order_events: read-only; writes go through the booking RPCs.
--   customer_notifications: read + mark as read only (they are created by triggers).
--   customers: name and locale only; status, phone and the auth link are server-managed.
--   reviews: a customer reviews his own completed order once; only stars/comment/tags editable.
--   complaints: opened by the customer as "open"; workflow columns are admin-only.
--   sync_customer_profile: links an existing record only to a verified phone sign-in.

-- ── Orders: booking RPCs only ───────────────────────────────
drop policy if exists "Customers can insert own orders" on public.orders;
drop policy if exists "Customers can update own orders" on public.orders;
drop policy if exists "Customers can insert own order items" on public.order_items;
drop policy if exists "Customers can insert own order events" on public.order_events;
revoke insert, update, delete on public.orders, public.order_items, public.order_events from anon, authenticated;

-- ── Customer notifications: created by triggers, customers only mark them read ──
drop policy if exists "Customers can insert own notifications" on public.customer_notifications;
revoke insert, update, delete on public.customer_notifications from anon, authenticated;
grant update (read) on public.customer_notifications to authenticated;

-- ── Guards for the direct writes that stay allowed ──────────
-- These run as the caller: current_user is 'authenticated'/'anon' only for Data API writes;
-- inside SECURITY DEFINER functions and on the server connection it is the owner, so they pass.

create or replace function public.guard_customer_row()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.status := 'active';
    new.status_reason := null;
  else
    new.id := old.id;
    new.user_id := old.user_id;
    new.phone := old.phone;
    new.status := old.status;
    new.status_reason := old.status_reason;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists customers_guard_client_writes on public.customers;
create trigger customers_guard_client_writes before insert or update on public.customers
  for each row execute function public.guard_customer_row();

create or replace function public.guard_customer_review()
returns trigger language plpgsql set search_path = public as $$
declare
  v_order public.orders%rowtype;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    select * into v_order from public.orders where id = new.order_id and customer_id = public.current_customer_id();
    if not found then raise exception 'review_order_not_found' using errcode = '42501'; end if;
    if v_order.status <> 'completed' then raise exception 'review_order_not_completed' using errcode = '42501'; end if;
    new.customer_id := v_order.customer_id;
    new.business_id := v_order.business_id;
    new.branch_id := v_order.branch_id;
    new.service_id := (select i.service_id from public.order_items i where i.order_id = v_order.id and i.type = 'primary' order by i.position limit 1);
    new.status := 'visible';
    new.hidden_reason := null;
    new.reply := null;
    new.reply_at := null;
    new.reported_by_wash := false;
    new.report_reason := null;
  else
    -- Customers edit their own words only; moderation, replies and links stay as they are.
    new.id := old.id;
    new.order_id := old.order_id;
    new.customer_id := old.customer_id;
    new.business_id := old.business_id;
    new.branch_id := old.branch_id;
    new.service_id := old.service_id;
    new.reply := old.reply;
    new.reply_at := old.reply_at;
    new.reported_by_wash := old.reported_by_wash;
    new.report_reason := old.report_reason;
    new.status := old.status;
    new.hidden_reason := old.hidden_reason;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists reviews_guard_client_writes on public.reviews;
create trigger reviews_guard_client_writes before insert or update on public.reviews
  for each row execute function public.guard_customer_review();

create or replace function public.guard_customer_complaint()
returns trigger language plpgsql set search_path = public as $$
declare
  v_order public.orders%rowtype;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  new.customer_id := public.current_customer_id();
  if new.order_id is not null then
    select * into v_order from public.orders where id = new.order_id and customer_id = new.customer_id;
    if not found then raise exception 'complaint_order_not_found' using errcode = '42501'; end if;
    new.business_id := v_order.business_id;
    new.branch_id := v_order.branch_id;
  end if;
  new.status := 'open';
  new.assigned_admin_id := null;
  new.resolution := null;
  new.ticket := public.next_complaint_ticket();
  return new;
end $$;

drop trigger if exists complaints_guard_client_writes on public.complaints;
create trigger complaints_guard_client_writes before insert on public.complaints
  for each row execute function public.guard_customer_complaint();

revoke all on function public.guard_customer_row(), public.guard_customer_review(), public.guard_customer_complaint() from public, anon, authenticated;

-- ── sync_customer_profile: no linking by an unverified phone ──
create or replace function public.sync_customer_profile(p_phone text, p_name text default null, p_locale text default 'ar')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_cust public.customers%rowtype;
  v_clean_phone text;
  v_verified text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  -- Normalize phone to E.164 (strip whitespace)
  v_clean_phone := regexp_replace(coalesce(p_phone, ''), '\s+', '', 'g');
  -- The phone this sign-in has proven (phone OTP), as digits; null for email/Google sign-ins.
  select nullif(regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'), '') into v_verified
  from auth.users u where u.id = v_uid and u.phone_confirmed_at is not null;

  -- 1. Already linked: update the profile.
  select * into v_cust from public.customers where user_id = v_uid limit 1;
  if found then
    update public.customers
    set name = case when p_name is not null and length(trim(p_name)) >= 2 then trim(p_name) else name end,
        locale = coalesce(p_locale, locale),
        last_active_at = now(),
        updated_at = now()
    where id = v_cust.id
    returning * into v_cust;
    return to_jsonb(v_cust);
  end if;

  -- 2. An existing record with this phone (seeded, or created by a wash for a walk-in) is linked only
  --    to the sign-in that verified that very phone; otherwise anyone could take it over.
  select * into v_cust from public.customers where phone = v_clean_phone limit 1;
  if found then
    if v_cust.user_id is not null then
      raise exception 'phone_in_use';
    end if;
    if v_verified is null or v_verified <> regexp_replace(v_clean_phone, '\D', '', 'g') then
      raise exception 'phone_verification_required';
    end if;
    update public.customers
    set user_id = v_uid,
        name = case when p_name is not null and length(trim(p_name)) >= 2 then trim(p_name) else name end,
        locale = coalesce(p_locale, locale),
        last_active_at = now(),
        updated_at = now()
    where id = v_cust.id
    returning * into v_cust;
    return to_jsonb(v_cust);
  end if;

  -- 3. New customer (a phone sign-in must use its own verified phone).
  if v_verified is not null and v_verified <> regexp_replace(v_clean_phone, '\D', '', 'g') then
    raise exception 'phone_mismatch';
  end if;
  if p_name is not null and length(trim(p_name)) >= 2 then
    insert into public.customers (id, user_id, name, phone, locale, status, last_active_at)
    values (public.gen_id('cu'), v_uid, trim(p_name), v_clean_phone, coalesce(p_locale, 'ar'), 'active', now())
    returning * into v_cust;
    return to_jsonb(v_cust);
  end if;

  return null;
end $$;

-- ── Function execute rights ─────────────────────────────────
-- Functions are executable by PUBLIC by default; keep only what the app calls.
revoke execute on function public.sync_customer_profile(text, text, text) from public, anon;
grant execute on function public.sync_customer_profile(text, text, text) to authenticated;
revoke execute on function public.handle_order_status_notification() from public, anon, authenticated;
revoke execute on function public.notify_customer_notification_push() from public, anon, authenticated;
revoke execute on function public.is_staff_or_admin() from public, anon;
grant execute on function public.is_staff_or_admin() to authenticated;
-- Used by the customer RLS policies (authenticated only); signed-out callers have no customer.
revoke execute on function public.current_customer_id() from public, anon;
grant execute on function public.current_customer_id() to authenticated;

-- ── Views run with the caller's rights (no RLS bypass) ──────
alter view public.app_health set (security_invoker = true);
alter view public.branch_shares set (security_invoker = true);
grant select, insert on public.legacy_branch_shares to anon, authenticated;

-- ── Legacy tables: no public write policies ────────────────
drop policy if exists "Public write areas" on public.legacy_areas;
drop policy if exists "Public write branches" on public.legacy_branches;
drop policy if exists "Public write complaints" on public.legacy_complaints;
drop policy if exists "Public write customers" on public.legacy_customers;
drop policy if exists "Public write favorites" on public.legacy_favorites;
drop policy if exists "Public write notifications" on public.legacy_notifications;
drop policy if exists "Public write offers" on public.legacy_offers;
drop policy if exists "Public write orders" on public.legacy_orders;
drop policy if exists "Public write reviews" on public.legacy_reviews;
drop policy if exists "Public write services" on public.legacy_services;
drop policy if exists "Public write vehicles" on public.legacy_vehicles;
