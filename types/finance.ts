import type { ListParams, Localized, StatusCounts } from "./common";
import type { AuditLog } from "./audit";
import type { PaymentMethod } from "./orders";

export type TransactionStatus = "pending" | "paid" | "refunded" | "settled";

export interface Transaction {
  id: string;
  orderId: string;
  businessId: string;
  gross: number;
  commissionRate: number;
  commission: number;
  netToWash: number;
  date: string;
  status: TransactionStatus;
  flag: "discrepancy" | null;
  reviewNote: string | null;
  /** ISO currency recorded by the ledger (EGP, SAR…). */
  currency?: string | null;
  /** Settlement statement this row belongs to (GAP-020). */
  payoutId?: string | null;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  method: PaymentMethod;
  collectedBy: string;
  collectedAt: string;
  status: "paid" | "refunded";
}

export interface TransactionListItem extends Transaction {
  businessName: Localized;
  orderNumber: string;
  paymentMethod: PaymentMethod | null;
  collectedAmount: number | null;
  currencySymbol?: string;
  currencyDecimals?: number;
}

export type TransactionFilter = TransactionStatus | "all" | "discrepancy";

export type MoneyTotals = { symbol: string; decimals: number; gross: number; commission: number; netToWash: number };

export type TransactionListMeta = {
  counts: StatusCounts<TransactionStatus | "discrepancy">;
  totals: { gross: number; commission: number; netToWash: number };
  totalsByCurrency?: MoneyTotals[];
};

export interface TransactionListParams extends ListParams {
  filter?: TransactionFilter;
  washId?: string;
  country?: string;
}

export interface DiscrepancyDetails {
  transaction: TransactionListItem;
  orderTotal: number;
  collected: number;
  difference: number;
  cashier: string | null;
  collectedAt: string | null;
  auditLogs: AuditLog[];
}

export type FinancePeriod = "today" | "7d" | "30d";

export interface FinanceSeriesPoint {
  label: string;
  date: string;
  gmv: number;
  commission: number;
}

export interface FinanceOverview {
  period: FinancePeriod;
  /** Currency of the single-currency fields (headline numbers, series, top washes); other currencies are only in *ByCurrency. */
  currency?: string;
  gmv: number;
  commission: number;
  netToWashes: number;
  refunds: number;
  paidOrders: number;
  averageOrderValue: number;
  pendingPayouts: number;
  discrepancies: number;
  series: FinanceSeriesPoint[];
  topWashes: { id: string; name: Localized; gmv: number; commission: number; orders: number }[];
  byCurrency?: { code: string; symbol: string; decimals: number; gmv: number; commission: number; orders: number }[];
  refundsByCurrency?: { code: string; symbol: string; decimals: number; amount: number }[];
  payoutsByCurrency?: { code: string; symbol: string; decimals: number; due: number }[];
}

export interface CommissionWash {
  id: string;
  name: Localized;
  rate: number;
  isOverride: boolean;
  gmv30d: number;
  currencySymbol?: string;
  currencyDecimals?: number;
}

export interface CommissionSettings {
  defaultCommissionPct: number;
  washes: CommissionWash[];
}

export interface UpdateCommissionPayload {
  defaultCommissionPct: number;
  overrides: Record<string, number | null>;
  reason: string;
}

export type PayoutStatus = "due" | "paid";

export interface Payout {
  id: string;
  businessId: string;
  periodStart: string;
  periodEnd: string;
  amountDue: number;
  amountPaid: number;
  status: PayoutStatus;
  reference: string | null;
  paidAt: string | null;
  /** ISO currency of the statement (EGP, SAR…). */
  currency?: string | null;
}

export interface PayoutListItem extends Payout {
  businessName: Localized;
  currencySymbol?: string;
  currencyDecimals?: number;
}

export type PayoutListMeta = {
  counts: StatusCounts<PayoutStatus>;
  totals: { due: number; paid: number };
  totalsByCurrency?: { symbol: string; decimals: number; due: number; paid: number }[];
};

export interface GenerateSettlementsPayload {
  /** YYYY-MM-DD, inclusive. */
  periodStart: string;
  periodEnd: string;
  reason: string;
}

export interface MarkPayoutPaidPayload {
  /** What is being paid now; the server adds it to the payout under a row lock (GAP-092). */
  amount: number;
  /** The already-paid total this screen showed: a payment from a stale tab is refused (409). */
  expectedPaid: number;
  reference: string;
  date: string;
}
