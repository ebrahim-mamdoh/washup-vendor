# Supabase changes from the panels (2026-10-20/21)

The schema's home is the carZone repo (`supabase/migrations/`). These files were written while hardening the
partner portal and the Super Admin, could not be committed there from this session, and must be **moved to
carZone** (same file names) so the repo matches the hosted project.

| File | Status on project `tbcmgdwzarfdgzzmmele` | Purpose |
|------|----------------------------------------|---------|
| `migrations/20261020120000_hosted_customer_app_objects.sql` | already there (captured, **do not run**) | Records the customer-app functions, policies, views, triggers and grants that were created on the hosted DB outside the repo |
| `migrations/20261020132053_order_notification_skip_anonymous.sql` | **applied** 2026-10-20 | Walk-ins without a customer no longer fail on the notification trigger |
| `migrations/20261021090000_customer_data_api_hardening.sql` | **to apply** (needs the mobile developer's OK) | Closes direct customer writes to orders/items/events, guards customers/reviews/complaints, fixes the `sync_customer_profile` account takeover, view/function rights, legacy write policies |
| `migrations/20261021091000_app_orders_commission_ledger.sql` | **to apply** | Commission ledger rows for customer-app orders (+ backfill of 18) |
| `migrations/20261021092000_foreign_key_indexes.sql` | **to apply** | Indexes for the 25 unindexed foreign keys |
| `migrations/20261021100000_panel_notifications.sql` | **to apply** (after creating 3 Vault secrets, see the file header) | Wash/admin notifications for customer-app bookings & cancellations, applications, complaints, pushed to the panels' browsers; `push_devices.app` accepts `admin` |
| `maintenance/2026-10-21_demo_data_cleanup.sql` | **to run once** (SQL editor) | Stale demo orders, branch landlines with an extra 0, placeholder report reasons |

All "to apply / to run" files were dry-run on the project inside a rolled-back transaction: no errors
(the notifications triggers were exercised with a simulated customer cancellation and application).

Apply in this order (SQL editor, or `supabase db push` from carZone after moving the files):
`20261021090000` → `20261021091000` → `20261021092000` → `20261021100000` → then the maintenance script.
