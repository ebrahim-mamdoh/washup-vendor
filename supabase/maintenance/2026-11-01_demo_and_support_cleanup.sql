-- One-off production cleanup. Review the counts, then run in the SQL editor.
-- Does NOT delete Auth users automatically; disable admin_users rows and
-- deactivate staff with @carzen.demo emails if they exist.

begin;

update public.admin_users
set status = 'suspended'
where email ilike '%@carzen.demo';

update public.platform_settings
set value = jsonb_set(
  jsonb_set(
    jsonb_set(coalesce(value, '{}'::jsonb), '{platformName}', '"Wash Up"'),
    '{supportEmail}', '"support@washup.app"'
  ),
  '{supportPhone}', '"+20 150 000 1111"'
)
where key = 'general';

delete from public.transactions t
using public.orders o
where t.order_id = o.id and t.status = 'pending' and o.status not in ('completed');

select
  (select count(*) from public.admin_users where email ilike '%@carzen.demo' and status = 'suspended') as demo_admins_suspended,
  (select value ->> 'platformName' from public.platform_settings where key = 'general') as platform_name,
  (select count(*) from public.transactions t join public.orders o on o.id = t.order_id
    where t.status = 'pending' and o.status not in ('completed')) as leftover_pending_txns;

commit;
