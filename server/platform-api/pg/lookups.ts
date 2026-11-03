import "server-only";

import type { Localized } from "@/types/common";
import type { Order, OrderListItem } from "@/types/orders";
import type { VendorOrderListItem } from "@/types/vendor/operations";
import type { Staff } from "@/types/washes";

import { now } from "../db";
import { serviceName } from "../lookups";
import { cairoDateParts, clockToMin, minutesOfDay, nextActionFor, overdueMinutes } from "../vendor/engine";
import { staffWhere } from "./entities";
import type { Q } from "./sql";

/**
 * Batch name lookups that turn loaded rows into list items — the Postgres
 * counterparts of `../lookups.ts` and the db-dependent helpers of
 * `../vendor/engine.ts`. One query per kind of name, never one per row.
 */
const EMPTY: Localized = { ar: "—", en: "—" };

async function namesById<T>(q: Q, table: "businesses" | "branches" | "customers" | "staff", ids: (string | null)[]): Promise<Map<string, T>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const rows = await q<{ id: string; name: T }[]>`select id, name from ${q("public." + table)} where id = any(${unique})`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const businessNames = (q: Q, ids: (string | null)[]) => namesById<Localized>(q, "businesses", ids);
export const branchNames = (q: Q, ids: (string | null)[]) => namesById<Localized>(q, "branches", ids);
export const customerNames = (q: Q, ids: (string | null)[]) => namesById<string>(q, "customers", ids);
export const staffNames = (q: Q, ids: (string | null)[]) => namesById<string>(q, "staff", ids);

/** Admin name for audit/notes authors: admins, then staff, "النظام" for the seed actor. */
export async function actorNames(q: Q, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const rows = await q<{ id: string; name: string }[]>`
    select id, name from public.admin_users where id = any(${unique})
    union all
    select id, name from public.staff where id = any(${unique}) and id not in (select id from public.admin_users)`;
  for (const r of rows) map.set(r.id, r.name);
  if (unique.includes("seed")) map.set("seed", "النظام");
  return map;
}

/** Orders → admin list items (customer, business, branch, primary service names). */
export async function toOrderListItems(q: Q, orders: Order[]): Promise<OrderListItem[]> {
  const [customers, businesses, branches] = await Promise.all([
    customerNames(q, orders.map((o) => o.customerId)),
    businessNames(q, orders.map((o) => o.businessId)),
    branchNames(q, orders.map((o) => o.branchId)),
  ]);
  return orders.map((o) => ({
    ...o,
    customerName: (o.customerId && customers.get(o.customerId)) || null,
    businessName: businesses.get(o.businessId) ?? EMPTY,
    branchName: branches.get(o.branchId) ?? EMPTY,
    serviceName: serviceName(o),
  }));
}

/** Orders → vendor list items (adds staff name, vehicle label, next action, overdue minutes, lock). */
export async function toVendorItems(q: Q, orders: Order[], at: Date = now()): Promise<VendorOrderListItem[]> {
  const vehicleIds = [...new Set(orders.map((o) => o.vehicleId).filter((x): x is string => Boolean(x)))];
  const branchIds = [...new Set(orders.map((o) => o.branchId))];
  const [items, staff, vehicles, graces] = await Promise.all([
    toOrderListItems(q, orders),
    staffNames(q, orders.map((o) => o.assignedStaffId)),
    vehicleIds.length
      ? q<{ id: string; label: string }[]>`select id, make || ' ' || model as label from public.vehicles where id = any(${vehicleIds})`
      : Promise.resolve([]),
    branchIds.length
      ? q<{ id: string; grace: number }[]>`select id, no_show_grace_min as grace from public.branches where id = any(${branchIds})`
      : Promise.resolve([]),
  ]);
  const labels = new Map(vehicles.map((v) => [v.id, v.label]));
  const graceOf = new Map(graces.map((g) => [g.id, g.grace]));
  return items.map((o) => ({
    ...o,
    staffName: (o.assignedStaffId && staff.get(o.assignedStaffId)) || null,
    vehicleLabel: (o.vehicleId && labels.get(o.vehicleId)) || null,
    nextAction: nextActionFor(o),
    overdueMin: overdueMinutes(o, at),
    noShowGraceMin: graceOf.get(o.branchId) ?? 15,
    locked: Boolean(o.closedInDayId),
  }));
}

/** Staff clocked in on the branch, plus those whose weekly pattern covers `at`. */
export async function onShiftAt(q: Q, branchId: string, at: Date = now()): Promise<Staff[]> {
  const m = minutesOfDay(at);
  const weekday = cairoDateParts(at).weekday;
  const [staff, open] = await Promise.all([
    staffWhere(q, q`st.branch_id = ${branchId} and st.status = 'active'`, q`order by st.id`),
    q<{ staffId: string }[]>`
      select staff_id as "staffId" from public.staff_shifts
      where branch_id = ${branchId} and review_status = 'open' and actual_end is null`,
  ]);
  const openIds = new Set(open.map((r) => r.staffId));
  return staff.filter((s) => {
    if (openIds.has(s.id)) return true;
    return s.role !== "owner" && s.scheduledShifts.some((p) => p.days.includes(weekday) && m >= clockToMin(p.start) && m < clockToMin(p.end, true));
  });
}
