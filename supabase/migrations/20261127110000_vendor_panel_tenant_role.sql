-- APPLIED to tbcmgdwzarfdgzzmmele on 2026-11-26 (role + 81 policies on 36 tables; the {branches} subquery fixed with ::text[];
-- execute on is_localized(jsonb) granted afterwards, now part of this file). The .test.sql passed live (84 passed, 0 failed).
-- CARZEN_DB_TENANT_ROLE stays off until a Preview deploy with the flag on shows no [tenant] / 42501 errors.
--
-- GAP-027 (system audit): defence-in-depth tenant isolation for the vendor portal API.
--
-- Today the portal's server connects as `postgres` (BYPASSRLS), so tenant isolation exists only in
-- TypeScript (scopeBranches / assertBranch). This migration adds a database backstop:
--
--   * role `washup_vendor_panel` — NOLOGIN, NOBYPASSRLS, granted to `postgres` so the server can
--     `set local role washup_vendor_panel` inside a transaction without new credentials;
--   * exactly the table / column / sequence / function privileges the vendor `pg/*` code uses;
--   * RLS policies `TO washup_vendor_panel` (named vendor_panel_<table>_<cmd>) that read the request
--     context the server sets with set_config(…, true):
--       app.user_id      Supabase Auth user of the signed-in staff member ('' when none)
--       app.staff_id     staff id of the actor ('' when none)
--       app.business_id  the actor's business ('' = public context: unauthenticated routes)
--       app.branch_ids   comma list of the actor's branches (set for later use; policies scope by business)
--
-- The server uses the role only with CARZEN_DB_TENANT_ROLE=1 (default off), see
-- server/platform-api/pg/vendor/tenant.ts. Apply this first, run
-- 20261127110000_vendor_panel_tenant_role.test.sql, then enable the flag on a Preview deploy.
--
-- Scoping (business level — managers' branch limits stay in code):
--   business tables ............ business_id = app.business_id (businesses: id)
--   branch tables .............. branch_id in the business's branches
--   order children ............. through orders.business_id
--   staff ...................... business, or the signed-in user's own row (needed to resolve the actor)
--   customers / vehicles ....... readable + insertable platform-wide in a tenant context (walk-in
--                                recognition by phone / plate; the GAP-010 rules stay in code)
--   reference tables ........... readable
--   public onboarding .......... wash_applications / custom areas only in the public context
--   cross-tenant questions ..... SECURITY DEFINER helpers answering true/false only: is a staff
--                                phone taken anywhere; is an app account's phone confirmed
--                                (auth.users is not granted to the role)
--
-- Not changed: anon / authenticated grants and policies, the Super Admin (still `postgres`), triggers.
-- Idempotent: re-running recreates the helpers, grants and every vendor_panel_* policy.
-- The SQL editor will ask to confirm "destructive operations" (it contains `drop policy if exists`).

begin;
set local lock_timeout = '5s';

-- ── 0. Preconditions: every table the role touches exists and has RLS on ────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'businesses', 'business_settings', 'branches', 'branch_amenities', 'branch_working_hours',
    'branch_blocked_slots', 'services', 'offers', 'offer_branches', 'offer_categories', 'orders',
    'order_items', 'order_events', 'order_notes', 'payments', 'transactions', 'payouts', 'reviews',
    'staff', 'staff_shift_patterns', 'staff_shifts', 'day_closings', 'vendor_notifications',
    'audit_logs', 'push_devices', 'customers', 'vehicles', 'countries', 'areas', 'amenities',
    'service_categories', 'platform_settings', 'wash_applications', 'admin_notifications', 'admin_users'
  ] loop
    if to_regclass('public.' || t) is null then
      raise exception 'GAP-027: table public.% is missing', t;
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception 'GAP-027: RLS is off on public.% — the role would see every row', t;
    end if;
  end loop;
end $$;

-- ── 1. The role ─────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'washup_vendor_panel') then
    create role washup_vendor_panel nologin nobypassrls noinherit;
  end if;
  if exists (select 1 from pg_roles where rolname = 'washup_vendor_panel'
             and (rolsuper or rolbypassrls or rolcanlogin or rolcreaterole or rolcreatedb)) then
    raise exception 'GAP-027: washup_vendor_panel exists with unexpected attributes (super/bypassrls/login/createrole/createdb)';
  end if;
end $$;

grant washup_vendor_panel to postgres;

