-- RUN on tbcmgdwzarfdgzzmmele on 2026-11-26 after the migration: 84 passed, 0 failed (rolled back). Re-run after any change to the policies or the vendor code's tables.
--
-- GAP-027 verification of the vendor tenant role. Run the whole file in the Supabase SQL editor (as
-- postgres). Nothing persists: everything runs in one transaction, the DO block ALWAYS ends with an
-- exception, and the file ends with ROLLBACK. Read the error message:
--
--   VENDOR PANEL TEST: N passed, 0 failed — all good …        → OK to enable the flag on a Preview
--   VENDOR PANEL TEST: N passed, K failed - <check>: <why> …   → do not enable; send the list
--
-- It picks real ids by query: business A = the business with the most orders (with active staff and
-- an active primary service), business B = another business with a branch. Ids are printed as
-- NOTICEs; no phone numbers or names are printed. Test rows use "VP test" / random +2015… numbers.
-- Side effect that a rollback cannot undo: one walk-in order number (next_order_number) is consumed.
--
-- What it checks, acting as washup_vendor_panel with business A's context (owner, all branches):
--   1. role hygiene: NOLOGIN, NOBYPASSRLS, postgres is a member, no permissive policy for PUBLIC on
--      the tables the role uses, auth.users not readable;
--   2. visibility: per table the role sees exactly business A's rows (orders, order_items,
--      order_events, order_notes, payments, services, staff, branches, transactions, payouts,
--      vendor_notifications, reviews, business_settings, offers, shifts, closings, slots, hours) and
--      none of B's; customers / vehicles / reference data platform-wide;
--   3. writes: updates hit A's rows (1 row) and never B's (0 rows); inserts into B, moving A's rows
--      to B, and protected columns (commission, review status, business status…) are refused (42501);
--   4. the walk-in flow as the code runs it: recognition (phone helper), slots, advisory lock,
--      customer + vehicle + order (next_order_number) + item + event + note + audit, ledger row from
--      the trigger, start → complete → collect payment, notification + read receipt, admin
--      notification, block / unblock a slot, add staff + shift pattern, settings upsert, review reply;
--   5. the public context (no business): no tenant rows, reference data visible, registration
--      inserts (custom area, wash application, admin notification) allowed, customers / orders refused.

begin;

do $test$
declare
  a_biz text; b_biz text;
  a_branches text[];
  a_branch text; a_service text; a_category text;
  a_staff text; a_user text; a_order text; a_review text; a_customer_phone text;
  b_branch text; b_service text; b_staff text; b_staff_phone text; b_order text;
  any_customer text;
  touched constant text[] := array[
    'businesses', 'business_settings', 'branches', 'branch_amenities', 'branch_working_hours',
    'branch_blocked_slots', 'services', 'offers', 'offer_branches', 'offer_categories', 'orders',
    'order_items', 'order_events', 'order_notes', 'payments', 'transactions', 'payouts', 'reviews',
    'staff', 'staff_shift_patterns', 'staff_shifts', 'day_closings', 'vendor_notifications',
    'vendor_notification_reads', 'audit_logs', 'push_devices', 'customers', 'vehicles', 'countries',
    'areas', 'amenities', 'service_categories', 'platform_settings', 'wash_applications',
    'admin_notifications', 'admin_users'];
  passes int := 0;
  fails text[] := '{}';
  chk text[];
  expected bigint;
  actual bigint;
  rc bigint;
  step text;
  n bigint;
  new_customer text; new_vehicle text; new_order text; new_staff text; new_notif text; new_slot text; new_id text;
  rnd text;
