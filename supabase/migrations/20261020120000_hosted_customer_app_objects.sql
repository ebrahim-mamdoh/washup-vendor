-- Hosted-only objects captured from the Supabase project tbcmgdwzarfdgzzmmele on 2026-10-21.
--
-- The customer mobile app's booking functions, RLS policies, views, triggers and grants were created
-- directly on the hosted database (not through this folder). This file records them exactly as they
-- were, so a fresh database built from the repo matches production. It is idempotent (create or
-- replace / drop if exists) and was NOT re-applied to the hosted project: it is already there.
-- The tables legacy_* and any column drift are not included: capture them with `supabase db pull`.
-- The next migration (security hardening) changes some of these objects.

-- ── Functions ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._assert_slot_bookable(p_branch branches, p_start timestamp with time zone, p_duration integer, p_exclude_order text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_local timestamp := p_start AT TIME ZONE 'Africa/Cairo';
  v_end timestamptz := p_start + make_interval(mins => p_duration);
  v_hours public.branch_working_hours%ROWTYPE;
  v_open int;
  v_close int;
  v_start_min int;
  v_used int;
BEGIN
  IF p_start < now() + make_interval(mins => p_branch.lead_time_min) THEN
    RAISE EXCEPTION 'slot_too_soon';
  END IF;
  IF v_local::date > (now() AT TIME ZONE 'Africa/Cairo')::date + p_branch.max_advance_days THEN
    RAISE EXCEPTION 'slot_too_far';
  END IF;

  SELECT * INTO v_hours
  FROM public.branch_working_hours
  WHERE branch_id = p_branch.id AND weekday = extract(dow FROM v_local)::int;
  IF NOT FOUND OR v_hours.closed THEN
    RAISE EXCEPTION 'slot_outside_hours';
  END IF;

  v_open := extract(hour FROM v_hours.opens_at)::int * 60 + extract(minute FROM v_hours.opens_at)::int;
  v_close := extract(hour FROM v_hours.closes_at)::int * 60 + extract(minute FROM v_hours.closes_at)::int;
  IF v_close <= v_open THEN
    v_close := v_close + 1440; -- closes at or after midnight
  END IF;
  v_start_min := extract(hour FROM v_local)::int * 60 + extract(minute FROM v_local)::int;

  IF extract(second FROM v_local) <> 0
     OR v_start_min < v_open
     OR v_start_min + p_duration > v_close
     OR (v_start_min - v_open) % greatest(p_branch.slot_interval_min, 1) <> 0 THEN
    RAISE EXCEPTION 'slot_outside_hours';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.branch_blocked_slots b
    WHERE b.branch_id = p_branch.id AND b.starts_at < v_end AND b.ends_at > p_start
  ) THEN
    RAISE EXCEPTION 'slot_unavailable';
  END IF;

  SELECT count(*) INTO v_used
  FROM public.orders o
  WHERE o.branch_id = p_branch.id
    AND o.status IN ('pending', 'confirmed', 'waiting', 'in_service')
    AND o.id IS DISTINCT FROM p_exclude_order
    AND o.scheduled_at < v_end
    AND o.scheduled_at + make_interval(mins => o.duration_min) > p_start;

  IF v_used >= p_branch.capacity THEN
    RAISE EXCEPTION 'slot_unavailable';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public._booking_customer()
 RETURNS customers
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cust public.customers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  SELECT * INTO v_cust FROM public.customers WHERE user_id = auth.uid() LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  IF v_cust.status <> 'active' THEN
    RAISE EXCEPTION 'account_suspended';
  END IF;
  RETURN v_cust;
END;
$function$;

