import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const bucket = (formData.get("bucket") as string) || "application-documents";

    if (!file) {
      return NextResponse.json({ status: false, message: "لم يتم إرسال أي ملف" }, { status: 400 });
    }

    // Check size (max 10MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ status: false, message: "حجم الملف يتجاوز الحد المسموح (10 ميجابايت)" }, { status: 400 });
    }

    const ext = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      : "";
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
        const errJson = await uploadRes.json().catch(() => ({}));
        console.error("[Storage Upload Error]", uploadRes.status, errJson);
        return NextResponse.json(
          {
            status: false,
            message: (errJson as any)?.message || "تعذر رفع الملف إلى مساحة التخزين في سوبابيز",
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
  } catch (error: any) {
    console.error("[Upload Route Error]", error);
    return NextResponse.json({ status: false, message: error?.message || "حدث خطأ غير متوقع أثناء الرفع" }, { status: 500 });
  }
}
