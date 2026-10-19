/**
 * Minimal Supabase Auth (GoTrue) stand-in for QA on the local Postgres: password
 * grant (email or phone), /user, /logout. Creates an auth.users row for every
 * admin and staff member and links profiles through user_id, like
 * `npm run db:users:demo` does on a hosted project. Password: demo1234.
 *
 *   node qa/local/fake-auth.mjs        (after the local Postgres is up; listens on 54400)
 */
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres", { prepare: false, max: 2 });
const PORT = Number(process.env.FAKE_AUTH_PORT ?? 54400);
const users = new Map(); // key (email | digits) -> uuid
const tokens = new Map(); // token -> { uuid, exp }
const digits = (p) => String(p ?? "").replace(/\D/g, "");

for (const table of ["admin_users", "staff"]) {
  const rows = await sql.unsafe(`select id, ${table === "staff" ? "phone" : "email"} as k, user_id from public.${table}`);
  for (const r of rows) {
    const id = r.user_id ?? randomUUID();
    if (!r.user_id) {
      await sql`insert into auth.users (id, ${sql(table === "staff" ? "phone" : "email")}) values (${id}, ${r.k}) on conflict do nothing`;
      await sql.unsafe(`update public.${table} set user_id = $1 where id = $2`, [id, r.id]);
    }
    users.set(table === "staff" ? digits(r.k) : String(r.k).toLowerCase(), id);
  }
}
console.log(`fake auth: ${users.size} users linked`);

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!req.headers.apikey) return send(res, 401, { message: "No API key found in request" });
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      let raw = "";
      for await (const c of req) raw += c;
      const b = JSON.parse(raw || "{}");
      const id = b.email ? users.get(String(b.email).toLowerCase()) : users.get(digits(b.phone));
      if (!id || b.password !== "demo1234") return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      const token = `fa_${randomBytes(24).toString("hex")}`;
      tokens.set(token, { id, exp: Date.now() + 3600_000 });
      return send(res, 200, { access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: "r", user: { id } });
    }
    const auth = req.headers.authorization?.replace(/^Bearer /i, "");
    const t = auth && tokens.get(auth);
    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      if (!t || t.exp < Date.now()) return send(res, 403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" });
      return send(res, 200, { id: t.id });
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/logout") {
      if (auth) tokens.delete(auth);
      return send(res, 204);
    }
    send(res, 404, { msg: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake auth on http://127.0.0.1:${PORT}`));
