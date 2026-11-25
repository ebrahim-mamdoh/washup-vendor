-- APPLIED to tbcmgdwzarfdgzzmmele on 2026-11-26 by the lead (recorded as 20261126100100; renumbered from 20261126100000 to avoid colliding with super-admin admin_notification_reads).
--
-- GAP-072 (system audit). The per-person `editServices` permission was stored but never enforced:
-- a manager could edit services whenever the business switch `manager_can_edit_services` was on.
-- From vendor commit "GAP-072" on, a manager needs BOTH the business switch AND their own
-- `permissions.editServices`; flipping the switch in Settings sets every manager's flag.
--
-- Managers created before that change usually have `editServices = false` (the role default), so in
-- businesses where the switch is already ON they would lose service editing until the owner toggles
-- the switch off and on again. This one-time data sync keeps today's behaviour for them.
--
-- Data only, idempotent (re-running changes nothing). Read-only check first:
--   select count(*) from public.staff st
--   join public.business_settings bs on bs.business_id = st.business_id
--   where bs.manager_can_edit_services and st.role = 'manager'
--     and coalesce((st.permissions ->> 'editServices')::boolean, false) = false;

begin;

update public.staff st
set permissions = coalesce(st.permissions, '{}'::jsonb) || jsonb_build_object('editServices', true)
from public.business_settings bs
where bs.business_id = st.business_id
  and bs.manager_can_edit_services
  and st.role = 'manager'
  and coalesce((st.permissions ->> 'editServices')::boolean, false) = false;

commit;
