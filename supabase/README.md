# Supabase — the schema lives in the customer-app repo

Since 2026-11-26 (GAP-007) the **only** schema history of the shared database (project `tbcmgdwzarfdgzzmmele`) is
`supabase/migrations/` in the customer-app repo (`mobile-app/mobile-client` in the monorepo). It starts with a
verified baseline of the live schema (`20261127120000_baseline_production_schema.sql`). Read its
`supabase/README.md` before any database change; do not add migrations here.

What moved there (unchanged, history only): every file of this repo's old `supabase/migrations/` →
`supabase/migrations_archive/panels/`; the pending `20261118120000_private_application_documents.sql` →
`supabase/migrations/20261127130000_application_documents_bucket.sql` (not applied yet); the GAP-027 test
`20261127110000_vendor_panel_tenant_role.test.sql` → `supabase/tests/`. `apply-migrations.mjs` was removed
(use `supabase db push`, or the SQL editor + a `schema_migrations` row, as described there).

What stays here:

| File | Purpose |
|------|---------|
| `set-panel-push-secrets.mjs` | Stores the panels' push URLs / secret in Vault (`panel_push_*`) |
| `maintenance/*.sql` | One-off demo-data cleanups — reviewed scripts, not migrations; run only on purpose |

The portal code that needs schema objects: a new table or column the vendor API writes needs a GRANT + policy for
`washup_vendor_panel` in a migration there (GAP-027, see `PROJECT_SUMMARY.md` "Database tenant role").

Rollback-only scenario check against the live database: `node qa/api-check/integration-db.mjs` (add
`--with-migrations <path/to/file.sql> …` to test pending migration files inside the same rolled-back transaction).