begin
  -- ── Pick the two businesses and their rows (as postgres) ─────────────────────────────────────
  select b.id::text into a_biz from public.businesses b
  where exists (select 1 from public.orders o where o.business_id = b.id)
    and exists (select 1 from public.staff s where s.business_id = b.id and s.status::text = 'active')
    and exists (select 1 from public.services sv join public.branches br on br.id = sv.branch_id
                where br.business_id = b.id and sv.type::text = 'primary' and sv.active)
  order by (select count(*) from public.orders o where o.business_id = b.id) desc, b.id
  limit 1;
  if a_biz is null then
    raise exception 'VENDOR PANEL TEST: no business with orders, active staff and an active primary service';
  end if;
  select b.id::text into b_biz from public.businesses b
  where b.id::text <> a_biz and exists (select 1 from public.branches br where br.business_id = b.id)
  order by exists (select 1 from public.orders o where o.business_id = b.id) desc,
           (select count(*) from public.orders o where o.business_id = b.id) desc, b.id
  limit 1;
  if b_biz is null then
    raise exception 'VENDOR PANEL TEST: needs a second business with at least one branch';
  end if;

  select array_agg(br.id::text order by br.id) into a_branches from public.branches br where br.business_id::text = a_biz;
  select sv.id::text, sv.branch_id::text, sv.category_id::text into a_service, a_branch, a_category
  from public.services sv join public.branches br on br.id = sv.branch_id
  where br.business_id::text = a_biz and sv.type::text = 'primary' and sv.active
  order by br.active desc, sv.id limit 1;
  select s.id::text, s.user_id::text into a_staff, a_user from public.staff s
  where s.business_id::text = a_biz and s.status::text = 'active'
  order by (s.role::text = 'owner') desc, (s.user_id is not null) desc, s.id limit 1;
  select o.id::text into a_order from public.orders o where o.business_id::text = a_biz order by o.created_at desc, o.id limit 1;
  select c.phone into a_customer_phone from public.orders o join public.customers c on c.id = o.customer_id
  where o.business_id::text = a_biz and c.phone is not null order by o.created_at desc limit 1;
  select r.id::text into a_review from public.reviews r where r.business_id::text = a_biz order by r.id limit 1;

  select br.id::text into b_branch from public.branches br where br.business_id::text = b_biz order by br.id limit 1;
  select sv.id::text into b_service from public.services sv join public.branches br on br.id = sv.branch_id
  where br.business_id::text = b_biz order by sv.id limit 1;
  select s.id::text, s.phone into b_staff, b_staff_phone from public.staff s where s.business_id::text = b_biz order by s.id limit 1;
  select o.id::text into b_order from public.orders o where o.business_id::text = b_biz order by o.created_at desc, o.id limit 1;
  select c.id::text into any_customer from public.customers c order by c.id limit 1;

  raise notice 'VENDOR PANEL TEST: A = % (branch %, staff %, order %), B = % (branch %, staff %, order %)',
    a_biz, a_branch, a_staff, a_order, b_biz, b_branch, b_staff, b_order;

  -- ── 1. Role hygiene (as postgres) ────────────────────────────────────────────────────────────
  if exists (select 1 from pg_roles where rolname = 'washup_vendor_panel' and not rolbypassrls and not rolcanlogin and not rolsuper) then
    passes := passes + 1;
  else
    fails := fails || 'role: washup_vendor_panel missing or has BYPASSRLS / LOGIN / SUPERUSER'::text;
  end if;
  if pg_has_role('postgres', 'washup_vendor_panel', 'MEMBER') then
    passes := passes + 1;
  else
    fails := fails || 'role: postgres is not a member of washup_vendor_panel'::text;
  end if;
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = any (touched) and permissive = 'PERMISSIVE' and roles @> array['public']::name[];
  if n = 0 then
    passes := passes + 1;
  else
    fails := fails || format('policies: %s permissive policies apply to PUBLIC on tables the role uses (they also apply to the role): %s', n,
      (select string_agg(tablename || '.' || policyname, ', ') from pg_policies
       where schemaname = 'public' and tablename = any (touched) and permissive = 'PERMISSIVE' and roles @> array['public']::name[]));
  end if;

  -- ── Business A's context ─────────────────────────────────────────────────────────────────────
  perform set_config('app.user_id', coalesce(a_user, ''), true);
  perform set_config('app.staff_id', a_staff, true);
  perform set_config('app.business_id', a_biz, true);
  perform set_config('app.branch_ids', array_to_string(a_branches, ','), true);

  -- ── 2. Visibility: [check, expected (computed as postgres), actual (as the role)] ─────────────
  foreach chk slice 1 in array array[
    ['orders', format('select count(*) from public.orders where business_id::text = %L', a_biz), 'select count(*) from public.orders'],
    ['order_items', format('select count(*) from public.order_items i join public.orders o on o.id = i.order_id where o.business_id::text = %L', a_biz), 'select count(*) from public.order_items'],
    ['order_events', format('select count(*) from public.order_events i join public.orders o on o.id = i.order_id where o.business_id::text = %L', a_biz), 'select count(*) from public.order_events'],
    ['order_notes', format('select count(*) from public.order_notes i join public.orders o on o.id = i.order_id where o.business_id::text = %L', a_biz), 'select count(*) from public.order_notes'],
    ['payments', format('select count(*) from public.payments i join public.orders o on o.id = i.order_id where o.business_id::text = %L', a_biz), 'select count(*) from public.payments'],
    ['services', format('select count(*) from public.services s join public.branches b on b.id = s.branch_id where b.business_id::text = %L', a_biz), 'select count(*) from public.services'],
    ['staff', format('select count(*) from public.staff where business_id::text = %L', a_biz), 'select count(*) from public.staff'],
    ['branches', format('select count(*) from public.branches where business_id::text = %L', a_biz), 'select count(*) from public.branches'],
    ['businesses', 'select 1::bigint', 'select count(*) from public.businesses'],
    ['business_settings', format('select count(*) from public.business_settings where business_id::text = %L', a_biz), 'select count(*) from public.business_settings'],
    ['transactions', format('select count(*) from public.transactions where business_id::text = %L', a_biz), 'select count(*) from public.transactions'],
    ['payouts', format('select count(*) from public.payouts where business_id::text = %L', a_biz), 'select count(*) from public.payouts'],
    ['vendor_notifications', format('select count(*) from public.vendor_notifications where business_id::text = %L', a_biz), 'select count(*) from public.vendor_notifications'],
    ['reviews', format('select count(*) from public.reviews where business_id::text = %L', a_biz), 'select count(*) from public.reviews'],
    ['offers (own + platform offers on own branches)',
      format('select count(*) from public.offers f where f.business_id::text = %1$L or (f.scope::text = %2$L and exists (select 1 from public.offer_branches ob join public.branches b on b.id = ob.branch_id where ob.offer_id = f.id and b.business_id::text = %1$L))', a_biz, 'platform'),
      'select count(*) from public.offers'],
    ['staff_shifts', format('select count(*) from public.staff_shifts where branch_id::text = any (%L::text[])', a_branches), 'select count(*) from public.staff_shifts'],
    ['day_closings', format('select count(*) from public.day_closings where branch_id::text = any (%L::text[])', a_branches), 'select count(*) from public.day_closings'],
    ['branch_blocked_slots', format('select count(*) from public.branch_blocked_slots where branch_id::text = any (%L::text[])', a_branches), 'select count(*) from public.branch_blocked_slots'],
    ['branch_working_hours', format('select count(*) from public.branch_working_hours where branch_id::text = any (%L::text[])', a_branches), 'select count(*) from public.branch_working_hours'],
    ['orders of B by id', 'select 0::bigint', format('select count(*) from public.orders where id::text = %L', b_order)],
    ['staff of B by id', 'select 0::bigint', format('select count(*) from public.staff where id::text = %L', b_staff)],
    ['customers (platform-wide)', 'select count(*) from public.customers', 'select count(*) from public.customers'],
    ['vehicles (platform-wide)', 'select count(*) from public.vehicles', 'select count(*) from public.vehicles'],
    ['countries', 'select count(*) from public.countries', 'select count(*) from public.countries'],
    ['service_categories', 'select count(*) from public.service_categories', 'select count(*) from public.service_categories'],
    ['admin_users (id, name only)', 'select count(*) from public.admin_users', 'select count(*) from (select id, name from public.admin_users) x'],
    ['wash_applications hidden in a tenant context', 'select 0::bigint', 'select count(*) from public.wash_applications']
  ] loop
    execute 'reset role';
    begin
      execute chk[2] into expected;
      execute 'set local role washup_vendor_panel';
      execute chk[3] into actual;
      if actual = expected then
        passes := passes + 1;
      else
        fails := fails || format('visibility %s: role sees %s rows, expected %s', chk[1], actual, expected);
      end if;
    exception when others then
      fails := fails || format('visibility %s: %s %s', chk[1], sqlstate, sqlerrm);
    end;
  end loop;

  execute 'set local role washup_vendor_panel';

  -- ── 3a. Writes that must touch exactly N rows: [check, statement, N] ────────────────────────────
  foreach chk slice 1 in array array[
    ['update own order', format('update public.orders set assigned_staff_id = assigned_staff_id where id::text = %L', a_order), '1'],
    ['update B order', format('update public.orders set assigned_staff_id = assigned_staff_id where id::text = %L', b_order), '0'],
    ['update own service', format('update public.services set active = active where id::text = %L', a_service), '1'],
    ['update B service', format('update public.services set active = active where id::text = %L', b_service), '0'],
    ['update own staff', format('update public.staff set status = status where id::text = %L', a_staff), '1'],
    ['update B staff', format('update public.staff set status = status where id::text = %L', b_staff), '0'],
    ['update own branch', format('update public.branches set capacity = capacity where id::text = %L', a_branch), '1'],
    ['update B branch', format('update public.branches set capacity = capacity where id::text = %L', b_branch), '0'],
    ['update own business name', format('update public.businesses set name = name where id::text = %L', a_biz), '1'],
    ['update B business name', format('update public.businesses set name = name where id::text = %L', b_biz), '0'],
    ['update B ledger rows', format('update public.transactions set status = status where business_id::text = %L', b_biz), '0'],
    ['delete B pending ledger rows', format('delete from public.transactions where business_id::text = %L and status::text = %L', b_biz, 'pending'), '0'],
    ['update B notifications', format('update public.vendor_notifications set read = read where business_id::text = %L', b_biz), '0'],
    ['update B reviews', format('update public.reviews set reply = reply where business_id::text = %L', b_biz), '0'],
    ['delete B blocked slots', format('delete from public.branch_blocked_slots where branch_id::text = %L', b_branch), '0'],
    ['delete B staff patterns', format('delete from public.staff_shift_patterns where staff_id::text = %L', b_staff), '0'],
    ['touch any customer (last_active_at)', format('update public.customers set last_active_at = last_active_at where id::text = %L', any_customer),
      case when any_customer is null then '0' else '1' end]
  ] loop
    begin
      execute chk[2];
      get diagnostics rc = row_count;
      if rc = chk[3]::bigint then
        passes := passes + 1;
      else
        fails := fails || format('write %s: %s rows, expected %s', chk[1], rc, chk[3]);
      end if;
    exception when others then
      fails := fails || format('write %s: %s %s', chk[1], sqlstate, sqlerrm);
    end;
  end loop;

  -- ── 3b. Statements that must be refused with 42501 (privilege or RLS) ──────────────────────────
  foreach chk slice 1 in array array[
    ['insert an order into B', format($s$insert into public.orders (source, business_id, branch_id, plate, subtotal, total, duration_min, scheduled_at, status, payment_status)
       values ('walk_in', %L, %L, 'VPTEST', 0, 0, 30, now(), 'waiting', 'pending')$s$, b_biz, b_branch)],
    ['move own order to B', format('update public.orders set business_id = %L where id::text = %L', b_biz, a_order)],
    ['move own order to a B branch', format('update public.orders set branch_id = %L where id::text = %L', b_branch, a_order)],
    ['order item on a B order', format($s$insert into public.order_items (order_id, service_id, name, type, price, duration_min, position)
       values (%L, null, '{"ar": "VP test", "en": "VP test"}', 'addon', 0, 0, 99)$s$, b_order)],
    ['order event on a B order', format($s$insert into public.order_events (order_id, status, actor_type, actor_id) values (%L, 'waiting', 'staff', %L)$s$, b_order, a_staff)],
    ['order note on a B order', format($s$insert into public.order_notes (order_id, author_staff_id, text) values (%L, %L, 'VP test')$s$, b_order, a_staff)],
    ['service in a B branch', format($s$insert into public.services (branch_id, type, category_id, name, description, price, duration_min, active)
       values (%L, 'primary', %L, '{"ar": "VP test", "en": "VP test"}', '{"ar": "", "en": ""}', 10, 10, false)$s$, b_branch, a_category)],
    ['move own service to a B branch', format('update public.services set branch_id = %L where id::text = %L', b_branch, a_service)],
    ['staff in B', format($s$insert into public.staff (business_id, branch_id, name, phone, role, status, max_discount_pct, permissions)
       values (%L, %L, 'VP test', '+201599999990', 'employee', 'active', 0, '{"confirmBooking": true, "cancelOrder": false, "closeShift": false, "editServices": false, "refund": false, "collectPayment": true, "runService": true, "manageStaff": false}')$s$, b_biz, b_branch)],
    ['move own staff to B (column not granted)', format('update public.staff set business_id = %L where id::text = %L', b_biz, a_staff)],
    ['notification for B', format($s$insert into public.vendor_notifications (business_id, branch_id, type, title, body, href)
       values (%L, null, 'platform', '{"ar": "VP test", "en": "VP test"}', '{"ar": "VP test", "en": "VP test"}', '/')$s$, b_biz)],
    ['blocked slot in a B branch', format($s$insert into public.branch_blocked_slots (branch_id, starts_at, ends_at, reason, created_by)
       values (%L, now() + interval '40 days', now() + interval '40 days 1 hour', 'VP test', %L)$s$, b_branch, a_staff)],
    ['offer for B', format($s$insert into public.offers (scope, business_id, title, description, discount_type, discount_value, starts_at, ends_at, status, featured)
       values ('wash', %L, '{"ar": "VP test", "en": "VP test"}', '{"ar": "", "en": ""}', 'percent', 10, now(), now() + interval '1 day', 'draft', false)$s$, b_biz)],
    ['write a ledger row (no INSERT grant)', format('insert into public.transactions (order_id, business_id) values (%L, %L)', a_order, a_biz)],
    ['change own commission (column not granted)', format('update public.transactions set commission = commission where business_id::text = %L', a_biz)],
    ['change own commission rate (column not granted)', format('update public.businesses set commission_rate = commission_rate where id::text = %L', a_biz)],
    ['change own business status (column not granted)', format('update public.businesses set status = status where id::text = %L', a_biz)],
    ['moderate own reviews (column not granted)', format('update public.reviews set status = status where business_id::text = %L', a_biz)],
    ['feature own branch (column not granted)', format('update public.branches set featured = featured where id::text = %L', a_branch)],
    ['update payouts (no grant)', format('update public.payouts set status = status where business_id::text = %L', a_biz)],
    ['audit entry as a B staff member', format($s$insert into public.audit_logs (actor_type, actor_id, action, entity, entity_id, at)
       values ('staff', %L, 'vp.test', 'orders', %L, now())$s$, b_staff, a_order)],
    ['wash application in a tenant context', $s$insert into public.wash_applications (id, business_name, owner_name, phone, status, submitted_at)
       values ('app_vptest_tenant', 'VP test', 'VP test', '+201599999991', 'pending', now())$s$],
    ['custom area in a tenant context', $s$insert into public.areas (id, name, country_code, lat, lng, active, sort_order)
       values ('area_vptest_tenant', '{"ar": "VP test", "en": "VP test"}', 'EG', 30, 31, false, 99)$s$],
    ['push device of another user', $s$insert into public.push_devices (user_id, app, platform, token) values (gen_random_uuid(), 'partner', 'web', 'vptest-token-another-user-000000')$s$],
    ['read auth.users', 'select count(*) from auth.users'],
    ['generate settlements', 'select public.generate_settlements(current_date, current_date)']
  ] loop
    begin
      execute chk[2];
      fails := fails || format('refuse %s: was allowed', chk[1]);
    exception
      when insufficient_privilege then passes := passes + 1;
      when others then fails := fails || format('refuse %s: expected 42501, got %s %s', chk[1], sqlstate, sqlerrm);
    end;
  end loop;

  -- ── 4. The walk-in flow and other writes of business A, as the code runs them ───────────────────
  begin
    rnd := lpad(floor(random() * 100000000)::bigint::text, 8, '0');

    step := 'recognition by phone (vendor_panel_app_phone_confirmed)';
    perform 1 from public.customers cu
    where cu.phone = coalesce(a_customer_phone, '+200000000000')
      and (cu.user_id is null
           or exists (select 1 from public.orders o where o.customer_id = cu.id and o.business_id::text = a_biz)
           or public.vendor_panel_app_phone_confirmed(cu.user_id::text, cu.phone));
    step := 'plate search (normalize_plate)';
    perform public.normalize_plate('ABC 123');
    step := 'slots (get_branch_slots)';
    perform count(*) from public.get_branch_slots(a_branch, current_date + 1, 30, null, true);
    step := 'staff phone helper sees B staff';
    if b_staff_phone is not null and not public.vendor_panel_staff_phone_taken(b_staff_phone) then
      raise exception 'vendor_panel_staff_phone_taken returned false for an existing phone';
    end if;
    step := 'advisory lock';
    perform pg_advisory_xact_lock(hashtext('washup_slot:' || a_branch));

    step := 'insert customer';
    insert into public.customers (name, phone, status) values ('VP test', '+2015' || rnd, 'active') returning id::text into new_customer;
    step := 'insert vehicle';
    insert into public.vehicles (customer_id, make, model, year, color, plate, is_default)
    values (new_customer, 'VP', 'Test', null, 'silver', 'VPT' || right(rnd, 4), true) returning id::text into new_vehicle;
    step := 'insert order (next_order_number)';
    -- VALUES (not INSERT … SELECT) so the enum literals take the column types, as in the code.
    insert into public.orders (number, source, customer_id, vehicle_id, plate, business_id, branch_id, offer_id, subtotal,
      discount_amount, discount_pct, discount_reason, total, duration_min, scheduled_at, status, payment_status)
    values (public.next_order_number('walk_in'::public.order_source), 'walk_in', new_customer, new_vehicle, 'VPT' || right(rnd, 4),
      a_biz, a_branch, null, (select sv.price from public.services sv where sv.id::text = a_service), null, null, null,
      (select sv.price from public.services sv where sv.id::text = a_service),
      (select sv.duration_min from public.services sv where sv.id::text = a_service), now(), 'waiting', 'pending')
    returning id::text into new_order;
    step := 'insert order item';
    insert into public.order_items (order_id, service_id, name, type, price, duration_min, position)
    values (new_order, a_service, (select sv.name from public.services sv where sv.id::text = a_service), 'primary',
      (select sv.price from public.services sv where sv.id::text = a_service),
      (select sv.duration_min from public.services sv where sv.id::text = a_service), 0);
    step := 'insert order event';
    insert into public.order_events (order_id, status, actor_type, actor_id) values (new_order, 'waiting', 'staff', a_staff);
    step := 'insert order note';
    insert into public.order_notes (order_id, author_staff_id, text) values (new_order, a_staff, 'VP test');
    step := 'customer last_active_at';
    update public.customers set last_active_at = now() where id::text = new_customer;
    get diagnostics rc = row_count;
    if rc <> 1 then raise exception 'customer update touched % rows', rc; end if;
    step := 'audit entry (actor name from admin_users / staff)';
    insert into public.audit_logs (actor_type, actor_id, actor_name, action, entity, entity_id, branch_id, old_value, new_value, reason, at)
    values ('staff', a_staff,
            coalesce((select name from public.admin_users where id::text = a_staff), (select name from public.staff where id::text = a_staff)),
            'order.create', 'orders', new_order, (select id from public.branches where id::text = a_branch), null, 'VP test', null, clock_timestamp());
    step := 'audit entry visible';
    perform 1 from public.audit_logs where entity_id = new_order;
    if not found then raise exception 'own audit entry not visible'; end if;
    step := 'ledger row written by trg_order_ledger is visible';
    perform 1 from public.transactions where order_id::text = new_order;
    if not found then raise exception 'no ledger row visible for the new order'; end if;
    step := 'lock the order (select … for update)';
    perform 1 from public.orders where id::text = new_order for update;
    step := 'start service';
    update public.orders set status = 'in_service', assigned_staff_id = a_staff
    where id::text = new_order and status = 'waiting' and closed_in_day_id is null;
    get diagnostics rc = row_count;
    if rc <> 1 then raise exception 'start touched % rows', rc; end if;
    step := 'complete';
    update public.orders set status = 'completed' where id::text = new_order and status = 'in_service' and closed_in_day_id is null;
    get diagnostics rc = row_count;
    if rc <> 1 then raise exception 'complete touched % rows', rc; end if;
    step := 'collect payment';
    update public.orders set payment_status = 'paid', payment_method = 'cash'
    where id::text = new_order and status = 'completed' and payment_status = 'pending' and closed_in_day_id is null;
    get diagnostics rc = row_count;
    if rc <> 1 then raise exception 'payment touched % orders', rc; end if;
    insert into public.payments (order_id, amount, method, collected_by, status)
    values (new_order, (select o.total from public.orders o where o.id::text = new_order), 'cash', a_staff, 'paid');
    update public.transactions set status = 'paid' where order_id::text = new_order;
    get diagnostics rc = row_count;
    if rc <> 1 then raise exception 'ledger status touched % rows', rc; end if;

    step := 'vendor notification';
    insert into public.vendor_notifications (business_id, branch_id, type, title, body, href)
    values (a_biz, a_branch, 'platform', '{"ar": "VP test", "en": "VP test"}', '{"ar": "VP test", "en": "VP test"}', '/')
    returning id::text into new_notif;
    step := 'read receipt';
    if to_regclass('public.vendor_notification_reads') is not null then
      execute format('insert into public.vendor_notification_reads (notification_id, staff_id)
                      select id, %L from public.vendor_notifications where id::text = %L on conflict do nothing returning notification_id', a_staff, new_notif);
    end if;
    step := 'admin notification (insert … returning id)';
    insert into public.admin_notifications (type, title, body, href)
    values ('unusual_activity', '{"ar": "VP test", "en": "VP test"}', '{"ar": "VP test", "en": "VP test"}', '/') returning id::text into new_id;
    step := 'block and unblock a slot';
    insert into public.branch_blocked_slots (branch_id, starts_at, ends_at, reason, created_by)
    values (a_branch, now() + interval '40 days', now() + interval '40 days 1 hour', 'VP test', a_staff) returning id::text into new_slot;
    delete from public.branch_blocked_slots where id::text = new_slot;
    get diagnostics rc = row_count;
    if rc <> 1 then raise exception 'unblock touched % rows', rc; end if;
    step := 'add staff';
    insert into public.staff (business_id, branch_id, name, phone, role, status, max_discount_pct, permissions)
    values (a_biz, a_branch, 'VP test', '+2015' || reverse(rnd), 'employee', 'active', 10, '{"confirmBooking": true, "cancelOrder": false, "closeShift": false, "editServices": false, "refund": false, "collectPayment": true, "runService": true, "manageStaff": false}') returning id::text into new_staff;
    step := 'staff shift pattern';
    insert into public.staff_shift_patterns (id, staff_id, starts_at, ends_at, days)
    values ('pat_' || new_staff || '_00', new_staff, '09:00', '17:00', '{0,1,2,3,4,5,6}');
    delete from public.staff_shift_patterns where staff_id::text = new_staff;
    step := 'settings upsert';
    insert into public.business_settings (business_id) values (a_biz) on conflict (business_id) do nothing;
    step := 'review reply column';
    if a_review is not null then
      update public.reviews set reply = reply where id::text = a_review;
    end if;
    step := 'offers list';
    perform count(*) from public.offers;

    passes := passes + 1;
  exception when others then
    fails := fails || format('flow of business A failed at "%s": %s %s', step, sqlstate, sqlerrm);
  end;

  -- ── 5. Public context (unauthenticated routes) ─────────────────────────────────────────────────
  perform set_config('app.user_id', '', true);
  perform set_config('app.staff_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.branch_ids', '', true);
  foreach chk slice 1 in array array[
    ['public: orders', 'select 0::bigint', 'select count(*) from public.orders'],
    ['public: staff', 'select 0::bigint', 'select count(*) from public.staff'],
    ['public: businesses', 'select 0::bigint', 'select count(*) from public.businesses'],
    ['public: customers', 'select 0::bigint', 'select count(*) from public.customers'],
    ['public: countries', 'select count(*) from public.countries', 'select count(*) from public.countries'],
    ['public: areas', 'select count(*) from public.areas', 'select count(*) from public.areas'],
    ['public: wash_applications', 'select count(*) from public.wash_applications', 'select count(*) from public.wash_applications']
  ] loop
    execute 'reset role';
    begin
      execute chk[2] into expected;
      execute 'set local role washup_vendor_panel';
      execute chk[3] into actual;
      if actual = expected then
        passes := passes + 1;
      else
        fails := fails || format('visibility %s: role sees %s rows, expected %s', chk[1], actual, expected);
      end if;
    exception when others then
      fails := fails || format('visibility %s: %s %s', chk[1], sqlstate, sqlerrm);
    end;
  end loop;
  execute 'set local role washup_vendor_panel';

  begin
    step := 'custom area';
    insert into public.areas (id, name, country_code, lat, lng, active, sort_order)
    values ('area_vptest', '{"ar": "VP test", "en": "VP test"}',
      (select c.code from public.countries c where c.active order by c.code limit 1), 30.0444, 31.2357, false, 99);
    step := 'wash application';
    insert into public.wash_applications (id, business_name, owner_name, phone, email, area_id, address, lat, lng,
      capacity, services, working_hours, documents, status, submitted_at)
    values ('app_vptest_' || rnd, 'VP test', 'VP test', '+2015' || rnd, 'vptest@partner.washup.app', 'area_vptest', 'VP test address',
      30.0444, 31.2357, 2, '[]', '[]', '{}', 'pending', now());
    step := 'application lookup by id';
    perform 1 from public.wash_applications where id = 'app_vptest_' || rnd;
    if not found then raise exception 'own application not readable'; end if;
    step := 'admin notification';
    insert into public.admin_notifications (type, title, body, href)
    values ('application', '{"ar": "VP test", "en": "VP test"}', '{"ar": "VP test", "en": "VP test"}', '/applications/app_vptest') returning id::text into new_id;
    passes := passes + 1;
  exception when others then
    fails := fails || format('public registration failed at "%s": %s %s', step, sqlstate, sqlerrm);
  end;

  foreach chk slice 1 in array array[
    ['public: insert a customer', $s$insert into public.customers (name, phone, status) values ('VP test', '+201599999992', 'active')$s$],
    ['public: insert an order', format($s$insert into public.orders (source, business_id, branch_id, plate, subtotal, total, duration_min, scheduled_at, status, payment_status)
       values ('walk_in', %L, %L, 'VPTEST', 0, 0, 30, now(), 'waiting', 'pending')$s$, a_biz, a_branch)]
  ] loop
    begin
      execute chk[2];
      fails := fails || format('refuse %s: was allowed', chk[1]);
    exception
      when insufficient_privilege then passes := passes + 1;
      when others then fails := fails || format('refuse %s: expected 42501, got %s %s', chk[1], sqlstate, sqlerrm);
    end;
  end loop;

  execute 'reset role';
  raise exception using message = format('VENDOR PANEL TEST: %s passed, %s failed%s', passes, coalesce(array_length(fails, 1), 0),
    case when coalesce(array_length(fails, 1), 0) = 0
         then ' — all good (this error is intentional: it rolls every test row back)'
         else E'\n- ' || array_to_string(fails, E'\n- ') end);
end $test$;

rollback;
