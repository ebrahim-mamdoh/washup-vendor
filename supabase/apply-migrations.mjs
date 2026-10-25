// Applies migration files to the Supabase project in ONE transaction (all or nothing) and records each
// in supabase_migrations.schema_migrations, like `supabase db push` would. Skips versions already recorded.
// Usage: node supabase/apply-migrations.mjs <file.sql> [...more files]   (paths relative to supabase/migrations)
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
);
const files = process.argv.slice(2);
if (!files.length) throw new Error("pass migration file names");

const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
try {
  await sql.begin(async (t) => {
    const done = new Set((await t`select version from supabase_migrations.schema_migrations`).map((r) => r.version));
    for (const file of files) {
      const [, version, name] = file.match(/^(\d{14})_(.+)\.sql$/) ?? [];
      if (!version) throw new Error(`bad file name ${file}`);
      if (done.has(version)) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }
      const body = readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
      await t.unsafe(body);
      await t`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${name}, ${[body]})`;
      console.log(`applied ${file}`);
    }
  });
  console.log("committed");
} finally {
  await sql.end();
}