CREATE OR REPLACE FUNCTION public._order_json(p_order_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT to_jsonb(o)
    || jsonb_build_object(
         'order_items', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.position) FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb),
         'order_events', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.at) FROM public.order_events e WHERE e.order_id = o.id), '[]'::jsonb)
       )
  FROM public.orders o
  WHERE o.id = p_order_id;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cust public.customers := public._booking_customer();
  v_order public.orders%ROWTYPE;
  v_free_min int;
  v_late boolean;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND customer_id = v_cust.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;
  IF v_order.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'order_not_cancellable';
  END IF;

  SELECT free_cancel_min INTO v_free_min FROM public.branches WHERE id = v_order.branch_id;
  v_late := v_order.scheduled_at - now() < make_interval(mins => coalesce(v_free_min, 60));

  UPDATE public.orders
  SET status = 'cancelled',
      cancel_reason = left(coalesce(nullif(trim(p_reason), ''), 'Cancelled by customer'), 500),
      cancelled_at = now(),
      cancelled_by_type = 'customer',
      cancelled_by_id = v_cust.id,
      updated_at = now()
  WHERE id = v_order.id;

  INSERT INTO public.order_events (order_id, status, actor_type, actor_id)
  VALUES (v_order.id, 'cancelled', 'customer', v_cust.id);

  RETURN public._order_json(v_order.id) || jsonb_build_object('late_cancel', v_late);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_order(p_branch_id text, p_vehicle_id text, p_primary_service_id text, p_scheduled_at timestamp with time zone, p_addon_service_ids text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cust public.customers := public._booking_customer();
  v_branch public.branches%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
  v_primary public.services%ROWTYPE;
  v_addons public.services[];
  v_addon_ids text[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_addon_service_ids, '{}')));
  v_subtotal numeric;
  v_duration int;
  v_offer_id text;
  v_offer_type public.discount_type;
  v_offer_value numeric;
  v_discount numeric := 0;
  v_order public.orders%ROWTYPE;
  v_status public.order_status;
