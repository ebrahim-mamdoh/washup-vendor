import "server-only";

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
 * Keep `max` small (2–3) so many Vercel instances do not exhaust Supavisor's
 * session pool. Override with DATABASE_POOL_MAX if needed.
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
    max: Number(process.env.DATABASE_POOL_MAX) || 3,
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

export function db(): Sql {
  const g = globalThis as GlobalWithSql;
  g[GLOBAL_KEY] ??= connect();
  return g[GLOBAL_KEY];
}

/** A connection or an open transaction — repositories accept either. */
export type Q = Sql | postgres.TransactionSql;

/** Runs `fn` in one transaction (all writes of a request commit or roll back together). */
export function tx<T>(fn: (t: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return db().begin(fn) as Promise<T>;
}

/**
 * ISO timestamp for values built inside json_build_object/json_agg (those bypass
 * the type parsers above), in the exact `toISOString()` format the API returns.
 */
export const ISO = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