-- ── 2. Context helpers ──────────────────────────────────────────────────────────────────────────
create or replace function public.vendor_panel_business_id() returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('app.business_id', true), '')
$$;

create or replace function public.vendor_panel_user_id() returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('app.user_id', true), '')
$$;

create or replace function public.vendor_panel_staff_id() returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('app.staff_id', true), '')
$$;

-- Branch ids of the context business. SECURITY DEFINER: reads branches without RLS, so policies
-- that use it never recurse; used as `(select …)` so it runs once per statement.
create or replace function public.vendor_panel_business_branches() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(b.id::text), '{}'::text[])
  from public.branches b
  where b.business_id::text = public.vendor_panel_business_id()
$$;

-- Wash offer owned by the context business (offer_branches / offer_categories writes).
create or replace function public.vendor_panel_owns_offer(p_offer_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.offers o
    where o.id::text = p_offer_id and o.scope::text = 'wash'
      and o.business_id::text = public.vendor_panel_business_id())
$$;

-- "Add staff": a phone is unique across every business, but other businesses' staff are invisible
-- to the role. Answers true/false only.
create or replace function public.vendor_panel_staff_phone_taken(p_phone text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.phone = p_phone)
$$;

-- Walk-in recognition (recognize()): an app account is matched by phone only when Supabase Auth
-- confirmed that phone (GAP-010). The role gets no access to auth.users; this answers true/false.
create or replace function public.vendor_panel_app_phone_confirmed(p_user_id text, p_phone text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = nullif(p_user_id, '')::uuid and u.phone_confirmed_at is not null
      and '+' || ltrim(u.phone, '+') = p_phone)
$$;

revoke all on function public.vendor_panel_business_id(), public.vendor_panel_user_id(),
  public.vendor_panel_staff_id(), public.vendor_panel_business_branches(),
  public.vendor_panel_owns_offer(text), public.vendor_panel_staff_phone_taken(text),
  public.vendor_panel_app_phone_confirmed(text, text)
  from public, anon, authenticated;
grant execute on function public.vendor_panel_business_id(), public.vendor_panel_user_id(),
  public.vendor_panel_staff_id(), public.vendor_panel_business_branches(),
  public.vendor_panel_owns_offer(text), public.vendor_panel_staff_phone_taken(text),
  public.vendor_panel_app_phone_confirmed(text, text)
  to washup_vendor_panel;

-- ── 3. Privileges (start from nothing so a re-run is exact) ────────────────────────────────────
revoke all on all tables in schema public from washup_vendor_panel;
revoke all on all sequences in schema public from washup_vendor_panel;

grant usage on schema public to washup_vendor_panel;
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    grant usage on schema extensions to washup_vendor_panel;  -- extension functions in column defaults
  end if;
end $$;

-- Business & branches
grant select on public.businesses to washup_vendor_panel;
grant update (name) on public.businesses to washup_vendor_panel;
grant select, insert, update on public.business_settings to washup_vendor_panel;
grant select on public.branches to washup_vendor_panel;
grant update (name, address, phone, capacity, active, lat, lng, auto_confirm, slot_interval_min, lead_time_min,
              max_advance_days, free_cancel_min, no_show_grace_min, reminder_min) on public.branches to washup_vendor_panel;
grant select, insert, delete on public.branch_amenities, public.branch_working_hours, public.branch_blocked_slots
  to washup_vendor_panel;

-- Catalog
grant select, insert, update on public.services, public.offers to washup_vendor_panel;
grant select, insert, delete on public.offer_branches, public.offer_categories to washup_vendor_panel;

-- Orders & money
grant select, insert, update on public.orders to washup_vendor_panel;
grant select, insert on public.order_items, public.order_events, public.order_notes to washup_vendor_panel;
grant select, insert on public.payments to washup_vendor_panel;
grant update (status) on public.payments to washup_vendor_panel;
grant select, delete on public.transactions to washup_vendor_panel;  -- rows are written by trg_order_ledger
grant update (status) on public.transactions to washup_vendor_panel;
grant select on public.payouts to washup_vendor_panel;
grant select on public.reviews to washup_vendor_panel;
grant update (reply, reply_at, reported_by_wash, report_reason) on public.reviews to washup_vendor_panel;

-- Team
grant select, insert on public.staff to washup_vendor_panel;
grant update (name, role, branch_id, max_discount_pct, permissions, status, user_id) on public.staff to washup_vendor_panel;
grant select, insert, delete on public.staff_shift_patterns to washup_vendor_panel;
grant select, insert, update on public.staff_shifts to washup_vendor_panel;
grant select, insert on public.day_closings to washup_vendor_panel;