BEGIN
  SELECT b.* INTO v_branch
  FROM public.branches b
  JOIN public.businesses biz ON biz.id = b.business_id
  WHERE b.id = p_branch_id AND b.active AND biz.status IN ('active', 'approved');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch_unavailable';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_id = v_cust.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vehicle_not_found';
  END IF;

  SELECT * INTO v_primary
  FROM public.services
  WHERE id = p_primary_service_id AND branch_id = v_branch.id AND type = 'primary' AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service_not_found';
  END IF;

  SELECT coalesce(array_agg(s ORDER BY array_position(v_addon_ids, s.id)), '{}') INTO v_addons
  FROM public.services s
  WHERE s.id = ANY (v_addon_ids) AND s.branch_id = v_branch.id AND s.type = 'addon' AND s.active;
  IF cardinality(v_addons) <> cardinality(v_addon_ids) THEN
    RAISE EXCEPTION 'invalid_addon';
  END IF;

  SELECT v_primary.price + coalesce(sum(a.price), 0),
         v_primary.duration_min + coalesce(sum(a.duration_min), 0)::int
    INTO v_subtotal, v_duration
  FROM unnest(v_addons) AS a;

  -- Best live offer for this branch; applies to the primary service only.
  -- An offer with no categories covers every service.
  SELECT o.id, o.discount_type, o.discount_value,
         CASE WHEN o.discount_type = 'percent'
              THEN round(v_primary.price * o.discount_value / 100.0)
              ELSE least(o.discount_value, v_primary.price) END AS amount
    INTO v_offer_id, v_offer_type, v_offer_value, v_discount
  FROM public.offers o
  JOIN public.offer_branches ob ON ob.offer_id = o.id AND ob.branch_id = v_branch.id
  WHERE o.status = 'active'
    AND now() >= o.starts_at AND now() < o.ends_at
    AND (NOT EXISTS (SELECT 1 FROM public.offer_categories oc WHERE oc.offer_id = o.id)
         OR EXISTS (SELECT 1 FROM public.offer_categories oc WHERE oc.offer_id = o.id AND oc.category_id = v_primary.category_id))
  ORDER BY amount DESC, o.id
  LIMIT 1;
  v_discount := greatest(coalesce(v_discount, 0), 0);

  -- Serialize bookings per branch so two customers cannot take the last seat.
  PERFORM pg_advisory_xact_lock(hashtext('carzone_slot:' || v_branch.id));
  PERFORM public._assert_slot_bookable(v_branch, p_scheduled_at, v_duration);

  v_status := CASE WHEN v_branch.auto_confirm THEN 'confirmed' ELSE 'pending' END;

  INSERT INTO public.orders (
    number, source, customer_id, vehicle_id, plate, business_id, branch_id,
    offer_id, subtotal, discount_amount, discount_pct, discount_reason, total,
    duration_min, scheduled_at, status, payment_status
  ) VALUES (
    public.next_order_number('app'), 'app', v_cust.id, v_vehicle.id, v_vehicle.plate,
    v_branch.business_id, v_branch.id,
    CASE WHEN v_discount > 0 THEN v_offer_id END,
    v_subtotal,
    CASE WHEN v_discount > 0 THEN v_discount END,
    CASE WHEN v_discount > 0 AND v_offer_type = 'percent' THEN v_offer_value END,
    CASE WHEN v_discount > 0 THEN 'offer' END,
    v_subtotal - v_discount,
    v_duration, p_scheduled_at, v_status, 'pending'
  )
  RETURNING * INTO v_order;

  INSERT INTO public.order_items (order_id, service_id, name, type, price, duration_min, position)
  SELECT v_order.id, s.id, s.name, s.type, s.price, s.duration_min, s.pos
  FROM (
    SELECT v_primary.id, v_primary.name, v_primary.type, v_primary.price, v_primary.duration_min, 0 AS pos
    UNION ALL
    SELECT t.id, t.name, t.type, t.price, t.duration_min, t.ordinality::int
    FROM unnest(v_addons) WITH ORDINALITY AS t
  ) AS s(id, name, type, price, duration_min, pos);

  INSERT INTO public.order_events (order_id, status, actor_type, actor_id)
  VALUES (v_order.id, 'pending', 'customer', v_cust.id);
  IF v_status = 'confirmed' THEN
    INSERT INTO public.order_events (order_id, status, actor_type, actor_id)
    VALUES (v_order.id, 'confirmed', 'system', 'auto_confirm');
  END IF;

  RETURN public._order_json(v_order.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.current_customer_id()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.customers WHERE user_id = (SELECT auth.uid()) LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_branch_slots(p_branch_id text, p_date date, p_duration integer DEFAULT 30, p_exclude_order text DEFAULT NULL::text, p_include_full boolean DEFAULT false)
 RETURNS TABLE(start_at timestamp with time zone, local_time text, free_capacity integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch branches%ROWTYPE;
  v_hours branch_working_hours%ROWTYPE;
  v_open int;
  v_close int;
  v_step int;
  v_dow int;
  v_min int;
  v_slot_local timestamp;
  v_slot_tz timestamptz;
  v_slot_end timestamptz;
  v_used int;
  v_free int;
  v_earliest timestamptz;
  v_cairo_today date;
BEGIN
  SELECT * INTO v_branch FROM public.branches WHERE id = p_branch_id;
  IF NOT FOUND OR NOT v_branch.active THEN
    RETURN;
  END IF;

  v_cairo_today := (now() AT TIME ZONE 'Africa/Cairo')::date;
  IF p_date < v_cairo_today OR p_date > v_cairo_today + v_branch.max_advance_days THEN
    RETURN;
  END IF;

  v_dow := extract(dow FROM p_date)::int;
  SELECT * INTO v_hours FROM public.branch_working_hours WHERE branch_id = p_branch_id AND weekday = v_dow;
  IF NOT FOUND OR v_hours.closed THEN
    RETURN;
  END IF;

  v_open := extract(hour FROM v_hours.opens_at)::int * 60 + extract(minute FROM v_hours.opens_at)::int;
  v_close := extract(hour FROM v_hours.closes_at)::int * 60 + extract(minute FROM v_hours.closes_at)::int;
  IF v_close <= v_open THEN
    v_close := v_close + 1440;
  END IF;

  v_step := greatest(v_branch.slot_interval_min, 15);
  v_earliest := now() + make_interval(mins => v_branch.lead_time_min);

  FOR v_min IN v_open..(v_close - p_duration) BY v_step LOOP
    v_slot_local := p_date + make_interval(hours => v_min / 60, mins => v_min % 60);
    v_slot_tz := v_slot_local AT TIME ZONE 'Africa/Cairo';
    v_slot_end := v_slot_tz + make_interval(mins => p_duration);

    -- Skip past or too soon slots
    IF v_slot_tz < v_earliest THEN
      CONTINUE;
    END IF;

    -- Check if blocked
    IF EXISTS (
      SELECT 1 FROM public.branch_blocked_slots b
      WHERE b.branch_id = p_branch_id AND b.starts_at < v_slot_end AND b.ends_at > v_slot_tz
    ) THEN
      CONTINUE;
    END IF;

    -- Count existing reservations
    SELECT count(*) INTO v_used
    FROM public.orders o
    WHERE o.branch_id = p_branch_id
      AND o.status IN ('pending', 'confirmed', 'waiting', 'in_service')
      AND o.id IS DISTINCT FROM p_exclude_order
      AND o.scheduled_at < v_slot_end
      AND o.scheduled_at + make_interval(mins => o.duration_min) > v_slot_tz;

    v_free := v_branch.capacity - v_used;
    IF v_free > 0 OR p_include_full THEN
      start_at := v_slot_tz;
      local_time := to_char(v_slot_local, 'HH24:MI');
      free_capacity := greatest(v_free, 0);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_order_status_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_type text;
  v_title jsonb;
  v_body jsonb;
  v_notif_id text;
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_type := 'created';
    v_title := jsonb_build_object('ar', 'تم إنشاء الحجز بنجاح', 'en', 'Booking Created');
    v_body := jsonb_build_object('ar', 'طلبك رقم #' || NEW.number || ' قيد المراجعة في الفرع', 'en', 'Order #' || NEW.number || ' is under review');
  ELSIF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.status = 'confirmed' THEN
      v_type := 'confirmed';
      v_title := jsonb_build_object('ar', 'تم تأكيد الحجز', 'en', 'Booking Confirmed');
      v_body := jsonb_build_object('ar', 'تم تأكيد حجزك رقم #' || NEW.number || ' بنجاح', 'en', 'Your booking #' || NEW.number || ' is confirmed');
    ELSIF NEW.status = 'waiting' THEN
      v_type := 'waiting';
      v_title := jsonb_build_object('ar', 'في قائمة الانتظار', 'en', 'In Queue');
      v_body := jsonb_build_object('ar', 'وصلت سيارتك للفرع وجارٍ تجهيز مسار الغسيل للطلب #' || NEW.number, 'en', 'Your vehicle arrived at the branch for order #' || NEW.number);
    ELSIF NEW.status = 'in_service' THEN
      v_type := 'in_service';
      v_title := jsonb_build_object('ar', 'بدء الخدمة', 'en', 'Washing In Progress');
      v_body := jsonb_build_object('ar', 'بدأ العمل على سيارتك الآن للطلب #' || NEW.number, 'en', 'Work on your vehicle has started for order #' || NEW.number);
    ELSIF NEW.status = 'completed' THEN
      v_type := 'completed';
      v_title := jsonb_build_object('ar', 'سيارتك جاهزة!', 'en', 'Vehicle Ready!');
      v_body := jsonb_build_object('ar', 'اكتملت الخدمة! سيارتك جاهزة للاستلام للطلب #' || NEW.number, 'en', 'Service completed! Your car is ready for pickup for order #' || NEW.number);
    ELSIF NEW.status = 'cancelled' THEN
      v_type := 'cancelled';
      v_title := jsonb_build_object('ar', 'تم إلغاء الحجز', 'en', 'Booking Cancelled');
      v_body := jsonb_build_object('ar', 'تم إلغاء الحجز رقم #' || NEW.number, 'en', 'Booking #' || NEW.number || ' was cancelled');
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  v_notif_id := 'cn_' || NEW.id || '_' || v_type;

  INSERT INTO public.customer_notifications (
    id, customer_id, type, title, body, href, order_id, read, created_at
  ) VALUES (
    v_notif_id, NEW.customer_id, v_type, v_title, v_body, '/booking_details?id=' || NEW.id, NEW.id, false, now()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_staff_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = (SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = (SELECT auth.uid()));
$function$;

CREATE OR REPLACE FUNCTION public.notify_customer_notification_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'send_push_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'send_push_webhook_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', NULL
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', v_secret
    ),
    timeout_milliseconds := 10000
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A push problem must never roll back the notification itself.
  RAISE WARNING 'send-push webhook for % failed: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_order(p_order_id text, p_scheduled_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cust public.customers := public._booking_customer();
  v_order public.orders%ROWTYPE;
  v_branch public.branches%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND customer_id = v_cust.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;
  IF v_order.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'order_not_reschedulable';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_order.branch_id;
  PERFORM pg_advisory_xact_lock(hashtext('carzone_slot:' || v_branch.id));
  PERFORM public._assert_slot_bookable(v_branch, p_scheduled_at, v_order.duration_min, v_order.id);

  UPDATE public.orders SET scheduled_at = p_scheduled_at, updated_at = now() WHERE id = v_order.id;

  RETURN public._order_json(v_order.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_push_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
  FROM vault.decrypted_secrets
  WHERE name IN ('send_push_webhook_secret', 'firebase_service_account');
$function$;

CREATE OR REPLACE FUNCTION public.sync_customer_profile(p_phone text, p_name text DEFAULT NULL::text, p_locale text DEFAULT 'ar'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cust public.customers%ROWTYPE;
  v_clean_phone text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Normalize phone to E.164 (strip whitespace)
  v_clean_phone := regexp_replace(p_phone, '\s+', '', 'g');

  -- 1. Try to find by user_id
  SELECT * INTO v_cust FROM public.customers WHERE user_id = v_uid LIMIT 1;

  IF FOUND THEN
    UPDATE public.customers
    SET 
      name = CASE WHEN p_name IS NOT NULL AND length(trim(p_name)) >= 2 THEN trim(p_name) ELSE name END,
      locale = COALESCE(p_locale, locale),
      last_active_at = now(),
      updated_at = now()
    WHERE id = v_cust.id
    RETURNING * INTO v_cust;

    RETURN to_jsonb(v_cust);
  END IF;

  -- 2. Try to find by phone (e.g. seeded demo user or unlinked record)
  SELECT * INTO v_cust FROM public.customers WHERE phone = v_clean_phone LIMIT 1;

  IF FOUND THEN
    -- Link existing record to current auth.uid()
    UPDATE public.customers
    SET 
      user_id = v_uid,
      name = CASE WHEN p_name IS NOT NULL AND length(trim(p_name)) >= 2 THEN trim(p_name) ELSE name END,
      locale = COALESCE(p_locale, locale),
      last_active_at = now(),
      updated_at = now()
    WHERE id = v_cust.id
    RETURNING * INTO v_cust;

    RETURN to_jsonb(v_cust);
  END IF;

  -- 3. If neither found, create a new record if name is provided
  IF p_name IS NOT NULL AND length(trim(p_name)) >= 2 THEN
    INSERT INTO public.customers (
      id,
      user_id,
      name,
      phone,
      locale,
      status,
      last_active_at
    ) VALUES (
      public.gen_id('cu'),
      v_uid,
      trim(p_name),
      v_clean_phone,
      COALESCE(p_locale, 'ar'),
      'active',
      now()
    )
    RETURNING * INTO v_cust;

    RETURN to_jsonb(v_cust);
  END IF;

  RETURN NULL;
END;
$function$;

-- ── Views ─────────────────────────────────────────────────

create or replace view public."app_health" as
SELECT 1 AS id,
    'healthy'::text AS status,
    now() AS updated_at;

create or replace view public."branch_shares" as
SELECT id,
    branch_id,
    user_id,
    platform,
    created_at
   FROM legacy_branch_shares;

-- ── Triggers ──────────────────────────────────────────────

drop trigger if exists "trg_customer_notifications_send_push" on customer_notifications;
CREATE TRIGGER trg_customer_notifications_send_push AFTER INSERT ON public.customer_notifications FOR EACH ROW EXECUTE FUNCTION notify_customer_notification_push();

drop trigger if exists "trg_order_status_notification" on orders;
CREATE TRIGGER trg_order_status_notification AFTER INSERT OR UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION handle_order_status_notification();

-- ── Row level security policies ───────────────────────────

drop policy if exists "Public read amenities" on public."amenities";
create policy "Public read amenities" on public."amenities" as permissive for select to anon, authenticated
  using ((active = true));

drop policy if exists "Public read active areas" on public."areas";
create policy "Public read active areas" on public."areas" as permissive for select to anon, authenticated
  using ((active = true));

drop policy if exists "Public read branch amenities" on public."branch_amenities";
create policy "Public read branch amenities" on public."branch_amenities" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public read branch photos" on public."branch_photos";
create policy "Public read branch photos" on public."branch_photos" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public read branch working hours" on public."branch_working_hours";
create policy "Public read branch working hours" on public."branch_working_hours" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public read active branches" on public."branches";
create policy "Public read active branches" on public."branches" as permissive for select to anon, authenticated
  using ((active = true));

drop policy if exists "Customers can insert own complaints" on public."complaints";
create policy "Customers can insert own complaints" on public."complaints" as permissive for insert to authenticated
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can select own complaints" on public."complaints";
create policy "Customers can select own complaints" on public."complaints" as permissive for select to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can delete own favorites" on public."customer_favorites";
create policy "Customers can delete own favorites" on public."customer_favorites" as permissive for delete to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can insert own favorites" on public."customer_favorites";
create policy "Customers can insert own favorites" on public."customer_favorites" as permissive for insert to authenticated
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can select own favorites" on public."customer_favorites";
create policy "Customers can select own favorites" on public."customer_favorites" as permissive for select to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can insert own notifications" on public."customer_notifications";
create policy "Customers can insert own notifications" on public."customer_notifications" as permissive for insert to authenticated
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can mark own notifications read" on public."customer_notifications";
create policy "Customers can mark own notifications read" on public."customer_notifications" as permissive for update to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)))
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can select own notifications" on public."customer_notifications";
create policy "Customers can select own notifications" on public."customer_notifications" as permissive for select to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can insert own row" on public."customers";
create policy "Customers can insert own row" on public."customers" as permissive for insert to authenticated
  with check ((user_id = ( SELECT auth.uid() AS uid)));

drop policy if exists "Customers can select own row" on public."customers";
create policy "Customers can select own row" on public."customers" as permissive for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));

