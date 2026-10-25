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
--   reviews: a customer reviews his own completed order once; only stars/comment/tags editable
--            (so a review hidden by the Super Admin cannot be made visible again by its author).
--   complaints: opened by the customer as "open"; workflow columns are admin-only.
--
-- Applied 2026-10-25 after checking the customer app's traffic (Data API logs, 4 days): it writes
-- orders only through create_order/cancel_order/reschedule_order, and directly only to reviews,
-- vehicles, favorites, push devices, live-booking devices and notifications (mark as read).
-- Left out on purpose until the mobile developer moves sign-in to phone OTP:
--   - the sync_customer_profile change (customers sign in by e-mail today; requiring a verified
--     phone would block anyone whose number a wash already registered as a walk-in);
--   - security_invoker on the app_health / branch_shares views (the app may read them).

-- ── Orders: booking RPCs only ───────────────────────────────
drop policy if exists "Customers can insert own orders" on public.orders;
drop policy if exists "Customers can update own orders" on public.orders;
drop policy if exists "Customers can insert own order items" on public.order_items;
drop policy if exists "Customers can insert own order events" on public.order_events;
revoke insert, update, delete on public.orders, public.order_items, public.order_events from anon, authenticated;

-- ── Customer notifications: created by triggers, customers only mark them read ──
-- A guard trigger (not a column grant) so the app's "mark as read" keeps working whatever
-- columns its PATCH carries: everything but `read` is put back.
drop policy if exists "Customers can insert own notifications" on public.customer_notifications;
revoke insert, delete on public.customer_notifications from anon, authenticated;

create or replace function public.guard_customer_notification()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  new.id := old.id;
  new.customer_id := old.customer_id;
  new.type := old.type;
  new.title := old.title;
  new.body := old.body;
  new.href := old.href;
  new.order_id := old.order_id;
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists customer_notifications_guard_client_writes on public.customer_notifications;
create trigger customer_notifications_guard_client_writes before update on public.customer_notifications
  for each row execute function public.guard_customer_notification();
revoke all on function public.guard_customer_notification() from public, anon, authenticated;

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

-- ── Function execute rights ─────────────────────────────────
-- Functions are executable by PUBLIC by default; keep only what the app calls.
revoke execute on function public.handle_order_status_notification() from public, anon, authenticated;
revoke execute on function public.notify_customer_notification_push() from public, anon, authenticated;
revoke execute on function public.is_staff_or_admin() from public, anon;
grant execute on function public.is_staff_or_admin() to authenticated;
-- Used by the customer RLS policies (authenticated only); signed-out callers have no customer.
revoke execute on function public.current_customer_id() from public, anon;
grant execute on function public.current_customer_id() to authenticated;

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
