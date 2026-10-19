/**
 * Starts this app's production build for QA in a given data-source mode.
 *
 *   node qa/local/start.mjs mock 3300
 *   node qa/local/start.mjs pg 3301     # needs the local Postgres (54329) + qa/local/fake-auth.mjs (54400)
 *
 * Run `npm run build` first. The local Postgres comes from the carZone repo:
 * `npm run db:local` there (migrations + a seed for today, in-memory).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode = "mock", port = "3300"] = process.argv.slice(2);
const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = { ...process.env, MOCK_API_LATENCY: "0", NODE_ENV: "production" };
if (mode === "pg") {
  Object.assign(env, {
    CARZEN_DATA_SOURCE: "supabase",
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
    SUPABASE_URL: "http://127.0.0.1:54400",
    SUPABASE_PUBLISHABLE_KEY: "local-qa-key",
  });
} else env.CARZEN_DATA_SOURCE = "mock";
const child = spawn(process.execPath, [path.join(app, "node_modules", "next", "dist", "bin", "next"), "start", "--port", port], { cwd: app, env, stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
