-- One-off demo data cleanup for the Supabase project (run once in the SQL editor), 2026-10-21.
-- Not a migration: it fixes rows, not schema. Wrapped in a transaction; check the counts it prints.
--
-- 1. Orders stuck in a live state for more than a day (seed data from 2026-10-15/19): they clutter the
--    live board ("overdue 7,000 min") and block day closings. Past bookings never confirmed are
--    cancelled, confirmed ones become no-shows, cars "inside" since days are cancelled.
-- 2. Branch landlines stored with an extra 0 (+202025550142 → +20225550142, Cairo 02 2555 0142).
-- 3. Seeded wash reports with the placeholder reason "—".

begin;

-- 1. Stale live orders ----------------------------------------------------------------
with stale as (
  select id, status from public.orders
  where status in ('pending', 'confirmed', 'waiting', 'in_service') and scheduled_at < now() - interval '1 day'
),
moved as (
  update public.orders o
  set status = case s.status when 'confirmed' then 'no_show'::public.order_status else 'cancelled'::public.order_status end,
      cancel_reason = case when s.status = 'confirmed' then o.cancel_reason else 'تنظيف بيانات العرض: طلب قديم لم يُستكمل' end,
      cancelled_by_type = case when s.status = 'confirmed' then o.cancelled_by_type else 'system' end,
      cancelled_by_id = case when s.status = 'confirmed' then o.cancelled_by_id else 'cleanup' end,
      cancelled_at = case when s.status = 'confirmed' then o.cancelled_at else now() end
  from stale s where o.id = s.id
  returning o.id, o.status
)
insert into public.order_events (order_id, status, actor_type, actor_id)
select id, status, 'system', 'cleanup' from moved;

delete from public.transactions t
using public.orders o
where t.order_id = o.id and t.status = 'pending' and o.status in ('cancelled', 'no_show');

-- 2. Landlines --------------------------------------------------------------------------
update public.branches set phone = '+202' || substr(phone, 6)
where phone like '+2020%' and length(phone) = 13;

update public.business_settings set contact_phone = '+202' || substr(contact_phone, 6)
where contact_phone like '+2020%' and length(contact_phone) = 13;

-- 3. Placeholder report reasons ---------------------------------------------------------
update public.reviews set report_reason = 'بلاغ من المغسلة (بيانات العرض)'
where reported_by_wash and report_reason in ('—', '-', '');

select
  (select count(*) from public.orders where status in ('pending', 'confirmed', 'waiting', 'in_service') and scheduled_at < now() - interval '1 day') as stale_left,
  (select count(*) from public.branches where phone like '+2020%') as bad_landlines_left;

commit;
