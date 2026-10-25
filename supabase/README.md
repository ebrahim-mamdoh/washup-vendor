# Supabase changes from the panels

The schema's home is the carZone repo (`supabase/migrations/`). These files were written while hardening the
partner portal and the Super Admin and integrating them with the customer app; they must be **moved to
carZone** (same file names) so the repo matches the hosted project.

| File | Status on project `tbcmgdwzarfdgzzmmele` | Purpose |
|------|----------------------------------------|---------|
| `migrations/20261020120000_hosted_customer_app_objects.sql` | already there (captured, **do not run**) | Records the customer-app objects created on the hosted DB outside the repo |
| `migrations/20261020132053_order_notification_skip_anonymous.sql` | **applied** 2026-10-20 | Walk-ins without a customer no longer fail on the notification trigger |
| `migrations/20261021090000_customer_data_api_hardening.sql` | **applied** 2026-10-25 | The app can no longer edit orders/history directly (RPCs only); notifications: mark-as-read only; reviews only on completed orders, moderation stays; complaints open as "open"; no public writes on legacy tables. Checked against 4 days of the app's traffic. |
| `migrations/20261021091000_app_orders_commission_ledger.sql` | **applied** 2026-10-25 | Commission ledger row for every app order (+ backfill); any cancel/no-show drops the pending row |
| `migrations/20261021092000_foreign_key_indexes.sql` | **applied** 2026-10-25 | Indexes for 25 unindexed foreign keys |
| `migrations/20261025090000_booking_flow_fixes.sql` | **applied** 2026-10-25 | Manual confirmation for the script-made branches; only active washes listed/bookable; offer statuses follow their dates (cron every 5 min) and create_order uses the panels' offer rule; reschedule of a confirmed booking goes back to pending; accurate customer notifications |
| `migrations/20261021100000_panel_notifications.sql` | **applied** 2026-10-25 + Vault secrets created (set-panel-push-secrets.mjs) | Wash notified of app bookings, customer cancellations/reschedules, expired bookings; admins of complaints; pushed to the panels' browsers |
| `migrations/20261025100000_lock_reset_functions.sql` | **applied** 2026-10-25 | `reset_all_mock_data()` (truncates every table) and `clean_demo_auth_users()` were callable by anyone through the API; no longer exposed |
| `migrations/20261025110000_commission_rate_percent.sql` | **applied** 2026-10-25 | Rates stored as fractions by the account scripts (0.10 = meant 10%) converted to percent, ledger rows recomputed |
| `maintenance/2026-10-21_demo_data_cleanup.sql` | optional | Old demo data |

End-to-end check on the deployed panels: `VENDOR_PHONE=… VENDOR_PASSWORD=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node qa/api-check/e2e-booking.mjs`
(23/23 on 2026-10-25; writes one app booking, cancelled at the end, and a test offer, disabled at the end).

## Apply

All five "to apply" files were tested together in a rolled-back transaction with
`node qa/api-check/integration-db.mjs --with-migrations` (35/35 scenarios; the current database passes 10/33).

```bash
node supabase/apply-migrations.mjs 20261021090000_customer_data_api_hardening.sql 20261021091000_app_orders_commission_ledger.sql 20261021092000_foreign_key_indexes.sql 20261025090000_booking_flow_fixes.sql 20261021100000_panel_notifications.sql
node qa/api-check/integration-db.mjs
```

`apply-migrations.mjs` runs the files in one transaction (all or nothing) and records them in
`supabase_migrations.schema_migrations`. Run the scenarios again afterwards (without the flag) to check the live database.

Left for the mobile developer: `sync_customer_profile` still links an existing customer record by an unverified
phone (customers sign in by e-mail today); the fix needs phone OTP sign-in in the app first.
