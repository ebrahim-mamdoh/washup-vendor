import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import postgres from "postgres";

/**
 * Postgres connection for the Supabase data source (CARZEN_DATA_SOURCE=supabase).
 *
 * The API talks to the database directly, server-side only, through Supabase's
 * connection pooler (DATABASE_URL). That gives real multi-table transactions and
 * no row caps, and it is the same path a Laravel API will use on this database.
 * Created lazily so the mock data source never needs a DATABASE_URL.
 *
 * Value parsing matches the API contracts: numeric → number, timestamptz → ISO
 * string (`toISOString()` format), date → "YYYY-MM-DD", time → "HH:MM".
 */
type Sql = postgres.Sql;
const GLOBAL_KEY = "__CARZEN_PG__";
type GlobalWithSql = typeof globalThis & { [GLOBAL_KEY]?: Sql };

/**
 * Session mode (pooler port 5432) keeps a Postgres backend for the life of the
 * client, which postgres.js needs for parallel queries (`Promise.all`) on one
 * connection. Transaction mode (6543) returns the backend after the first query
 * and leaves later ones hanging in ClientRead.
 *
 * Supavisor's session pool is shared by every instance of both panels (15
 * clients on this project), and one dashboard load fans out to ~6 parallel
 * requests that Vercel may spread over several instances. So each instance
 * holds ONE connection by default; postgres.js queues parallel queries on it.
 * Raise DATABASE_POOL_MAX only if the Supabase pool size is raised too.
 */
function poolerUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith(".pooler.supabase.com") && url.port === "6543") {
      url.port = "5432";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (required when CARZEN_DATA_SOURCE=supabase)");
  return postgres(poolerUrl(url), {
    prepare: false,
    // fetch_types must stay enabled: with it false, JS arrays are sent as text
    // and Postgres rejects them (`22P02 malformed array literal` → 422).
    max: Number(process.env.DATABASE_POOL_MAX) || 1,
    idle_timeout: 10,
    connect_timeout: 15,
    max_lifetime: 60 * 5,
    connection: {
      // Kill stuck statements so a bad connection is not held forever under max.
      statement_timeout: 15_000,
    },
    transform: { undefined: null },
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
      timestamptz: {
        to: 1184,
        from: [1184],
        serialize: (v: string | Date) => (v instanceof Date ? v.toISOString() : v),
        parse: (v: string) => new Date(v).toISOString(),
      },
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
      time: {
        to: 1083,
        from: [1083],
        serialize: (v: string) => v,
        parse: (v: string) => v.slice(0, 5),
      },
    },
  }) as unknown as Sql;
}

function pool(): Sql {
  const g = globalThis as GlobalWithSql;
  g[GLOBAL_KEY] ??= connect();
  return g[GLOBAL_KEY];
}

/**
 * GAP-027 tenant scope. With `CARZEN_DB_TENANT_ROLE=1` each vendor request runs in ONE transaction
 * that switched to the RLS-bound role `washup_vendor_panel` (see `withTenantScope` and
 * `pg/vendor/tenant.ts`). While that transaction is open, `db()` returns it and `tx()` opens a
 * savepoint in it, so handler code is unchanged. Without the flag nothing here is used.
 */
type TenantScope = { sql: postgres.TransactionSql | null; open: boolean };
const SCOPE_KEY = "__CARZEN_PG_TENANT_SCOPE__";
type GlobalWithScope = typeof globalThis & { [SCOPE_KEY]?: AsyncLocalStorage<TenantScope> };

function scopes(): AsyncLocalStorage<TenantScope> {
  const g = globalThis as GlobalWithScope;
  g[SCOPE_KEY] ??= new AsyncLocalStorage<TenantScope>();
  return g[SCOPE_KEY];
}

function openScope(): postgres.TransactionSql | null {
  if (!tenantRoleEnabled()) return null;
  const scope = scopes().getStore();
  return scope?.open ? scope.sql : null;
}

/** The database role vendor requests run as when the flag is on (migration 20261127110000). */
export const TENANT_ROLE = "washup_vendor_panel";

/** `CARZEN_DB_TENANT_ROLE=1` (default off): vendor requests run as `TENANT_ROLE` under RLS. */
export function tenantRoleEnabled(): boolean {
  return process.env.CARZEN_DB_TENANT_ROLE === "1";
}

/** True inside a request's tenant transaction. */
export function inTenantScope(): boolean {
  return openScope() !== null;
}

/**
 * Runs `fn` in one transaction and makes it the current request's database handle (`db()` / `tx()`)
 * until `fn` settles. Calls made after that (e.g. `after()` push delivery) get the pool again.
 */
export async function withTenantScope<T>(fn: (t: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await pool().begin(async (t) => {
    const scope: TenantScope = { sql: t, open: true };
    try {
      return await scopes().run(scope, () => fn(t));
    } finally {
      scope.open = false;
    }
  })) as T;
}

export function db(): Sql {
  const scoped = openScope();
  if (scoped) return scoped as unknown as Sql;
  return pool();
}

/** A connection or an open transaction — repositories accept either. */
export type Q = Sql | postgres.TransactionSql;

/** Runs `fn` in one transaction (all writes of a request commit or roll back together). */
export function tx<T>(fn: (t: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const scoped = openScope();
  if (scoped) return scoped.savepoint(fn) as Promise<T>;
  return pool().begin(fn) as Promise<T>;
}

/**
 * For a statement whose failure the caller catches and recovers from: inside a tenant transaction
 * it runs in a savepoint, so the failure does not abort the request's transaction. Outside one it
 * is exactly `fn(q)`.
 */
export function guarded<T>(q: Q, fn: (q: Q) => Promise<T>): Promise<T> {
  if (inTenantScope() && "savepoint" in q) return q.savepoint((s) => fn(s)) as Promise<T>;
  return fn(q);
}

/**
 * ISO timestamp for values built inside json_build_object/json_agg (those bypass
 * the type parsers above), in the exact `toISOString()` format the API returns.
 */
export const ISO = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