drop policy if exists "Customers can update own row" on public."customers";
create policy "Customers can update own row" on public."customers" as permissive for update to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)))
  with check ((user_id = ( SELECT auth.uid() AS uid)));

drop policy if exists "Allow public read access to app_health" on public."legacy_app_health";
create policy "Allow public read access to app_health" on public."legacy_app_health" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public read areas" on public."legacy_areas";
create policy "Public read areas" on public."legacy_areas" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write areas" on public."legacy_areas";
create policy "Public write areas" on public."legacy_areas" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Allow public insert to branch_shares" on public."legacy_branch_shares";
create policy "Allow public insert to branch_shares" on public."legacy_branch_shares" as permissive for insert to anon, authenticated
  with check (true);

drop policy if exists "Allow public select to branch_shares" on public."legacy_branch_shares";
create policy "Allow public select to branch_shares" on public."legacy_branch_shares" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public read branches" on public."legacy_branches";
create policy "Public read branches" on public."legacy_branches" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write branches" on public."legacy_branches";
create policy "Public write branches" on public."legacy_branches" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read complaints" on public."legacy_complaints";
create policy "Public read complaints" on public."legacy_complaints" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write complaints" on public."legacy_complaints";
create policy "Public write complaints" on public."legacy_complaints" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read customers" on public."legacy_customers";
create policy "Public read customers" on public."legacy_customers" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write customers" on public."legacy_customers";
create policy "Public write customers" on public."legacy_customers" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read favorites" on public."legacy_favorites";
create policy "Public read favorites" on public."legacy_favorites" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write favorites" on public."legacy_favorites";
create policy "Public write favorites" on public."legacy_favorites" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read notifications" on public."legacy_notifications";
create policy "Public read notifications" on public."legacy_notifications" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write notifications" on public."legacy_notifications";
create policy "Public write notifications" on public."legacy_notifications" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read offers" on public."legacy_offers";
create policy "Public read offers" on public."legacy_offers" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write offers" on public."legacy_offers";
create policy "Public write offers" on public."legacy_offers" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read orders" on public."legacy_orders";
create policy "Public read orders" on public."legacy_orders" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write orders" on public."legacy_orders";
create policy "Public write orders" on public."legacy_orders" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read reviews" on public."legacy_reviews";
create policy "Public read reviews" on public."legacy_reviews" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write reviews" on public."legacy_reviews";
create policy "Public write reviews" on public."legacy_reviews" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read services" on public."legacy_services";
create policy "Public read services" on public."legacy_services" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write services" on public."legacy_services";
create policy "Public write services" on public."legacy_services" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read vehicles" on public."legacy_vehicles";
create policy "Public read vehicles" on public."legacy_vehicles" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public write vehicles" on public."legacy_vehicles";
create policy "Public write vehicles" on public."legacy_vehicles" as permissive for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read offer branches" on public."offer_branches";
create policy "Public read offer branches" on public."offer_branches" as permissive for select to anon, authenticated
  using (true);

