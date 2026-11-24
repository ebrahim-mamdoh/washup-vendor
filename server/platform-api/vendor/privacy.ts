import "server-only";

import type { Customer } from "@/types/customers";

/**
 * GAP-029 — a wash sees a person as its own customer, not the platform's moderation record
 * (suspension status and reason stay with the Super Admin). Same masking as `recognitionForWash`.
 */
export function customerForWash(customer: Customer): Customer {
  return { ...customer, status: "active", statusReason: null };
}

/**
 * What vendor clients (partner portal + owner app) must not receive.
 *
 * GAP-031 — the 5-character check-in code is the customer's proof of arrival: staff type the
 * code the customer shows and the server compares it (`assertCheckInCode`). If vendor responses
 * carried it, anyone with the app could check a customer in without them being there.
 */
export function hideCheckInCode<T extends { code: string }>(order: T): Omit<T, "code"> {
  const copy: Partial<T> = { ...order };
  delete copy.code;
  return copy as Omit<T, "code">;
}
