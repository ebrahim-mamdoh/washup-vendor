import "server-only";

import type postgres from "postgres";

import type { VendorActor } from "../../router";
import type { Identity } from "../auth";
import { staffWhere } from "../entities";
import { TENANT_ROLE } from "../sql";
import { resolveVendorActor } from "./scope";

/**
 * GAP-027 (defence in depth): the database context of one vendor request when
 * `CARZEN_DB_TENANT_ROLE=1`. Runs at the start of the request's transaction (`withTenantScope`):
 *
 * 1. `set local role washup_vendor_panel` (NOBYPASSRLS) — if that fails the request fails (500);
 *    it never carries on as `postgres`;
 * 2. `app.user_id` / `app.staff_id` = the signed-in identity, `app.business_id` / `app.branch_ids` empty;
 * 3. the identity's staff row is readable through the `user_id` / `staff_id` policy → its business
 *    becomes `app.business_id`, so `resolveVendorActor` can read the business and its branches;
 * 4. once the actor is known: `app.business_id`, `app.branch_ids`, `app.staff_id` of the actor (or
 *    back to empty when the account may not use the portal).
 *
 * Every RLS policy of the role (migration 20261127110000) reads these settings. `set local` and
 * `set_config(…, true)` end with the transaction, so nothing leaks to the next request on the
 * pooled connection.
 */
export class TenantScopeError extends Error {
  constructor(cause: unknown) {
    super(`could not enter the database tenant role ${TENANT_ROLE}`, { cause });
    this.name = "TenantScopeError";
  }
}

type Context = { userId: string; staffId: string; businessId: string; branchIds: string[] };

async function setContext(t: postgres.TransactionSql, c: Context): Promise<string> {
  const [row] = await t<{ role: string }[]>`
    select current_user::text as role,
      set_config('app.user_id', ${c.userId}, true),
      set_config('app.staff_id', ${c.staffId}, true),
      set_config('app.business_id', ${c.businessId}, true),
      set_config('app.branch_ids', ${c.branchIds.join(",")}, true)`;
  return row?.role ?? "";
}

/** Switches the transaction to the tenant role and binds the request's identity; returns the actor (null: public). */
export async function enterVendorTenant(t: postgres.TransactionSql, identity: Identity | null): Promise<VendorActor | null> {
  const base: Context = {
    userId: identity?.kind === "supabase" ? identity.userId : "",
    staffId: identity?.kind === "local" ? identity.profileId : "",
    businessId: "",
    branchIds: [],
  };
  try {
    await t.unsafe(`set local role ${TENANT_ROLE}`);
    const role = await setContext(t, base);
    if (role !== TENANT_ROLE) throw new Error(`current_user is ${role || "unknown"} after set role`);
  } catch (error) {
    console.error(`[tenant] ${TENANT_ROLE} unavailable — request refused`, error);
    throw new TenantScopeError(error);
  }
  if (!identity) return null;

  // Same lookup as resolveVendorActor's first query, allowed by the staff user_id / staff_id policy.
  const [home] =
    identity.kind === "supabase"
      ? await staffWhere(t, t`st.user_id = ${identity.userId}`)
      : await staffWhere(t, t`st.id = ${identity.profileId}`);
  if (!home) return null;
  await setContext(t, { ...base, businessId: home.businessId });

  const actor = await resolveVendorActor(t, identity);
  await setContext(
    t,
    actor ? { ...base, staffId: actor.staff.id, businessId: actor.business.id, branchIds: actor.branchIds } : base,
  );
  return actor;
}
