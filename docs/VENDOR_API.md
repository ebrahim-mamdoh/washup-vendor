# Wash Up Vendor API

Base: `https://washup-vendor.vercel.app/api/v1`

Auth: `Authorization: Bearer <access_token>` (no cookies). Public routes: login, refresh, forgot-password, reset-password, applications, push hook.

## Conventions

- **Money:** Egyptian pounds with decimals (e.g. `29.5`). Server computes prices; clients never send totals.
- **Time:** ISO-8601 UTC. Working hours and slots are Africa/Cairo wall-clock. `GET /vendor/availability` uses `get_branch_slots`.
- **Text:** names `{ ar, en }`. Error `message` is Arabic.
- **Lists:** `?page=&per_page=` (1–100). Envelope: `current_page`, `per_page`, `total`, `last_page`, `from`, `to`, `has_next`.
- **Reason:** required (≥3 chars) for cancel, discount, refund, slot block.
- **Errors:** `{ success: false, message, errors? }` with HTTP 401/403/409/422/423/429.
- **Live poll:** 15s minimum (portal). Partner app: 30s while foreground; rely on push when backgrounded.

## Auth

| Method | Path | Auth | Body |
|---|---|---|---|
| POST | `/vendor/auth/login` | public | `{ phone, password }` |
| POST | `/vendor/auth/refresh` | public | `{ refresh_token }` |
| GET | `/vendor/auth/me` | staff | — |
| POST | `/vendor/auth/logout` | staff | — |
| POST | `/vendor/auth/change-password` | staff | `{ currentPassword, newPassword }` (≥8) |
| POST | `/vendor/auth/forgot-password` | public | `{ phone }` |
| POST | `/vendor/auth/reset-password` | public | `{ access_token, newPassword }` |

**Login:** phone normalized to 10 digits. Roles: `owner` | `manager` | `employee` (all may sign in). Suspended staff → 403. Suspended wash → later writes 423.

Partner Flutter app is for owner/manager; if `role === "employee"`, send them to the web portal. Floor operations run on the web dashboard.

**Tokens:** production uses Supabase Auth. Access ~1 hour (`expires_in`). Refresh tokens **rotate** on each refresh; two parallel refreshes can invalidate one of them — serialize refresh. Logout calls Supabase logout (server-side revoke of the session). Mock/local: tokens do not expire.

**Forgot password:** finds the staff user, uses Auth email or the wash `contact_email`, then Supabase `/auth/v1/recover` (built-in email). Redirect: `{portal}/reset-password`. Add that URL to Supabase Auth redirect allow-list. 422 if no email.

**Rate limit:** 10 login/forgot attempts per IP / 5 minutes → 429.

## Push

| Method | Path | Body |
|---|---|---|
| POST | `/vendor/push/register` | `{ token, platform?: "web"|"ios"|"android", appVersion? }` |
| POST | `/vendor/push/unregister` | `{ token }` |
| POST | `/vendor/push/hook` | webhook (secret header) |

Default platform is `web`. Same token upserts (`UNIQUE token`). Recipients: owner + branch managers, or a specific `staff_id`. FCM payload: `notification` + `data` (`id`, `type`, `title`, `body`, `href`, `app`). Dead tokens (`UNREGISTERED`) are deleted.

## Orders

`POST /vendor/orders/:id/actions` `{ action, ... }`

| From | Actions |
|---|---|
| pending | confirm, cancel, assign, discount |
| confirmed | check_in (same day), no_show (after grace), cancel, assign, discount |
| waiting | start, cancel, **no_show**, assign, add_service, discount |
| in_service | complete, assign, add_service, discount |
| completed | collect_payment, discount (unpaid), refund (paid) |
| cancelled / no_show | note |

`GET /vendor/orders/:id` returns `allowedActions` and `nextAction`. Lists/live return `nextAction` only.

**Start:** `staffId` optional. Falls back to the order’s assigned staff, then the signed-in actor (must be assignable: owner of the wash, or active manager/employee of that branch).

**Cancel:** `{ action: "cancel", reason }` (`reason` ≥ 3). Stored/returned as `cancel.reason`. Code `expired_unconfirmed` display: «اتلغى تلقائيًا لأن المغسلة ما أكدتش في الوقت المحدد».

**Discount:** positive decimals; percent ≤ 100 and ≤ `maxDiscountPct`; fixed capped at subtotal; reason required.

**Phone booking vehicle:** reuse only if plate matches; otherwise a new vehicle is created.

**Ledger:** `transactions` row is created on **complete** (status `pending` until collect). Cancel/no_show drop pending rows.

**Payment badge:** for `cancelled` / `no_show` show «لا يوجد» even if `paymentStatus` is still `pending`.

## Other routes (same as the portal)

`GET` dashboard, setup, live, orders, schedule, services, offers, branches, staff, shifts, day-closing, customers, reviews, reports, finance, audit, notifications, search, availability, recognize, price-preview.

Writes: order create/actions/bulk-confirm; schedule blocks; services/offers/branches/settings; staff/shifts (including clock-in/out); review reply/report; notification read; upload (applications only).

**Shifts (floor):**

| Method | Path | Body |
|---|---|---|
| GET | `/vendor/shifts/current` | — (`null` if none open) |
| POST | `/vendor/shifts/clock-in` | — |
| POST | `/vendor/shifts/clock-out` | `{ actualCash, reason? }` |

Clock-out: `reason` required (≥3) when cash differs from expected. Then `review_status = submitted`. Review/day-close still need `closeShift`.

**Not available:** create/delete branch, service/offer/staff delete (deactivate only), server CSV, branch/service photos, separate employee mobile app.

## Permissions

Server-enforced: `confirmBooking`, `cancelOrder`, `closeShift`, `collectPayment`, `refund`, `runService`, `manageStaff`. `canEditServices` = owner **or** `managerCanEditServices`. Owner `maxDiscountPct` is stored per staff (often 100). Missing permission → 403/409 with Arabic message.