drop policy if exists "Public read active offers" on public."offers";
create policy "Public read active offers" on public."offers" as permissive for select to anon, authenticated
  using ((status = 'active'::offer_status));

drop policy if exists "Customers can insert own order events" on public."order_events";
create policy "Customers can insert own order events" on public."order_events" as permissive for insert to authenticated
  with check ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.customer_id = ( SELECT current_customer_id() AS current_customer_id)))));

drop policy if exists "Customers can select own order events" on public."order_events";
create policy "Customers can select own order events" on public."order_events" as permissive for select to authenticated
  using ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.customer_id = ( SELECT current_customer_id() AS current_customer_id)))));

drop policy if exists "Customers can insert own order items" on public."order_items";
create policy "Customers can insert own order items" on public."order_items" as permissive for insert to authenticated
  with check ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.customer_id = ( SELECT current_customer_id() AS current_customer_id)))));

drop policy if exists "Customers can select own order items" on public."order_items";
create policy "Customers can select own order items" on public."order_items" as permissive for select to authenticated
  using ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.customer_id = ( SELECT current_customer_id() AS current_customer_id)))));

drop policy if exists "Customers can insert own orders" on public."orders";
create policy "Customers can insert own orders" on public."orders" as permissive for insert to authenticated
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can select own orders" on public."orders";
create policy "Customers can select own orders" on public."orders" as permissive for select to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can update own orders" on public."orders";
create policy "Customers can update own orders" on public."orders" as permissive for update to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)))
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Users can manage own push devices" on public."push_devices";
create policy "Users can manage own push devices" on public."push_devices" as permissive for all to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)))
  with check ((user_id = ( SELECT auth.uid() AS uid)));

