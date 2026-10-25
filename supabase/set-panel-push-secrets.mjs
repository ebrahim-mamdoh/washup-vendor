// Creates (or updates) the three Vault secrets the panel_push() trigger function reads:
//   panel_push_vendor_url, panel_push_admin_url, panel_push_secret (= PUSH_WEBHOOK_SECRET from .env).
// Usage: node supabase/set-panel-push-secrets.mjs [vendorBaseUrl] [adminBaseUrl]
// Never prints the secret.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
);
const vendor = (process.argv[2] ?? "https://washup-vendor.vercel.app").replace(/\/$/, "");
const admin = (process.argv[3] ?? "https://washup-superadmin.vercel.app").replace(/\/$/, "");
if (!env.PUSH_WEBHOOK_SECRET) throw new Error("PUSH_WEBHOOK_SECRET missing in .env");

const secrets = {
  panel_push_vendor_url: `${vendor}/api/v1/vendor/push/hook`,
  panel_push_admin_url: `${admin}/api/v1/admin/push/hook`,
  panel_push_secret: env.PUSH_WEBHOOK_SECRET,
};

const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
try {
  for (const [name, value] of Object.entries(secrets)) {
    const [existing] = await sql`select id from vault.secrets where name = ${name}`;
    if (existing) await sql`select vault.update_secret(${existing.id}, ${value})`;
    else await sql`select vault.create_secret(${value}, ${name})`;
    console.log(`${existing ? "updated" : "created"} ${name}${name.endsWith("_url") ? ` = ${value}` : ""}`);
  }
} finally {
  await sql.end();
}
