#!/usr/bin/env node
/**
 * Shared-code drift check (GAP-054).
 *
 * The Super Admin (`washup-superadmin`) and the partner portal (`washup-vendor`) still carry copies
 * of the same core: UI kit, lib helpers, API contracts (`types/`) and the namespace-agnostic parts of
 * `server/platform-api/` (each app serves only its own namespace). Until that core becomes one
 * package, every change to it must be made in BOTH repos. This script lists what has drifted apart.
 * It is itself shared: the same file lives in both repos.
 *
 *   node scripts/shared-drift.mjs [siblingRepo] [--verbose]
 *   npm run check:shared        # sibling: ../vendor from the Super Admin, ../super-admin from the portal
 *
 * Exit code: 0 = no drift, 1 = drift found, 2 = sibling repo not found.
 *
 * Two kinds of entries:
 * - FILES: must be byte-identical (line endings ignored).
 * - SYMBOLS: files that also hold app-only code. Each named declaration is compared on its own
 *   (leading comments and trailing spaces ignored); `symbols: "common"` compares every top-level
 *   declaration that exists in both files. App-specific behaviour belongs in an app-only file or
 *   declaration, never in a differing copy of a shared one.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── What must stay identical ─────────────────────────────────

const UI = [
  "alert-dialog", "avatar", "badge", "button", "card", "checkbox", "command", "dialog", "dropdown-menu", "field",
  "input", "input-group", "label", "popover", "progress", "scroll-area", "select", "separator", "sheet", "skeleton",
  "sonner", "switch", "table", "tabs", "textarea", "tooltip",
].map((n) => `components/ui/${n}.tsx`);

const SHARED_COMPONENTS = [
  "audit-trail", "brand-logo", "data-table", "export-csv-button", "filter-tabs", "info-list", "kpi-card",
  "list-toolbar", "order-timeline", "page-header", "rating-stars", "reason-dialog", "search-input", "section-card",
  "select-filter", "sparkline", "states", "stat-tile", "status-badge", "table-pagination", "theme-toggle", "user-avatar",
].map((n) => `components/shared/${n}.tsx`);

const TYPES = [
  "admins", "applications", "audit", "auth", "common", "complaints", "customers", "dashboard", "finance",
  "notifications", "offers", "orders", "reviews", "search", "settings", "washes",
].map((n) => `types/${n}.ts`);

/** Byte-identical files (paths are the same in both repos). */
export const FILES = [
  ...UI,
  ...SHARED_COMPONENTS,
  "components/shared/layout/push-toggle.tsx",
  "components/shared/maps/google-map.tsx",
  "components/shared/maps/google-map-utils.ts",
  "components/shared/maps/lazy.tsx",
  "components/providers/query-provider.tsx",
  "components/providers/firebase-analytics.tsx",
  "hooks/use-debounced-value.ts",
  "hooks/use-url-state.ts",
  "hooks/use-web-push.ts",
  "lib/utils.ts",
  "lib/format.ts",
  "lib/export-csv.ts",
  "lib/api/request.ts",
  "lib/api/api-error-handler.ts",
  "lib/cache/ttl.ts",
  "lib/config/api-base-url.ts",
  "lib/firebase/analytics.ts",
  "lib/firebase/client.ts",
  "lib/firebase/config.ts",
  "scripts/shared-drift.mjs",
  "styles/theme.css",
  ...TYPES,
  "types/react-query.d.ts",
  // Mock store: both apps read and write the same `.carzen/platform-db.json`.
  "server/platform-api/db.ts",
  "server/platform-api/schema.ts",
  "server/platform-api/seed.ts",
  "server/platform-api/http.ts",
  "server/platform-api/lookups.ts",
  "server/platform-api/throttle.ts",
  // Helpers both namespaces use (GAP-054: moved out of the deleted dead namespaces).
  ...["cancel-reason", "geo", "notification-module", "notify", "phone", "time"].map((n) => `server/platform-api/shared/${n}.ts`),
  // Postgres plumbing and entity mappers (one database for both apps).
  "server/platform-api/pg/sql.ts",
  "server/platform-api/pg/list.ts",
  "server/platform-api/pg/fcm.ts",
  "server/platform-api/pg/entities.ts",
  "server/platform-api/pg/push.ts",
];