drop policy if exists "Customers can insert review" on public."reviews";
create policy "Customers can insert review" on public."reviews" as permissive for insert to authenticated
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can update own review" on public."reviews";
create policy "Customers can update own review" on public."reviews" as permissive for update to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)))
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Public read visible reviews" on public."reviews";
create policy "Public read visible reviews" on public."reviews" as permissive for select to anon, authenticated
  using ((status = 'visible'::review_status));

drop policy if exists "Public read active categories" on public."service_categories";
create policy "Public read active categories" on public."service_categories" as permissive for select to anon, authenticated
  using ((active = true));

drop policy if exists "Public read active services" on public."services";
create policy "Public read active services" on public."services" as permissive for select to anon, authenticated
  using ((active = true));

drop policy if exists "Customers can delete own vehicles" on public."vehicles";
create policy "Customers can delete own vehicles" on public."vehicles" as permissive for delete to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can insert own vehicles" on public."vehicles";
create policy "Customers can insert own vehicles" on public."vehicles" as permissive for insert to authenticated
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can select own vehicles" on public."vehicles";
create policy "Customers can select own vehicles" on public."vehicles" as permissive for select to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

drop policy if exists "Customers can update own vehicles" on public."vehicles";
create policy "Customers can update own vehicles" on public."vehicles" as permissive for update to authenticated
  using ((customer_id = ( SELECT current_customer_id() AS current_customer_id)))
  with check ((customer_id = ( SELECT current_customer_id() AS current_customer_id)));

