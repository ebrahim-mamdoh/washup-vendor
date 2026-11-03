import "server-only";

import type { VendorAccount } from "@/types/vendor/auth";

import { MockApiError } from "../../http";
import type { VendorActor } from "../../router";
import type { Identity } from "../auth";
import { branchesWhere, businessesWhere, staffWhere } from "../entities";
import { vendorSettingsFor } from "../platform";
import type { Q } from "../sql";

// Pure guards over the actor are shared with the mock implementation.
export { assertBranch, assertNotSuspended, assertOwner, capPermissions, scopeBranches, singleBranch } from "../../vendor/scope";

/** Signed-in identity → owner/manager actor, or null when the account may not use the portal. */
export async function resolveVendorActor(q: Q, identity: Identity): Promise<VendorActor | null> {
  const [staff] =
    identity.kind === "supabase"
      ? await staffWhere(q, q`st.user_id = ${identity.userId}`)
      : await staffWhere(q, q`st.id = ${identity.profileId}`);
  if (!staff || staff.status !== "active") return null;
  const [business] = await businessesWhere(q, q`b.id = ${staff.businessId}`);
  if (!business || business.status === "rejected") return null;
  // Home branch first (the portal opens on it), then the rest.
  const branchIds =
    staff.role === "owner"
      ? (await q<{ id: string }[]>`select id from public.branches where business_id = ${business.id}
                order by (id = ${staff.branchId}) desc, id`).map((b) => b.id)
      : [staff.branchId];
  return { staff, business, role: staff.role, branchIds };
}

export async function toVendorAccount(q: Q, actor: VendorActor): Promise<VendorAccount> {
  const [settings, branches] = await Promise.all([
    vendorSettingsFor(q, actor.business.id),
    branchesWhere(q, q`br.id = any(${actor.branchIds})`, q`order by array_position(${actor.branchIds}::text[], br.id)`),
  ]);
  const locs = branches.length
    ? await q<{ area: string; symbol: string; decimals: number; timezone: string }[]>`
        select a.id as area, c.currency_symbol ->> 'ar' as symbol, c.currency_decimals::int as decimals, c.timezone
        from public.areas a join public.countries c on c.code = a.country_code
        where a.id = any(${branches.map((b) => b.area)})`
    : [];
  const localeOf = new Map(locs.map((l) => [l.area, l]));
  return {
    id: actor.staff.id,
    name: actor.staff.name,
    phone: actor.staff.phone,
    role: actor.role,
    businessId: actor.business.id,
    businessName: actor.business.name,
    businessStatus: actor.business.status,
    businessStatusReason: actor.business.statusReason,
    homeBranchId: actor.staff.branchId,
    branches: branches.map((b) => {
      const loc = localeOf.get(b.area);
      return {
        id: b.id,
        name: b.name,
        area: b.area,
        active: b.active,
        capacity: b.capacity,
        currencySymbol: loc?.symbol ?? "ج.م",
        currencyDecimals: loc?.decimals ?? 2,
        timezone: loc?.timezone ?? "Africa/Cairo",
      };
    }),
    permissions: actor.staff.permissions,
    maxDiscountPct: actor.staff.maxDiscountPct,
    canEditServices: actor.role === "owner" || (actor.role === "manager" && settings.managerCanEditServices),
    lastLoginAt: null,
  };
}

/** Checks a loaded row belongs to one of the actor's branches (404 otherwise, like the mock). */
export function inScope<T extends { branchId: string }>(actor: VendorActor, row: T | undefined, label: string): T {
  if (!row || !actor.branchIds.includes(row.branchId)) {
    throw new MockApiError(`${label} غير موجود`, 404);
  }
  return row;
}
