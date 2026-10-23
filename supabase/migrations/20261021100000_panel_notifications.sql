-- Notifications for the two panels from events that happen outside them (2026-10-21).
--
-- The partner portal and the Super Admin create their own notifications (and push them to the
-- browser through FCM). Events from the customer app never reached them: 55 app bookings in a week
-- produced no "new booking" for the wash. This adds, in the database:
--   wash   ← new customer-app booking (new_booking), booking cancelled by the customer (booking_cancelled)
--   admin  ← new wash application (application), new customer complaint (complaint)
-- Each row is also pushed to the panel's browsers: the trigger posts {id} to the panel's
-- /api/v1/{vendor|admin}/push/hook with the shared secret (pg_net, like the customer app's send-push).
--
-- Vault secrets to create first (Dashboard → Vault):
--   panel_push_vendor_url  = https://<partner portal>/api/v1/vendor/push/hook
--   panel_push_admin_url   = https://<super admin>/api/v1/admin/push/hook
--   panel_push_secret      = the PUSH_WEBHOOK_SECRET set on both panels
-- Without them the notification rows are still created (in-app list); only the browser push is skipped.
--
-- Also lets push_devices hold Super Admin browsers (app = 'admin').

alter table public.push_devices drop constraint if exists push_devices_app_check;
alter table public.push_devices add constraint push_devices_app_check
  check (app = any (array['customer', 'employee', 'partner', 'admin']));

-- POSTs {"id": …} to a panel push hook; never fails the caller.
create or replace function public.panel_push(p_target text, p_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets
  where name = case p_target when 'admin' then 'panel_push_admin_url' else 'panel_push_vendor_url' end;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'panel_push_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('id', p_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    timeout_milliseconds := 10000
  );
exception when others then
  raise warning 'panel push % % failed: %', p_target, p_id, sqlerrm;
end $$;

-- A wash notification, unless the owner muted that type (Settings → notifications).
create or replace function public.notify_wash(p_business text, p_branch text, p_type public.vendor_notification_type,
                                               p_title text, p_body text, p_href text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_id text;
begin
  if coalesce((select (s.notification_prefs ->> p_type::text)::boolean from public.business_settings s where s.business_id = p_business), true) is false then
    return;
  end if;
  insert into public.vendor_notifications (business_id, branch_id, type, title, body, href)
  values (p_business, p_branch, p_type, jsonb_build_object('ar', p_title, 'en', p_title), jsonb_build_object('ar', p_body, 'en', p_body), p_href)
  returning id into v_id;
  perform public.panel_push('vendor', v_id);
end $$;

create or replace function public.notify_admins(p_type public.admin_notification_type, p_title jsonb, p_body jsonb, p_href text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_id text;
begin
  insert into public.admin_notifications (type, title, body, href) values (p_type, p_title, p_body, p_href) returning id into v_id;
  perform public.panel_push('admin', v_id);
end $$;

-- Customer-app bookings and customer cancellations → the wash.
create or replace function public.wash_order_notifications()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_branch text;
  v_when text;
begin
  select name ->> 'ar' into v_branch from public.branches where id = new.branch_id;
  v_when := to_char(new.scheduled_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI');
  if tg_op = 'INSERT' and new.source = 'app' then
    perform public.notify_wash(new.business_id, new.branch_id, 'new_booking',
      'حجز جديد من التطبيق ' || new.number,
      coalesce(v_branch, '') || ' — ' || v_when || case when new.status = 'pending' then ' — بانتظار التأكيد' else '' end,
      '/orders/' || new.id);
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.cancelled_by_type = 'customer' then
    perform public.notify_wash(new.business_id, new.branch_id, 'booking_cancelled',
      'العميل ألغى الحجز ' || new.number,
      coalesce(v_branch, '') || ' — ' || v_when || coalesce(' — ' || nullif(new.cancel_reason, 'Cancelled by customer'), ''),
      '/orders/' || new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_wash_order_notifications on public.orders;
create trigger trg_wash_order_notifications after insert or update of status on public.orders
  for each row execute function public.wash_order_notifications();

-- New wash applications and customer complaints → the Super Admin.
create or replace function public.admin_inbox_notifications()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'wash_applications' then
    perform public.notify_admins('application',
      jsonb_build_object('ar', 'طلب انضمام جديد', 'en', 'New wash application'),
      jsonb_build_object('ar', new.business_name || ' — بانتظار المراجعة', 'en', new.business_name),
      '/applications/' || new.id);
  elsif tg_table_name = 'complaints' then
    perform public.notify_admins('complaint',
      jsonb_build_object('ar', 'شكوى جديدة ' || new.ticket, 'en', 'New complaint ' || new.ticket),
      jsonb_build_object('ar', left(new.description, 120), 'en', left(new.description, 120)),
      '/complaints/' || new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_admin_application_notification on public.wash_applications;
create trigger trg_admin_application_notification after insert on public.wash_applications
  for each row execute function public.admin_inbox_notifications();

drop trigger if exists trg_admin_complaint_notification on public.complaints;
create trigger trg_admin_complaint_notification after insert on public.complaints
  for each row execute function public.admin_inbox_notifications();

revoke all on function public.panel_push(text, text), public.notify_wash(text, text, public.vendor_notification_type, text, text, text),
  public.notify_admins(public.admin_notification_type, jsonb, jsonb, text), public.wash_order_notifications(),
  public.admin_inbox_notifications() from public, anon, authenticated;
