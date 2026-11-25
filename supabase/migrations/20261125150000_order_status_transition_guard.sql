-- GAP-023 (system audit, 2026-11-25). Applied to tbcmgdwzarfdgzzmmele through the SQL editor by the
-- lead auditor with the owner's authorisation; recorded in schema_migrations.
--
-- The order state machine lived only in application code (vendor engine, customer RPCs, cron). This
-- trigger is the database backstop: any status change outside the allowed graph is refused, whoever
-- writes it (panel bug, script, manual SQL). The graph was checked against every transition found in
-- the live order_events history and against close_stale_orders:
--   pending    → confirmed | cancelled | no_show
--   confirmed  → pending (customer reschedule) | waiting (check-in) | cancelled | no_show
--   waiting    → in_service | cancelled | no_show
--   in_service → completed | cancelled (recovery of a stuck order)
--   completed, cancelled, no_show are final (payment has its own column).

begin;

create or replace function public.guard_order_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status::text, new.status::text) in (
    ('pending', 'confirmed'), ('pending', 'cancelled'), ('pending', 'no_show'),
    ('confirmed', 'pending'), ('confirmed', 'waiting'), ('confirmed', 'cancelled'), ('confirmed', 'no_show'),
    ('waiting', 'in_service'), ('waiting', 'cancelled'), ('waiting', 'no_show'),
    ('in_service', 'completed'), ('in_service', 'cancelled')
  ) then
    return new;
  end if;
  raise exception 'invalid_status_transition: % -> %', old.status, new.status using errcode = 'P0001';
end
$$;

drop trigger if exists orders_status_transition on public.orders;
create trigger orders_status_transition
  before update of status on public.orders
  for each row execute function public.guard_order_status_transition();

commit;
