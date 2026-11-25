-- GAP-014 + GAP-025 (system audit, 2026-11-25). Applied to tbcmgdwzarfdgzzmmele through the SQL editor
-- by the lead auditor with the owner's authorisation; recorded in schema_migrations.
--
-- Surgical edits of the LIVE function bodies (the repo has several diverging copies of these
-- functions — GAP-007 — so the live definition is patched in place instead of re-creating an older
-- file's version):
-- - get_branch_slots: no slots for a business that is not live (suspended / not yet active), and the
--   anonymous caller can no longer ask for absurd durations (CPU amplification): 1–720 minutes.
-- - reschedule_order: an existing booking cannot be moved into a suspended wash or an inactive
--   branch (raises the existing app error key `branch_unavailable`).
-- Each edit fails loudly if its anchor is missing, so nothing is half-applied.

begin;

do $do$
declare
  d text;
  n text;
begin
  d := pg_get_functiondef('public.get_branch_slots(text,date,integer,text,boolean)'::regprocedure);
  n := regexp_replace(
    d,
    '(IF\s+NOT\s+FOUND\s+OR\s+NOT\s+v_branch\.active\s+THEN\s+RETURN;\s+END\s+IF;)',
    E'\\1\n  -- GAP-014 / GAP-025 (2026-11-25): only live businesses, sane durations.\n  IF NOT public.is_business_live(v_branch.business_id) THEN RETURN; END IF;\n  IF p_duration IS NULL OR p_duration < 1 OR p_duration > 720 THEN RETURN; END IF;',
    'i');
  if n = d then raise exception 'get_branch_slots: anchor not found'; end if;
  execute n;

  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'reschedule_order';
  n := regexp_replace(
    d,
    '(select\s+\*\s+into\s+v_branch\s+from\s+public\.branches\s+where\s+id\s*=\s*v_order\.branch_id;)',
    E'\\1\n  -- GAP-014 (2026-11-25): no moves into a suspended wash or an inactive branch.\n  if not v_branch.active or not public.is_business_live(v_branch.business_id) then\n    raise exception ''branch_unavailable'';\n  end if;',
    'i');
  if n = d then raise exception 'reschedule_order: anchor not found'; end if;
  execute n;
end
$do$;

commit;
