-- Lock the data-wiping helpers (2026-10-25).
--
-- reset_all_mock_data() truncates every business table (orders, branches, staff, services, offers…)
-- and clean_demo_auth_users() deletes auth users. Both are SECURITY DEFINER and were executable by
-- anon/authenticated, i.e. callable by anyone on the internet through /rest/v1/rpc/… without signing
-- in. They stay in the database for the owner (SQL editor / service role) but are no longer exposed.
revoke execute on function public.reset_all_mock_data() from public, anon, authenticated;
revoke execute on function public.clean_demo_auth_users() from public, anon, authenticated;
alter function public.reset_all_mock_data() set search_path = public;
alter function public.clean_demo_auth_users() set search_path = public;
