import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Public upload for the "join as a wash" wizard (no session exists yet).
 * It runs with the service-role key, so everything the caller controls is whitelisted:
 * - bucket: only the two buckets the wizard uses (never a caller-chosen one);
 * - file: PDF / JPEG / PNG / WebP only, checked by magic bytes, ≤ 10 MB;
 * - rate: at most `MAX_UPLOADS` per client IP per `WINDOW_MS` (this server's memory).
 * KYC documents are never returned as a public URL; admins see them by name.
 */
const BUCKETS = {
  "application-documents": { publicUrl: false },
  "branch-photos": { publicUrl: true },
} as const;
type Bucket = keyof typeof BUCKETS;

const MAX_SIZE = 10 * 1024 * 1024;
const WINDOW_MS = 10 * 60_000;
const MAX_UPLOADS = 20;
const THROTTLE_KEY = "__CARZEN_UPLOAD_THROTTLE__";

type Kind = { ext: string; mime: string };
const KINDS: { sig: number[]; offset?: number; kind: Kind; check?: (b: Uint8Array) => boolean }[] = [
  { sig: [0x25, 0x50, 0x44, 0x46, 0x2d], kind: { ext: ".pdf", mime: "application/pdf" } }, // %PDF-
  { sig: [0xff, 0xd8, 0xff], kind: { ext: ".jpg", mime: "image/jpeg" } },
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], kind: { ext: ".png", mime: "image/png" } },
  {
    sig: [0x52, 0x49, 0x46, 0x46], // RIFF....WEBP
    kind: { ext: ".webp", mime: "image/webp" },
    check: (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function sniff(head: Uint8Array): Kind | null {
  for (const k of KINDS) {
    if (k.sig.every((byte, i) => head[i] === byte) && (!k.check || k.check(head))) return k.kind;
  }
  return null;
}

function uploadThrottled(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  const g = globalThis as typeof globalThis & { [THROTTLE_KEY]?: Map<string, number[]> };
  const map: Map<string, number[]> = (g[THROTTLE_KEY] ??= new Map<string, number[]>());
  const at = Date.now();
  const recent = (map.get(ip) ?? []).filter((t) => at - t < WINDOW_MS);
  if (recent.length >= MAX_UPLOADS) {
    map.set(ip, recent);
    return true;
  }
  recent.push(at);
  map.set(ip, recent);
  if (map.size > 5000) for (const [k, v] of map) if (!v.some((t) => at - t < WINDOW_MS)) map.delete(k);
  return false;
}

const fail = (message: string, status: number) => NextResponse.json({ status: false, message }, { status });

export async function POST(req: Request) {
  try {
    if (uploadThrottled(req)) return fail("محاولات رفع كثيرة — حاول مرة أخرى بعد قليل", 429);

    const formData = await req.formData();
    const file = formData.get("file");
    const requested = String(formData.get("bucket") ?? "application-documents");

    if (!(file instanceof File)) return fail("لم يتم إرسال أي ملف", 400);
    if (!(requested in BUCKETS)) return fail("نوع الرفع غير مسموح", 400);
    const bucket = requested as Bucket;

    if (file.size === 0) return fail("الملف فارغ", 400);
    if (file.size > MAX_SIZE) return fail("حجم الملف يتجاوز الحد المسموح (10 ميجابايت)", 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const kind = sniff(buffer.subarray(0, 12));
    // Storefront photos must be images; documents may also be PDFs.
    if (!kind || (bucket === "branch-photos" && kind.mime === "application/pdf")) {
      return fail("نوع الملف غير مدعوم — ارفع PDF أو صورة (JPG / PNG / WebP)", 415);
    }

    // Storage keys are ours (ASCII, random); the original name is only echoed back for display.
    const storedName = `doc_${Date.now()}_${crypto.randomUUID().slice(0, 8)}${kind.ext}`;

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && serviceKey) {
      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${storedName}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": kind.mime,
          "x-upsert": "false",
        },
        body: buffer,
      });

      if (!uploadRes.ok) {
        console.error("[Storage Upload Error]", uploadRes.status, await uploadRes.text().catch(() => ""));
        return fail("تعذر رفع الملف — حاول مرة أخرى", 502);
      }

      return NextResponse.json({
        status: true,
        data: {
          fileName: file.name,
          storedName,
          path: `${bucket}/${storedName}`,
          url: BUCKETS[bucket].publicUrl ? `${supabaseUrl}/storage/v1/object/public/${bucket}/${storedName}` : null,
          size: file.size,
          type: kind.mime,
        },
        message: "تم رفع الملف بنجاح",
      });
    }

    if (process.env.NODE_ENV === "production") {
      console.error("[Upload Route] SUPABASE_URL / SUPABASE_SECRET_KEY missing in production");
      return fail("خدمة الرفع غير متاحة حاليًا", 503);
    }

    // Local development without Supabase: nothing is stored.
    return NextResponse.json({
      status: true,
      data: { fileName: file.name, storedName, path: storedName, url: null, size: file.size, type: kind.mime },
      message: "تم رفع الملف بنجاح (وضع محلي)",
    });
  } catch (error) {
    console.error("[Upload Route Error]", error);
    return fail("حدث خطأ غير متوقع أثناء الرفع", 500);
  }
}
