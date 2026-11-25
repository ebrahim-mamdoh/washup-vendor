-- APPLIED to tbcmgdwzarfdgzzmmele on 2026-11-26 by the lead (recorded in schema_migrations as 20261126110000).
--
-- GAP-095 (system audit). `vendor_notifications.read` is one flag shared by every staff member of a
-- business: one person's "read all" cleared everyone's badge. This adds per-staff read receipts.
--
-- Code (vendor portal API) works before AND after this migration: it checks
-- `to_regclass('public.vendor_notification_reads')` (cached ~5 min per server instance) and uses the
-- receipts when the table exists, the shared `read` column otherwise. Once applied, the API no longer
-- writes `vendor_notifications.read`.
--
-- Idempotent. Column types follow the live id types (looked up, not assumed). Panel-only table:
-- RLS on with no policies and no grants for anon/authenticated (same as the other staff tables; the
-- panels' server role bypasses RLS).

begin;

do $$
declare
  notification_type text;
  staff_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into notification_type
  from pg_attribute a where a.attrelid = 'public.vendor_notifications'::regclass and a.attname = 'id';
  select format_type(a.atttypid, a.atttypmod) into staff_type
  from pg_attribute a where a.attrelid = 'public.staff'::regclass and a.attname = 'id';

  execute format(
    'create table if not exists public.vendor_notification_reads (
       notification_id %s not null references public.vendor_notifications(id) on delete cascade,
       staff_id %s not null references public.staff(id) on delete cascade,
       read_at timestamptz not null default now(),
       primary key (notification_id, staff_id)
     )', notification_type, staff_type);
end $$;

create index if not exists vendor_notification_reads_staff_idx on public.vendor_notification_reads (staff_id);

alter table public.vendor_notification_reads enable row level security;
revoke all on public.vendor_notification_reads from anon, authenticated;

-- Keep today's state: whatever was already marked read stays read for every staff member who could
-- see it (owner: all branches; others: business-wide notices and their own branch; addressed ones:
-- only the addressee).
insert into public.vendor_notification_reads (notification_id, staff_id)
select vn.id, s.id
from public.vendor_notifications vn
join public.staff s on s.business_id = vn.business_id
where vn.read
  and (vn.staff_id is null or vn.staff_id = s.id)
  and (vn.branch_id is null or s.role = 'owner' or s.branch_id = vn.branch_id)
on conflict do nothing;

commit;
