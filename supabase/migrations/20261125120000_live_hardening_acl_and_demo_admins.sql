-- Wave 1 / 2 live hardening (system audit, 2026-11-25). Applied to tbcmgdwzarfdgzzmmele through the
-- SQL editor by the lead auditor with the owner's authorisation; recorded in schema_migrations.
--
-- GAP-024: helper functions were EXECUTE-able by `anon`, so anyone could burn order numbers and
-- complaint tickets through the REST API. `anon` never inserts rows (it only has SELECT grants), so
-- it needs none of them. `authenticated` keeps gen_id / next_complaint_ticket because they are
-- column defaults of rows the customer app inserts (customers, vehicles, reviews, complaints…);
-- next_order_number / gen_check_in_code are only used by SECURITY DEFINER create_order (owner
-- postgres) and the panels (postgres), so app roles lose them entirely. service_role keeps all.
--
-- GAP-002: demo admin rows (@carzen.demo) have no Auth login on production, but they stay
-- "active" in admin_users; deactivate them (the enum is active|inactive).

begin;

revoke execute on function public.next_order_number(public.order_source) from anon, authenticated;
revoke execute on function public.gen_check_in_code() from anon, authenticated;
revoke execute on function public.gen_id(text) from anon;
revoke execute on function public.next_complaint_ticket() from anon;

update public.admin_users set status = 'inactive'
where email ilike '%@carzen.demo' and status = 'active' and user_id is null;

commit;
