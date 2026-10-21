# API checks (vendor portal)

End-to-end checks against a running portal (`npm run build && npm start`, or `npm run dev`), on either data
source. Plain Node 20+ scripts, no dependencies. Each prints `PASS`/`FAIL` lines and a total.

| Script | What it covers | Writes |
|--------|----------------|--------|
| `robustness.mjs` | Malformed ids/sort keys/dates/NUL bytes answer 4xx (never 500), admin namespace hidden, recognition privacy, validation (hours, slot length, prefs, schedules, future day closing, booking window), discount cap, manager permission cap, security headers, login throttle (`--throttle`) | a cancelled walk-in, one test employee |
| `flows.mjs` | Every screen's GET, then a full walk-in lifecycle (add-on, note, discount, assign, start, complete, cash collect, refund), phone booking + cancel, block/unblock, notifications, unchanged saves | test orders/offer (marked QA) |
| `walk-in-no-phone.mjs` | A walk-in without a customer through payment (needs the `order_notification_skip_anonymous` migration) | one refunded order |
| `latency-and-refresh.mjs` | Median latency of the heaviest endpoints; session refresh (rotating refresh token, garbage token → 401) | — |

```bash
node qa/api-check/robustness.mjs http://localhost:3200 01200000000 demo1234 01005550102 demo1234
node qa/api-check/flows.mjs http://localhost:3200 01200000000 demo1234 01005550102 demo1234
node qa/api-check/walk-in-no-phone.mjs http://localhost:3200 01005550102 demo1234
node qa/api-check/latency-and-refresh.mjs http://localhost:3200
```

Cross-app checks (Super Admin ↔ portal) live in `washup-superadmin/qa/api-check/`.
Run the writing scripts against demo data only: they create clearly marked QA records (plates `QA…`,
customer `اختبار QA`, phone `+20 109 999 0001`).
