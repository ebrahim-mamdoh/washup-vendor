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

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (required when CARZEN_DATA_SOURCE=supabase)");
  return postgres(url, {
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    // Use the session pooler (port 5432): with the transaction pooler, a request running
    // more parallel queries than connections (the admin dashboard) can hang for good.
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idle_timeout: 20,
    connect_timeout: 15,
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
