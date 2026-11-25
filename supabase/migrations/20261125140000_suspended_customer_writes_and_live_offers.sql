-- GAP-028 + GAP-014 (system audit, 2026-11-25). Applied to tbcmgdwzarfdgzzmmele through the SQL editor
-- by the lead auditor with the owner's authorisation; recorded in schema_migrations.
--
-- GAP-028: a suspended customer could still write reviews, complaints, vehicles and favorites
-- (only the booking RPCs checked the status). Every customer WRITE policy that relied on
-- current_customer_id() now uses current_active_customer_id(), which is null for suspended
-- customers. Reads keep current_customer_id() (a suspended customer still sees their own data), and
-- delete_my_account (SECURITY DEFINER RPC) is unaffected.
--
-- GAP-014: offers of a suspended / not-yet-live wash were still readable by customers. Platform
-- offers (no business) stay visible.

begin;

create or replace function public.current_active_customer_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.customers c
  where c.user_id = (select auth.uid()) and c.status = 'active'
  limit 1
$$;
revoke all on function public.current_active_customer_id() from public, anon;
grant execute on function public.current_active_customer_id() to authenticated, service_role;

do $do$
declare
  r record;
  stmt text;
begin
  for r in
    select * from pg_policies
    where schemaname = 'public'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (coalesce(qual, '') || coalesce(with_check, '')) like '%current_customer_id()%'
  loop
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.qual is not null then
      stmt := stmt || ' using (' || replace(r.qual, 'current_customer_id()', 'current_active_customer_id()') || ')';
    end if;
    if r.with_check is not null then
      stmt := stmt || ' with check (' || replace(r.with_check, 'current_customer_id()', 'current_active_customer_id()') || ')';
    end if;
    execute stmt;
  end loop;
end
$do$;

alter policy "Public read active offers" on public.offers
  using (status = 'active'::public.offer_status and (business_id is null or public.is_business_live(business_id)));

commit;