-- Notifications, audit, push devices
grant select, insert on public.vendor_notifications to washup_vendor_panel;
grant update (read) on public.vendor_notifications to washup_vendor_panel;
grant select, insert on public.audit_logs to washup_vendor_panel;
grant select, insert, update, delete on public.push_devices to washup_vendor_panel;
grant select (id) on public.admin_notifications to washup_vendor_panel;  -- insert … returning id
grant insert on public.admin_notifications to washup_vendor_panel;
grant select (id, name) on public.admin_users to washup_vendor_panel;   -- audit actor names

-- Customers (platform-wide recognition)
grant select, insert on public.customers to washup_vendor_panel;
grant update (last_active_at) on public.customers to washup_vendor_panel;
grant select, insert on public.vehicles to washup_vendor_panel;

-- Reference data & public onboarding
grant select on public.countries, public.amenities, public.service_categories, public.platform_settings
  to washup_vendor_panel;
grant select, insert on public.areas, public.wash_applications to washup_vendor_panel;

-- A GRANT on a table postgres does not own only WARNS; make sure every grant above took effect.
do $$
declare
  t text;
begin
  foreach t in array array[
    'businesses', 'business_settings', 'branches', 'branch_amenities', 'branch_working_hours',
    'branch_blocked_slots', 'services', 'offers', 'offer_branches', 'offer_categories', 'orders',
    'order_items', 'order_events', 'order_notes', 'payments', 'transactions', 'payouts', 'reviews',
    'staff', 'staff_shift_patterns', 'staff_shifts', 'day_closings', 'vendor_notifications',
    'audit_logs', 'push_devices', 'customers', 'vehicles', 'countries', 'areas', 'amenities',
    'service_categories', 'platform_settings', 'wash_applications', 'admin_notifications', 'admin_users'
  ] loop
    if not has_any_column_privilege('washup_vendor_panel', 'public.' || t, 'SELECT') then
      raise exception 'GAP-027: SELECT on public.% was not granted (table owner: %)', t,
        (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = ('public.' || t)::regclass);
    end if;
  end loop;
end $$;

-- Sequences: column defaults and next_order_number() (nextval only, no data).
grant usage on all sequences in schema public to washup_vendor_panel;

-- Functions the code calls (pg_advisory_xact_lock / hashtext are built-ins open to PUBLIC).
do $$
declare
  f text;
begin
  -- is_localized: used by CHECK constraints on the jsonb name / title / body columns (insert/update fail without it).
  foreach f in array array['public.next_order_number(public.order_source)', 'public.normalize_plate(text)',
                           'public.is_localized(jsonb)'] loop
    if to_regprocedure(f) is null then
      raise exception 'GAP-027: function % is missing', f;
    end if;
    execute format('grant execute on function %s to washup_vendor_panel', f);
  end loop;
  -- Column defaults / availability (the code falls back when get_branch_slots fails).
  foreach f in array array['public.gen_id(text)', 'public.gen_check_in_code()',
                           'public.get_branch_slots(text, date, integer, text, boolean)', 'public.branch_timezone(text)'] loop
    if to_regprocedure(f) is null then
      raise notice 'GAP-027: function % not found — not granted', f;
    else
      execute format('grant execute on function %s to washup_vendor_panel', f);
    end if;
  end loop;
end $$;

-- ── 4. Policies ─────────────────────────────────────────────────────────────────────────────────
-- Remove every earlier vendor_panel_* policy, then create the current set.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and policyname like 'vendor\_panel\_%'
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- pg_temp helper (gone at the end of the session). Tokens: {biz} business id, {branches} the
-- business's branch ids, {user} auth user id, {staff} staff id — all from the request context.
create or replace function pg_temp.vendor_panel_policy(p_table text, p_cmd text, p_using text, p_check text default null)
returns void language plpgsql as $$
declare
  expand constant text[][] := array[
    ['{biz}', '(select public.vendor_panel_business_id())'],
    ['{branches}', '((select public.vendor_panel_business_branches())::text[])'],
    ['{user}', '(select public.vendor_panel_user_id())'],
    ['{staff}', '(select public.vendor_panel_staff_id())']];
  pair text[];
  u text := p_using;
  c text := p_check;
