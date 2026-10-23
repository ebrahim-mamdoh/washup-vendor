# Handoff — where the work stopped (2026-10-19)

> Read this first in a new Claude session. Reply to the owner **in Arabic** (Egyptian; owner's latest request).
> Don't commit or push unless the owner asks. Confirm with the owner before destructive SQL.

## 1. Repositories

| Repo | Local path | Branch / state | What it is |
|------|-----------|----------------|------------|
| **washup-vendor** (active) | `C:\Users\Royal\Desktop\washup\vendor` | `dev`, last pushed commit `8c21ec2`. **Uncommitted:** `.gitignore`, `.mcp.json`, `CLAUDE.md`, `docs/` (this file + QA report), `qa/` (QA toolkit) | The Carzen Partners vendor portal as a **standalone** Next.js 16 app (split from carZone `vendor-portal/` + `packages/*` at `547e7ba`) |
| **washup-superadmin** | `C:\Users\Royal\Desktop\washup\super-admin` | `main`, `a1db3e2`, clean | ⚠️ An **old** super-admin (identical to carZone commit `0e9fb70`). It has none of the later work: no shared packages, no vendor integration, no Supabase data source. If it should match, redo it the same way the vendor was split (see §2). Decision pending with the owner |
| **carZone** (original monorepo) | `D:\Project Analysis` | `ebrahim`, pushed `547e7ba`. **Uncommitted (another session):** `.mcp.json` switched to read & write, plus doc updates in `CLAUDE.md`, `docs/DECISIONS.md`, `supabase/README.md` | Source of everything: both apps, `packages/*`, **`supabase/` (migrations, seed, scripts)**, the vanilla demos. Schema changes still start in `supabase/migrations/` here |

## 2. How the vendor repo is laid out (standalone)
- `types/`: API contracts, formerly `@carzen/contracts`, imported as `@/types/<file>`.
- Design system, formerly `@carzen/ui`: `components/ui`, `components/shared`, `hooks/`, `lib/` (`utils`, `format`, `export-csv`, `constants/labels`) and `styles/theme.css`.
- `server/platform-api/`: the API, formerly `@carzen/platform-api`. Served by `app/api/v1/[...path]/route.ts`.
  - `vendor/*` + `handlers/*`: mock implementation (store in `.carzen/platform-db.json`, git-ignored).
  - `pg/*`: the Supabase Postgres implementation, enabled with `CARZEN_DATA_SOURCE=supabase` + `DATABASE_URL` + `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` (see `.env.example`). The order engine is `pg/vendor/engine.ts`. **Every vendor route exists in both implementations: change both.**
  - It still contains and serves the **admin** namespace (`/api/v1/admin/*`). Removing it is finding M1.
- Full description: `PROJECT_SUMMARY.md`.

## 3. Supabase project `tbcmgdwzarfdgzzmmele` (checked read-only on 2026-10-19)
- All 8 migrations are applied and the demo seed is loaded (1080 orders), dated around 2026-10-15, so "today" screens are nearly empty.
- **Blocker C1:** `staff.user_id` and `admin_users.user_id` are linked for **0** rows, and `auth.users` has 2 users. Nobody can sign in on the Supabase data source. Fix: run `npm run db:users:demo` from carZone (needs the service role key in `supabase/.env`), or build invitations.
- **Blocker C2:** someone added RLS policies and grants for the customer mobile app **outside the repo migrations**. Signed-in customers can INSERT/UPDATE `orders` and INSERT `order_items`/`order_events`/`complaints`/`reviews` directly through the Data API, which bypasses pricing and the order state machine. There are also SECURITY DEFINER functions (`current_customer_id`, `sync_customer_profile`) executable by `anon`, SECURITY DEFINER views (`app_health`, `branch_shares`), and 13 `legacy_*` tables with "public write" policies (no grants right now). Leaked-password protection is off, and 25 foreign keys have no index.
- The MCP is now read & write (`.mcp.json` in both repos). Each session must authorize it once (`/mcp` in an interactive `claude` terminal). The mobile-app developer uses the same project, so be careful.

## 4. QA done on 2026-10-19
Full report: **`docs/QA_REPORT_2026-10-19.md`**, with every finding, severity, file location, suggested fix and perf numbers.

- **API suite:** 146 cases per mode. Supabase: 117 pass / 26 fail / 3 skip. Mock: 111 / 33 / 2.
- **UI walkthrough:** 21 screens, owner and manager. Everything renders; no JavaScript errors and no 5xx.
- **Performance:**
  - k6 at 30 VUs: 0% errors, p95 383 ms on the local Postgres.
  - k6 at 100 VUs: 0% errors, p95 2.5 s (the bottleneck is the local single-threaded DB).
  - The slowest endpoint is `/vendor/dashboard?period=30d`. 35–66% of its CPU time goes to `new Date()`, which Next 16 wraps.
- **clinic.js** does not run on this Windows machine (every tool exits 0 with no output, on Node 24 and on Node 20). `node --cpu-prof` and `qa/perf/analyze-cpuprofile.mjs` were used instead.

**Top fixes, in order** (IDs from the report):
1. C1 link accounts.
2. C2 lock down customer writes, and move all hosted-only policies into migrations.
3. H1 discount stacking past the cap (`performAction` "discount" in both engines).
4. H6 `recognize()` leaks any platform customer and its `statusReason`.
5. H3 timezone: day math uses the server-local time; set `TZ=Africa/Cairo` and use Cairo day helpers.
6. H4 demo data appears "in the future" in Supabase mode, and goes stale.
7. H5 mobile header overflow (`portal-topbar.tsx`).
8. H2 no login rate limit.
9. Then the M-list: admin API exposed, a manager can grant permissions he lacks, `maxAdvanceDays` not enforced, 500s on malformed input, day closing accepts future dates, inconsistent KPIs, client-side allowed actions, raw audit values, missing security headers, dashboard performance, no token refresh.

Known data issues from the seed (fix in carZone `supabase/scripts/generate-seed.ts`):
- payout dates are one day early;
- landline phones are mis-formatted;
- admin authors on order notes are lost;
- reported reviews have reportReason "—".

## 5. How to re-run the QA (see `qa/README.md`)
1. **Mock mode:** `npm run build`, then `node qa/local/start.mjs mock 3300`.
2. **Supabase mode on a local Postgres (no Docker):**
   1. In carZone, run `npm run db:local` (port 54329; the migrations live there).
   2. Here, run `node qa/local/fake-auth.mjs`. It is a Supabase Auth stand-in on 54400 that links every staff and admin.
   3. Run `node qa/local/start.mjs pg 3301`.
3. **Run the suites:**
   - `node qa/api/run.mjs --base http://localhost:3301`, then `node qa/api/compare.mjs`.
   - `k6 run -e BASE=http://localhost:3301 -e PROFILE=load qa/perf/k6-vendor.js`. k6 is not installed system-wide; install it from grafana.com.
   - `node qa/perf/autocannon.mjs --base …`. Needs autocannon installed.
   - CPU profile with `qa/perf/server.mjs` + `node --cpu-prof`.
4. **Compare mock vs Postgres:** `supabase/scripts/api-parity.mjs` in carZone, with `MOCK_URL`/`PG_URL` set.

## 6. Open decisions for the owner
1. Commit and push the QA report and toolkit to `washup-vendor` `dev`. It was asked, but no answer yet.
2. Bring `washup-superadmin` up to date: today it's the old version.
3. Start the fix phase in the order above. A proposed seed-fix task also exists: payout dates, landline phones, admin note authors, reportReason.
4. Whether to commit carZone's uncommitted MCP and doc changes.
