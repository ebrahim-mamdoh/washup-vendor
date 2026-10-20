#!/usr/bin/env node
/**
 * db:users:demo — Create Supabase Auth accounts for demo staff & admins.
 *
 * Uses the Supabase Admin API (service_role key) to:
 * 1. Create an Auth user for each staff member (phone + password "demo1234")
 * 2. Create an Auth user for each admin (email + password "demo1234")
 * 3. Update staff.user_id / admin_users.user_id to link them
 *
 * Usage:  node scripts/db-users-demo.mjs
 * Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (reads from .env automatically via --env-file)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Load .env manually (Node 20 compat) ─────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "..", ".env");
try {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* no .env is fine */ }

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const PASSWORD = "demo1234";
const headers = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  "X-Client-Info": "supabase-js/2.0.0",
};

// ── Helpers ──────────────────────────────────────────────────
async function supabaseAdminCreateUser(userData) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...userData,
      password: PASSWORD,
      email_confirm: true,
      phone_confirm: true,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // If user already exists, try to find them
    if (body?.msg?.includes?.("already been registered") || body?.message?.includes?.("already been registered") ||
        body?.msg?.includes?.("already exists") || body?.message?.includes?.("already exists")) {
      return { existing: true, body };
    }
    return { error: true, status: res.status, body };
  }
  return { id: body.id, created: true };
}

async function supabaseAdminListUsers() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=100`, {
    headers,
  });
  if (!res.ok) throw new Error(`Failed to list users: ${res.status}`);
  const body = await res.json();
  return body.users || [];
}

async function restUpdate(table, id, data) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        ...headers,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error(`  ⚠️  Failed to update ${table}.${id}: ${res.status} ${text}`);
    return false;
  }
  return true;
}

async function restSelect(table, select = "*") {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`,
    { headers: { ...headers, "X-Client-Info": "supabase-js/2.0.0" } }
  );
  if (!res.ok) throw new Error(`Failed to query ${table}: ${res.status}`);
  return res.json();
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log("🔗 Connecting to Supabase:", SUPABASE_URL);
  console.log("🔑 Password for all demo accounts:", PASSWORD);
  console.log("");

  // 1. Fetch existing Auth users to avoid duplicates
  const existingUsers = await supabaseAdminListUsers();
  const phoneToUserId = new Map();
  const emailToUserId = new Map();
  for (const u of existingUsers) {
    if (u.phone) phoneToUserId.set(u.phone, u.id);
    if (u.email) emailToUserId.set(u.email, u.id);
  }
  console.log(`📋 Found ${existingUsers.length} existing Auth users\n`);

  // 2. Fetch staff
  const staff = await restSelect("staff", "id,name,phone,role,user_id");
  console.log(`👥 Staff: ${staff.length} members`);

  let created = 0, linked = 0, skipped = 0, errors = 0;

  for (const s of staff) {
    const label = `${s.name} (${s.role}, ${s.phone})`;

    // Already linked?
    if (s.user_id) {
      console.log(`  ✅ ${label} — already linked`);
      skipped++;
      continue;
    }

    // Check if Auth user already exists for this phone
    let userId = phoneToUserId.get(s.phone);

    if (!userId) {
      // Create Auth user
      const result = await supabaseAdminCreateUser({ phone: s.phone });
      if (result.created) {
        userId = result.id;
        console.log(`  🆕 ${label} — Auth user created`);
        created++;
      } else if (result.existing) {
        // Try to find by phone in existing users (refresh list)
        const refreshed = await supabaseAdminListUsers();
        const found = refreshed.find((u) => u.phone === s.phone);
        if (found) {
          userId = found.id;
          console.log(`  ♻️  ${label} — Auth user already existed`);
        } else {
          console.error(`  ❌ ${label} — user exists but couldn't find ID`);
          errors++;
          continue;
        }
      } else {
        console.error(`  ❌ ${label} — failed: ${JSON.stringify(result.body)}`);
        errors++;
        continue;
      }
    } else {
      console.log(`  ♻️  ${label} — Auth user already existed`);
    }

    // Link: update staff.user_id
    if (await restUpdate("staff", s.id, { user_id: userId })) {
      console.log(`  🔗 ${label} — linked (user_id = ${userId})`);
      linked++;
    } else {
      errors++;
    }
  }

  console.log(`\n📊 Staff results: ${created} created, ${linked} linked, ${skipped} skipped, ${errors} errors\n`);

  // 3. Fetch admin_users
  const admins = await restSelect("admin_users", "id,name,email,role,user_id");
  console.log(`🛡️  Admins: ${admins.length} users`);

  let aCreated = 0, aLinked = 0, aSkipped = 0, aErrors = 0;

  for (const a of admins) {
    const label = `${a.name} (${a.role}, ${a.email})`;

    if (a.user_id) {
      console.log(`  ✅ ${label} — already linked`);
      aSkipped++;
      continue;
    }

    let userId = emailToUserId.get(a.email);

    if (!userId) {
      const result = await supabaseAdminCreateUser({ email: a.email });
      if (result.created) {
        userId = result.id;
        console.log(`  🆕 ${label} — Auth user created`);
        aCreated++;
      } else if (result.existing) {
        const refreshed = await supabaseAdminListUsers();
        const found = refreshed.find((u) => u.email === a.email);
        if (found) {
          userId = found.id;
          console.log(`  ♻️  ${label} — Auth user already existed`);
        } else {
          console.error(`  ❌ ${label} — user exists but couldn't find ID`);
          aErrors++;
          continue;
        }
      } else {
        console.error(`  ❌ ${label} — failed: ${JSON.stringify(result.body)}`);
        aErrors++;
        continue;
      }
    } else {
      console.log(`  ♻️  ${label} — Auth user already existed`);
    }

    if (await restUpdate("admin_users", a.id, { user_id: userId })) {
      console.log(`  🔗 ${label} — linked (user_id = ${userId})`);
      aLinked++;
    } else {
      aErrors++;
    }
  }

  console.log(`\n📊 Admin results: ${aCreated} created, ${aLinked} linked, ${aSkipped} skipped, ${aErrors} errors`);
  console.log("\n══════════════════════════════════════════════");
  console.log("✅ Done! You can now log in with password:", PASSWORD);
  console.log("");
  console.log("🏪 Vendor Portal login (owners & managers):");
  const ownersAndManagers = staff.filter((s) => s.role === "owner" || s.role === "manager");
  for (const s of ownersAndManagers.slice(0, 3)) {
    console.log(`   Phone: ${s.phone.replace("+2", "")}  (${s.name}, ${s.role})`);
  }
  console.log("");
  console.log("🛡️  Super Admin login:");
  for (const a of admins.filter((a) => a.status === "active").slice(0, 2)) {
    console.log(`   Email: ${a.email}  (${a.name}, ${a.role})`);
  }
  console.log("══════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