begin
  foreach pair slice 1 in array expand loop
    u := replace(u, pair[1], pair[2]);
    c := replace(c, pair[1], pair[2]);
  end loop;
  execute format('create policy %I on public.%I as permissive for %s to washup_vendor_panel%s%s',
    format('vendor_panel_%s_%s', p_table, p_cmd), p_table, p_cmd,
    case when u is not null then format(' using (%s)', u) else '' end,
    case when c is not null then format(' with check (%s)', c) else '' end);
end $$;

-- Businesses & settings
select pg_temp.vendor_panel_policy('businesses', 'select', $p$id = {biz}$p$);
select pg_temp.vendor_panel_policy('businesses', 'update', $p$id = {biz}$p$, $p$id = {biz}$p$);
select pg_temp.vendor_panel_policy('business_settings', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('business_settings', 'insert', null, $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('business_settings', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz}$p$);

-- Branches and branch-level tables
select pg_temp.vendor_panel_policy('branches', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('branches', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy(t, cmd,
         case when cmd = 'insert' then null else $p$branch_id = any ({branches})$p$ end,
         case when cmd = 'insert' then $p$branch_id = any ({branches})$p$ end)
from unnest(array['branch_amenities', 'branch_working_hours', 'branch_blocked_slots']) t,
     unnest(array['select', 'insert', 'delete']) cmd;

select pg_temp.vendor_panel_policy('services', 'select', $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('services', 'insert', null, $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('services', 'update', $p$branch_id = any ({branches})$p$, $p$branch_id = any ({branches})$p$);

-- Offers: the wash's own offers, plus platform offers that target one of its branches (read only)
select pg_temp.vendor_panel_policy('offers', 'select',
  $p$business_id = {biz} or (scope::text = 'platform' and exists (
       select 1 from public.offer_branches ob where ob.offer_id = offers.id and ob.branch_id = any ({branches})))$p$);
select pg_temp.vendor_panel_policy('offers', 'insert', null, $p$business_id = {biz} and scope::text = 'wash'$p$);
select pg_temp.vendor_panel_policy('offers', 'update',
  $p$business_id = {biz} and scope::text = 'wash'$p$, $p$business_id = {biz} and scope::text = 'wash'$p$);
select pg_temp.vendor_panel_policy('offer_branches', 'select', $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('offer_branches', 'insert', null,
  $p$branch_id = any ({branches}) and public.vendor_panel_owns_offer(offer_id::text)$p$);
select pg_temp.vendor_panel_policy('offer_branches', 'delete', $p$public.vendor_panel_owns_offer(offer_id::text)$p$);
select pg_temp.vendor_panel_policy('offer_categories', 'select', $p${biz} is not null$p$);
select pg_temp.vendor_panel_policy('offer_categories', 'insert', null, $p$public.vendor_panel_owns_offer(offer_id::text)$p$);
select pg_temp.vendor_panel_policy('offer_categories', 'delete', $p$public.vendor_panel_owns_offer(offer_id::text)$p$);

-- Orders and their children
select pg_temp.vendor_panel_policy('orders', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('orders', 'insert', null, $p$business_id = {biz} and branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('orders', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz} and branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy(t, cmd,
         case when cmd = 'insert' then null
              else format($p$exists (select 1 from public.orders o where o.id = %I.order_id and o.business_id = {biz})$p$, t) end,
         case when cmd <> 'select'
              then format($p$exists (select 1 from public.orders o where o.id = %I.order_id and o.business_id = {biz})$p$, t) end)
from (values ('order_items', 'select'), ('order_items', 'insert'),
             ('order_events', 'select'), ('order_events', 'insert'),
             ('order_notes', 'select'), ('order_notes', 'insert'),
             ('payments', 'select'), ('payments', 'insert'), ('payments', 'update')) v(t, cmd);
select pg_temp.vendor_panel_policy('transactions', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('transactions', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('transactions', 'delete', $p$business_id = {biz} and status::text = 'pending'$p$);
select pg_temp.vendor_panel_policy('payouts', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('reviews', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('reviews', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz}$p$);

-- Team. The signed-in user's own staff row is readable before the business is known (sign-in).
select pg_temp.vendor_panel_policy('staff', 'select',
  $p$business_id = {biz} or user_id::text = {user} or id::text = {staff}$p$);
select pg_temp.vendor_panel_policy('staff', 'insert', null, $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('staff', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('staff_shift_patterns', cmd,
         case when cmd = 'insert' then null
              else $p$exists (select 1 from public.staff s where s.id = staff_shift_patterns.staff_id and s.business_id = {biz})$p$ end,
         case when cmd = 'insert'
              then $p$exists (select 1 from public.staff s where s.id = staff_shift_patterns.staff_id and s.business_id = {biz})$p$ end)
from unnest(array['select', 'insert', 'delete']) cmd;
select pg_temp.vendor_panel_policy('staff_shifts', 'select', $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('staff_shifts', 'insert', null, $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('staff_shifts', 'update', $p$branch_id = any ({branches})$p$, $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('day_closings', 'select', $p$branch_id = any ({branches})$p$);
select pg_temp.vendor_panel_policy('day_closings', 'insert', null, $p$branch_id = any ({branches})$p$);

-- Notifications, audit, push devices
select pg_temp.vendor_panel_policy('vendor_notifications', 'select', $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('vendor_notifications', 'insert', null, $p$business_id = {biz}$p$);
select pg_temp.vendor_panel_policy('vendor_notifications', 'update', $p$business_id = {biz}$p$, $p$business_id = {biz}$p$);
-- Same rows as the portal's audit page (pg/vendor/insights.ts auditBase), for the whole business.
select pg_temp.vendor_panel_policy('audit_logs', 'select',
  $p$branch_id = any ({branches})
     or entity_id = {biz}
     or exists (select 1 from public.orders o where o.id = audit_logs.entity_id and o.business_id = {biz})
     or (actor_type::text = 'staff'
         and exists (select 1 from public.staff s where s.id = audit_logs.actor_id and s.business_id = {biz}))$p$);
-- Entries are written only as the signed-in staff member.
select pg_temp.vendor_panel_policy('audit_logs', 'insert', null,
  $p${biz} is not null and actor_type::text = 'staff' and actor_id = {staff}$p$);
select pg_temp.vendor_panel_policy('push_devices', 'all', $p$user_id::text = {user}$p$, $p$user_id::text = {user}$p$);
select pg_temp.vendor_panel_policy('admin_notifications', 'select', 'true');  -- column grant: id only
select pg_temp.vendor_panel_policy('admin_notifications', 'insert', null, 'true');
select pg_temp.vendor_panel_policy('admin_users', 'select', 'true');          -- column grant: id, name

-- Customers & vehicles: platform-wide in a tenant context (recognition), never in the public one
select pg_temp.vendor_panel_policy('customers', 'select', $p${biz} is not null$p$);
select pg_temp.vendor_panel_policy('customers', 'insert', null, $p${biz} is not null$p$);
select pg_temp.vendor_panel_policy('customers', 'update', $p${biz} is not null$p$, $p${biz} is not null$p$);  -- last_active_at only
select pg_temp.vendor_panel_policy('vehicles', 'select', $p${biz} is not null$p$);
select pg_temp.vendor_panel_policy('vehicles', 'insert', null, $p${biz} is not null$p$);

-- Reference data
select pg_temp.vendor_panel_policy(t, 'select', 'true')
from unnest(array['countries', 'areas', 'amenities', 'service_categories', 'platform_settings']) t;

-- Public onboarding (register / application status pages): only in the public context
select pg_temp.vendor_panel_policy('areas', 'insert', null, $p${biz} is null and active = false$p$);
select pg_temp.vendor_panel_policy('wash_applications', 'select', $p${biz} is null$p$);
select pg_temp.vendor_panel_policy('wash_applications', 'insert', null, $p${biz} is null and status::text = 'pending'$p$);

-- GAP-095 read receipts (table from 20261126110000; skipped if absent — the code then uses vendor_notifications.read)
do $$
begin
  if to_regclass('public.vendor_notification_reads') is null then
    raise notice 'GAP-027: public.vendor_notification_reads not found — skipped';
    return;
  end if;
  grant select, insert on public.vendor_notification_reads to washup_vendor_panel;
  perform pg_temp.vendor_panel_policy(t, cmd,
    case when cmd = 'insert' then null else e end,
    case when cmd = 'insert' then e end)
  from unnest(array['select', 'insert']) cmd,
       (select 'vendor_notification_reads'::text as t,
               $p$staff_id::text = {staff} and exists (select 1 from public.vendor_notifications vn
                  where vn.id = vendor_notification_reads.notification_id and vn.business_id = {biz})$p$::text as e) x;
end $$;

commit;
