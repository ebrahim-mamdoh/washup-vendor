import { Suspense } from "react";
import RegisterWizard from "@/components/modules/Register/RegisterWizard";
import { getStaticPageMetadata } from "@/lib/config/pages";

export const metadata = getStaticPageMetadata("/register");

export default function RegisterPage() {
  return (
    <main className="min-h-dvh bg-gradient-to-b from-background via-background to-muted/20">
      <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">جاري تحميل استمارة التسجيل...</div>}>
        <RegisterWizard />
      </Suspense>
    </main>
  );
}
