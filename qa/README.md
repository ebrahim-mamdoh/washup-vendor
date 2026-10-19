# QA toolkit (vendor portal)

Everything here runs against a **running** vendor app (`npm run build && npm start`, or the dev server).
Results from the 2026-10-19 run are summarised in `docs/QA_REPORT_2026-10-19.md`.

| What | Command | Notes |
|------|---------|-------|
| Start the app for QA | `node qa/local/start.mjs mock 3300` · `node qa/local/start.mjs pg 3301` | After `npm run build`. `pg` needs the local Postgres (`npm run db:local` in the carZone repo, port 54329) and `node qa/local/fake-auth.mjs` (Supabase Auth stand-in, port 54400, links every staff/admin, password demo1234). |
| Functional + security API suite (146 cases) | `node qa/api/run.mjs --base http://localhost:3200` | `--only auth,authz,orders,pricing,catalog,team,suspend,dayclose,robust,security,smoke`, `--verbose`, `--no-bruteforce`. Writes `qa/api/results-<mode>.json`; exit code 1 on failures. It creates QA orders/customers and restores settings; run it on demo data only. |
| Compare two modes | `node qa/api/compare.mjs` | Diffs `results-mock.json` vs `results-supabase.json`. |
| Endpoint benchmark (autocannon) | `AUTOCANNON_HOME=<folder with autocannon installed> node qa/perf/autocannon.mjs --base http://localhost:3200 --connections 20 --duration 10 --out qa/perf/results/autocannon.json` | Install once: `npm i -g autocannon` or into any folder. |
| Load / stress (k6) | `k6 run -e BASE=http://localhost:3200 -e PROFILE=load qa/perf/k6-vendor.js` | `PROFILE=smoke` (1 VU), `load` (→30 VUs + walk-in orders), `stress` (→100 VUs). Install k6 from https://grafana.com/docs/k6/latest/set-up/install-k6/. |
| CPU profile | `PORT=3302 EXIT_AFTER_MS=50000 node --cpu-prof --cpu-prof-dir=qa/perf/results/cpuprofile qa/perf/server.mjs`, load it (autocannon/k6), then `node qa/perf/analyze-cpuprofile.mjs qa/perf/results/cpuprofile/*.cpuprofile 25 15 35` | The `.cpuprofile` also opens in Chrome DevTools → Performance. `qa/perf/server.mjs` is a single-process server for clinic.js too (clinic did not run on Windows in our test; see the report). |

Supabase data source: set `CARZEN_DATA_SOURCE=supabase`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (see `.env.example`). Never run the mutating suites against production data.
