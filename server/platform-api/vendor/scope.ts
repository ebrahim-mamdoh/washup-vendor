import "server-only";

import type { OrderStatus } from "@/types/orders";
import type { OrderAction } from "@/types/vendor/operations";
import type { VendorAccount } from "@/types/vendor/auth";
import type { StaffPermissions } from "@/types/washes";
import { MockApiError } from "../http";
import type { VendorActor } from "../router";
import type { MockDatabase } from "../schema";
import { vendorSettingsFor } from "./notify";

/** Token → signed-in owner/manager, or null when the session is invalid. */
export function resolveVendorActor(db: MockDatabase, token: string): VendorActor | null {
  const staffId = db.vendorSessions[token];
  if (!staffId) return null;
  const staff = db.staff.find((s) => s.id === staffId);
  if (!staff || staff.status !== "active") return null;
  const business = db.businesses.find((b) => b.id === staff.businessId);
  if (!business || business.status === "rejected") return null;
  const branchIds =
    staff.role === "owner"
      ? db.branches.filter((b) => b.businessId === business.id).map((b) => b.id)
      : [staff.branchId];
  return { staff, business, role: staff.role, branchIds };
}

export function toVendorAccount(db: MockDatabase, actor: VendorActor): VendorAccount {
  const settings = vendorSettingsFor(db, actor.business.id);
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
    branches: db.branches
      .filter((b) => actor.branchIds.includes(b.id))
      .map((b) => ({ id: b.id, name: b.name, area: b.area, active: b.active, capacity: b.capacity })),
    permissions: actor.staff.permissions,
    maxDiscountPct: actor.staff.maxDiscountPct,
    canEditServices: actor.role === "owner" || (actor.role === "manager" && settings.managerCanEditServices),
    lastLoginAt: null,
  };
}

/**
 * Resolves the `branchId` query/body value to the list of branches to read.
 * "all" (or empty) → every branch the actor may see. A specific branch must
 * be inside the actor's scope — managers can't read other branches (MG-01).
 */
export function scopeBranches(actor: VendorActor, branchId: string | null | undefined): string[] {
  if (!branchId || branchId === "all") return actor.branchIds;
  assertBranch(actor, branchId);
  return [branchId];
}

export function assertBranch(actor: VendorActor, branchId: string): void {
  if (!actor.branchIds.includes(branchId)) {
    throw new MockApiError("ليس لديك صلاحية على هذا الفرع", 403);
  }
}

/** A single branch is required (schedule, day closing…): "all" falls back to the home branch. */
export function singleBranch(actor: VendorActor, branchId: string | null | undefined): string {
  if (!branchId || branchId === "all") return actor.branchIds.includes(actor.staff.branchId) ? actor.staff.branchId : actor.branchIds[0];
  assertBranch(actor, branchId);
  return branchId;
}

export function assertOwner(actor: VendorActor, what = "هذا الإجراء"): void {
  if (actor.role !== "owner") throw new MockApiError(`${what} متاح لمالك المغسلة فقط`, 403);
}

/**
 * Owner/manager pages (customers, reviews, reports, finance, audit) are hidden from employees
 * in the portal menu (`EMPLOYEE_HREFS`); this enforces the same rule on the server (GAP-004).
 */
export function assertNotEmployee(actor: VendorActor): void {
  if (actor.role === "employee") throw new MockApiError("هذه الصفحة متاحة للمالك ومدير الفرع فقط", 403);
}

/** A manager can only grant permissions he holds himself (the owner grants anything). */
export function capPermissions(actor: VendorActor, permissions: StaffPermissions): StaffPermissions {
  if (actor.role === "owner") return permissions;
  const own = actor.staff.permissions;
  return Object.fromEntries(Object.entries(permissions).map(([k, v]) => [k, v && Boolean(own[k as keyof StaffPermissions])])) as unknown as StaffPermissions;
}

export function assertNotSuspended(actor: VendorActor): void {
  if (actor.business.status === "suspended") {
    throw new MockApiError("المغسلة معلّقة من إدارة Wash Up — لا يمكن استقبال حجوزات جديدة حاليًا", 423);
  }
}

/**
 * Suspended mode (GAP-014, policy agreed with the owner on 2026-11-24): a suspended wash may
 * FINISH the cars already at the branch and cancel bookings — nothing new.
 * - any order: note, cancel, no-show;
 * - cars inside (waiting / in service / done but unpaid): start, complete, collect payment, assign,
 *   add a service, discount, refund;
 * - blocked: confirm, check-in (a new car arriving), and catalog edits (`assertCatalogEditable`).
 */
const ANY_ORDER = new Set<OrderAction>(["note", "cancel", "no_show"]);
const CAR_INSIDE = new Set<OrderAction>(["start", "complete", "collect_payment", "assign", "add_service", "discount", "refund"]);

export function suspendedAllows(actor: VendorActor, o: { status: OrderStatus }, action: OrderAction): boolean {
  if (actor.business.status !== "suspended") return true;
  if (ANY_ORDER.has(action)) return true;
  const inside = o.status === "waiting" || o.status === "in_service" || o.status === "completed";
  return inside && CAR_INSIDE.has(action);
}

export const SUSPENDED_ACTION_MESSAGE = "المغسلة موقوفة من إدارة Wash Up — متاح فقط إنهاء السيارات الموجودة في الفرع وإلغاء الحجوزات";

/** Services, offers and branch details are frozen while suspended (GAP-014). */
export function assertCatalogEditable(actor: VendorActor): void {
  if (actor.business.status === "suspended") {
    throw new MockApiError("المغسلة موقوفة من إدارة Wash Up — تعديل الخدمات والعروض وبيانات الفروع غير متاح حتى إعادة التفعيل", 423);
  }
}

export function findInScope<T extends { id: string; branchId: string }>(actor: VendorActor, list: T[], id: string, label: string): T {
  const item = list.find((x) => x.id === id);
  if (!item || !actor.branchIds.includes(item.branchId)) throw new MockApiError(`${label} غير موجود`, 404);
  return item;
}