-- ── Grants to the Data API roles ──────────────────────────

grant select on public."amenities" to anon;
grant select on public."amenities" to authenticated;
grant select on public."app_health" to anon;
grant select on public."app_health" to authenticated;
grant select on public."areas" to anon;
grant select on public."areas" to authenticated;
grant select on public."branch_amenities" to anon;
grant select on public."branch_amenities" to authenticated;
grant select on public."branch_photos" to anon;
grant select on public."branch_photos" to authenticated;
grant insert, select on public."branch_shares" to anon;
grant insert, select on public."branch_shares" to authenticated;
grant select on public."branch_working_hours" to anon;
grant select on public."branch_working_hours" to authenticated;
grant select on public."branches" to anon;
grant select on public."branches" to authenticated;
grant insert, select on public."complaints" to authenticated;
grant delete, insert, select on public."customer_favorites" to authenticated;
grant insert, select, update on public."customer_notifications" to authenticated;
grant insert, select, update on public."customers" to authenticated;
grant select on public."offer_branches" to anon;
grant select on public."offer_branches" to authenticated;
grant select on public."offers" to anon;
grant select on public."offers" to authenticated;
grant insert, select on public."order_events" to authenticated;
grant insert, select on public."order_items" to authenticated;
grant insert, select, update on public."orders" to authenticated;
grant delete, insert, select, update on public."push_devices" to authenticated;
grant select on public."reviews" to anon;
grant insert, select, update on public."reviews" to authenticated;
grant select on public."service_categories" to anon;
grant select on public."service_categories" to authenticated;
grant select on public."services" to anon;
grant select on public."services" to authenticated;
grant delete, insert, select, update on public."vehicles" to authenticated;

