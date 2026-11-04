import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Allowed MIME types and extensions for uploaded documents
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);

// In-memory rate limiting per IP (20 requests per minute)
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitRecord>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateLimitMap.size > 1000) {
      for (const [key, val] of rateLimitMap.entries()) {
        if (now > val.resetAt) rateLimitMap.delete(key);
      }
    }
    return true;
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  record.count += 1;
  return true;
}

export async function POST(req: Request) {
  try {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "anonymous";

    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { status: false, message: "تجاوزت الحد المسموح لعدد الطلبات، يرجى المحاولة لاحقاً" },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    // Force bucket to application-documents only, ignore any client-provided bucket
    const bucket = "application-documents";

    if (!file) {
      return NextResponse.json({ status: false, message: "لم يتم إرسال أي ملف" }, { status: 400 });
    }

    // Check size (max 10MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { status: false, message: "حجم الملف يتجاوز الحد المسموح (10 ميجابايت)" },
        { status: 400 }
      );
    }

    const ext = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      : "";

    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { status: false, message: "نوع الملف غير مدعوم. يسمح فقط بصيغ PDF والصور (JPG, PNG, WebP)" },
        { status: 400 }
      );
    }

    // S3/Supabase storage keys require ASCII characters. Keep original name for display.
    const safeAsciiName = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const contentType = file.type || "application/octet-stream";

    // If Supabase credentials are configured, upload to Supabase Storage
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && serviceKey) {
      const buffer = Buffer.from(await file.arrayBuffer());

      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${safeAsciiName}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": contentType,
        },
        body: buffer,
      });

      if (!uploadRes.ok) {
        const errJson = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;
        console.error("[Storage Upload Error]", uploadRes.status, errJson);
        const errMsg = typeof errJson?.message === "string" ? errJson.message : "تعذر رفع الملف إلى مساحة التخزين في سوبابيز";
        return NextResponse.json(
          {
            status: false,
            message: errMsg,
          },
          { status: uploadRes.status }
        );
      }

      const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${safeAsciiName}`;

      return NextResponse.json({
        status: true,
        data: {
          fileName: file.name,
          storedName: safeAsciiName,
          path: `${bucket}/${safeAsciiName}`,
          url: publicUrl,
          size: file.size,
          type: file.type,
        },
        message: "تم رفع الملف بنجاح",
      });
    }

    // Local / Mock fallback
    return NextResponse.json({
      status: true,
      data: {
        fileName: file.name,
        storedName: safeAsciiName,
        path: safeAsciiName,
        url: `/uploads/${safeAsciiName}`,
        size: file.size,
        type: file.type,
      },
      message: "تم رفع الملف بنجاح (وضع محلي)",
    });
  } catch (error: unknown) {
    console.error("[Upload Route Error]", error);
    const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع أثناء الرفع";
    return NextResponse.json({ status: false, message }, { status: 500 });
  }
}