/** Declaration-level comparisons. `there` may list several files (first one holding the symbol wins). */
export const SYMBOLS = [
  // Vendor record types kept for the mock store / wash inbox.
  { here: "types/vendor/catalog.ts", symbols: "common" },
  { here: "types/vendor/insights.ts", symbols: "common" },
  { here: "types/vendor/team.ts", symbols: "common" },
  // Files that also hold app-specific code: their common declarations must match.
  { here: "lib/constants/labels.ts", symbols: "common" },
  { here: "server/platform-api/router.ts", symbols: "common" },
  { here: "server/platform-api/pg/auth.ts", symbols: "common" },
  { here: "server/platform-api/pg/lookups.ts", symbols: "common" },
  { here: "server/platform-api/pg/platform.ts", symbols: "common" },
  { here: "server/platform-api/pg/router.ts", symbols: "common" },
];

// ── Comparison ───────────────────────────────────────────────

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n") : null);

const DECL = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const BOUNDARY = /^(?:import\b|export\s*\{|export\s+\*|\/\*|\/\/)/;

/** Top-level declarations → their source text (without leading comments, trailing spaces trimmed). */
export function declarations(source) {
  const lines = source.split("\n");
  const out = new Map();
  let current = null;
  const close = () => {
    if (!current) return;
    while (current.lines.length && !current.lines.at(-1).trim()) current.lines.pop();
    out.set(current.name, current.lines.map((l) => l.replace(/\s+$/, "")).join("\n"));
    current = null;
  };
  for (const line of lines) {
    const m = DECL.exec(line);
    if (m) {
      close();
      current = { name: m[1], lines: [line] };
    } else if (BOUNDARY.test(line)) {
      close();
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  return out;
}

function firstDifference(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return i + 1;
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const siblingArg = args.find((a) => !a.startsWith("--"));
  const ownName = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
  const sibling = path.resolve(ROOT, siblingArg ?? (ownName === "carzen-super-admin" ? "../vendor" : "../super-admin"));
  if (!existsSync(path.join(sibling, "package.json"))) {
    console.error(`shared-drift: sibling repo not found at ${sibling}`);
    process.exit(2);
  }

  const drift = [];
  let checked = 0;

  for (const rel of FILES) {
    checked += 1;
    const here = read(path.join(ROOT, rel));
    const there = read(path.join(sibling, rel));
    if (here === null || there === null) drift.push(`${rel}  (missing ${here === null ? "here" : "in sibling"})`);
    else if (here !== there) drift.push(`${rel}  (first difference at line ${firstDifference(here, there)})`);
  }

  for (const entry of SYMBOLS) {
    checked += 1;
    const hereSrc = read(path.join(ROOT, entry.here));
    const thereFiles = [entry.there ?? entry.here].flat();
    const thereSrcs = thereFiles.map((f) => ({ f, src: read(path.join(sibling, f)) })).filter((x) => x.src !== null);
    if (hereSrc === null || !thereSrcs.length) {
      drift.push(`${entry.here}  (missing ${hereSrc === null ? "here" : `in sibling: ${thereFiles.join(", ")}`})`);
      continue;
    }
    const ours = declarations(hereSrc);
    const theirs = thereSrcs.map((x) => ({ f: x.f, decls: declarations(x.src) }));
    const names = entry.symbols === "common" ? [...ours.keys()].filter((n) => theirs.some((t) => t.decls.has(n))) : entry.symbols;
    const bad = [];
    for (const name of names) {
      const mine = ours.get(name);
      const other = theirs.find((t) => t.decls.has(name));
      if (mine === undefined) bad.push(`${name} (missing here)`);
      else if (!other) bad.push(`${name} (missing in sibling)`);
      else if (mine !== other.decls.get(name)) bad.push(name);
    }
    const label = entry.there ? `${entry.here} ↔ ${thereFiles.join(" | ")}` : entry.here;
    if (bad.length) drift.push(`${label}  [${bad.join(", ")}]`);
    else if (verbose) console.log(`ok  ${label}  (${names.length} declarations)`);
  }

  if (!drift.length) {
    console.log(`shared-drift: ${checked} shared entries identical with ${sibling}`);
    return;
  }
  console.log(`shared-drift: ${drift.length} of ${checked} shared entries differ from ${sibling}:`);
  for (const d of drift) console.log(`  - ${d}`);
  console.log("Shared code must change in both repos (see PROJECT_SUMMARY.md, \"Shared code\").");
  process.exitCode = 1;
}

main();