grant execute on function public."cancel_order"(p_order_id text, p_reason text) to authenticated;
grant execute on function public."create_order"(p_branch_id text, p_vehicle_id text, p_primary_service_id text, p_scheduled_at timestamp with time zone, p_addon_service_ids text[]) to authenticated;
grant execute on function public."current_customer_id"() to anon;
grant execute on function public."current_customer_id"() to authenticated;
grant execute on function public."gen_check_in_code"() to anon;
grant execute on function public."gen_check_in_code"() to authenticated;
grant execute on function public."gen_id"(prefix text) to anon;
grant execute on function public."gen_id"(prefix text) to authenticated;
grant execute on function public."get_branch_slots"(p_branch_id text, p_date date, p_duration integer, p_exclude_order text, p_include_full boolean) to anon;
grant execute on function public."get_branch_slots"(p_branch_id text, p_date date, p_duration integer, p_exclude_order text, p_include_full boolean) to authenticated;
grant execute on function public."handle_order_status_notification"() to anon;
grant execute on function public."handle_order_status_notification"() to authenticated;
grant execute on function public."is_localized"(value jsonb) to anon;
grant execute on function public."is_localized"(value jsonb) to authenticated;
grant execute on function public."is_staff_or_admin"() to anon;
grant execute on function public."is_staff_or_admin"() to authenticated;
grant execute on function public."next_complaint_ticket"() to anon;
grant execute on function public."next_complaint_ticket"() to authenticated;
grant execute on function public."next_order_number"(src order_source) to anon;
grant execute on function public."next_order_number"(src order_source) to authenticated;
grant execute on function public."normalize_plate"(plate text) to anon;
grant execute on function public."normalize_plate"(plate text) to authenticated;
grant execute on function public."reschedule_order"(p_order_id text, p_scheduled_at timestamp with time zone) to authenticated;
grant execute on function public."sync_customer_profile"(p_phone text, p_name text, p_locale text) to anon;
grant execute on function public."sync_customer_profile"(p_phone text, p_name text, p_locale text) to authenticated;
