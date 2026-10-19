import "server-only";

import type { RolesMatrix } from "@/types/admins";
import type { WashApplication } from "@/types/applications";
import type { AuditLog } from "@/types/audit";
import type { AdminUser } from "@/types/auth";
import type { Localized } from "@/types/common";
import type { Complaint } from "@/types/complaints";
import type { Customer, Vehicle } from "@/types/customers";
import type { Payment, Payout, Transaction } from "@/types/finance";
import type { AdminNotification } from "@/types/notifications";
import type { Offer } from "@/types/offers";
import type { Order } from "@/types/orders";
import type { Review } from "@/types/reviews";
import type { PlatformSettings } from "@/types/settings";
import type { Branch, Business, Staff, WashService } from "@/types/washes";
import type { VendorNotificationType } from "@/types/vendor/catalog";
import type { VendorNotification } from "@/types/vendor/insights";
import type { DayClosing, ShiftClosingStatus } from "@/types/vendor/team";

export interface StoredAdmin extends AdminUser {
  password: string;
}

export interface Shift {
  id: string;
  staffId: string;
  branchId: string;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  ordersCompleted: number;
  cashPayments: number;
  cardPayments: number;
  expectedCash: number;
  actualCash: number | null;
  difference: number | null;
  reason: Localized | null;
  /** open = running; submitted = closed by the employee, awaiting manager review. */
  reviewStatus: ShiftClosingStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
}

export interface VendorBusinessSettings {
  managerCanEditServices: boolean;
  phone: string;
  email: string;
  notificationPrefs: Record<VendorNotificationType, boolean>;
}

/** Headline numbers that represent the whole platform (the seed is a sample). */
export interface PlatformBaseline {
  customers: number;
  activeWashes: number;
  branches: number;
  bookingsToday: number;
  completedToday: number;
  gmvToday: number;
  platformRevenueToday: number;
}

export interface MockDatabase {
  /** Seed shape version — a persisted DB with another version is regenerated. */
  schemaVersion: number;
  /** Demo clock anchor: demo time at seed (today 15:30) and the real time it was taken. */
  clockAnchor: { demoMs: number; realMs: number };
  seededAt: string;
  customers: Customer[];
  vehicles: Vehicle[];
  businesses: Business[];
  branches: Branch[];
  services: WashService[];
  staff: Staff[];
  shifts: Shift[];
  orders: Order[];
  payments: Payment[];
  transactions: Transaction[];
  payouts: Payout[];
  reviews: Review[];
  offers: Offer[];
  complaints: Complaint[];
  applications: WashApplication[];
  admins: StoredAdmin[];
  notifications: AdminNotification[];
  auditLogs: AuditLog[];
  settings: PlatformSettings;
  defaultCommissionPct: number;
  roles: RolesMatrix;
  /** access token → admin id */
  sessions: Record<string, string>;
  counters: { nextTicket: number };
  // ── Vendor (wash owner / manager) side ──
  /** staff id → password (demo: demo1234). */
  staffPasswords: Record<string, string>;
  /** vendor access token → staff id */
  vendorSessions: Record<string, string>;
  vendorNotifications: VendorNotification[];
  vendorSettings: Record<string, VendorBusinessSettings>;
  dayClosings: DayClosing[];
  /** Customer-facing service descriptions (the shared WashService has none). */
  serviceDescriptions: Record<string, Localized>;
  baseline: PlatformBaseline;
}
