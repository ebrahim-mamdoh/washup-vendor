import "server-only";

import { MockApiError } from "../http";

/*
 * Cancellation reasons shown to customers (order engine of both apps). Byte-identical in the
 * Super Admin and the partner portal (`npm run check:shared`, GAP-054).
 */

/** Keys the customer app would otherwise show raw. Stored text is a sentence in Arabic and English. */
const CANCEL_REASON_TEXT: Record<string, string> = {
  expired_unconfirmed:
    "اتلغى تلقائيًا لأن المغسلة ما أكدتش في الوقت المحدد — Cancelled because the wash did not confirm before the appointment",
  expired_not_started:
    "أُغلق الطلب لأن الخدمة لم تبدأ بعد تسجيل الوصول — Closed because the service never started after check-in",
  "Cancelled by customer": "ألغاه العميل — Cancelled by the customer",
};

const MACHINE_KEY = /^[a-z0-9]+(?:[._][a-z0-9]+)+$/i;

/** Turns a stored key into a sentence. Unknown machine keys are rejected so the app never shows them. */
export function readableCancelReason(raw: string): string {
  const text = raw.trim();
  if (CANCEL_REASON_TEXT[text]) return CANCEL_REASON_TEXT[text];
  if (MACHINE_KEY.test(text) && !/[\u0600-\u06FF]/.test(text)) {
    throw new MockApiError("اكتب سبب الإلغاء بجملة واضحة بالعربي أو الإنجليزي", 422, { reason: ["اكتب السبب بالعربي أو الإنجليزي"] });
  }
  return text;
}
