"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Clock3,
  FileText,
  MapPin,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  User,
  Wrench,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";

import { BrandLogo } from "@/components/shared/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchApplication, submitApplication } from "@/lib/services/applications.service";
import type { ApplicationService, SubmitApplicationPayload, WashApplication } from "@/types/applications";
import type { WorkingDay } from "@/types/washes";

const AREAS = [
  { id: "nasr", name: "مدينة نصر" },
  { id: "helio", name: "مصر الجديدة" },
  { id: "nc", name: "التجمع والقاهرة الجديدة" },
  { id: "maadi", name: "المعادي" },
  { id: "zamalek", name: "الزمالك" },
  { id: "moh", name: "المهندسين والدقي" },
  { id: "zayed", name: "الشيخ زايد" },
  { id: "oct", name: "٦ أكتوبر" },
];

const WEEKDAYS = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

const DEFAULT_SERVICES: (ApplicationService & { selected: boolean })[] = [
  { name: "غسيل خارجي بالرغوة", price: 100, durationMin: 20, selected: true },
  { name: "غسيل داخلي وتعطير", price: 100, durationMin: 25, selected: true },
  { name: "غسيل شامل (داخلي + خارجي)", price: 180, durationMin: 40, selected: true },
  { name: "تنظيف عميق بالبخار والفرش", price: 300, durationMin: 60, selected: false },
  { name: "تلميع وحماية واكس (Wax Polish)", price: 250, durationMin: 45, selected: false },
];

const INITIAL_HOURS: WorkingDay[] = Array.from({ length: 7 }, (_, i) => ({
  open: i === 5 ? "13:00" : "09:00",
  close: "23:00",
  closed: false,
}));

const STEPS = [
  { num: 1, title: "بيانات المنشأة", icon: Building2 },
  { num: 2, title: "موقع الفرع", icon: MapPin },
  { num: 3, title: "ساعات العمل والسعة", icon: Clock },
  { num: 4, title: "الخدمات والأسعار", icon: Wrench },
  { num: 5, title: "المستندات والصور", icon: FileText },
  { num: 6, title: "تأكيد الطلب", icon: CheckCircle2 },
];

export default function RegisterWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [activeApp, setActiveApp] = useState<WashApplication | null>(null);
  const [fetchingStatus, setFetchingStatus] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    businessName: "",
    ownerName: "",
    phone: "",
    email: "",
    branchName: "",
    area: "nc",
    address: "",
    lat: 30.0131,
    lng: 31.4395,
    capacity: 4,
  });

  const [services, setServices] = useState(DEFAULT_SERVICES);
  const [newServiceName, setNewServiceName] = useState("");
  const [newServicePrice, setNewServicePrice] = useState(150);
  const [newServiceDuration, setNewServiceDuration] = useState(30);

  const [workingHours, setWorkingHours] = useState<WorkingDay[]>(INITIAL_HOURS);
  const [documents, setDocuments] = useState<string[]>([
    "السجل_التجاري.pdf",
    "صورة_الواجهة_الأمامية.jpg",
  ]);

  // Check query param for existing application id or status check
  useEffect(() => {
    const appId = searchParams.get("id") || (typeof window !== "undefined" ? localStorage.getItem("carzen_application_id") : null);
    if (appId) {
      loadApplicationStatus(appId);
    }
  }, [searchParams]);

  async function loadApplicationStatus(id: string) {
    try {
      setFetchingStatus(true);
      const res = await fetchApplication(id);
      setActiveApp(res);
    } catch {
      // not found or error
    } finally {
      setFetchingStatus(false);
    }
  }

  const handleNext = () => {
    if (step === 1) {
      if (!formData.businessName.trim()) {
        toast.error("يرجى إدخال اسم المغسلة أو الشركة");
        return;
      }
      if (!formData.ownerName.trim()) {
        toast.error("يرجى إدخال اسم المالك أو المسؤول");
        return;
      }
      const rawPhone = formData.phone.replace(/\D/g, "");
      if (!rawPhone.startsWith("01") || rawPhone.length !== 11) {
        toast.error("يرجى إدخال رقم موبايل مصري صحيح مكون من 11 رقم يبدأ بـ 01");
        return;
      }
    }

    if (step === 2) {
      if (!formData.address.trim()) {
        toast.error("يرجى إدخال العنوان التفصيلي للفرع");
        return;
      }
    }

    if (step === 4) {
      const selected = services.filter((s) => s.selected);
      if (selected.length === 0) {
        toast.error("يرجى اختيار خدمة واحدة على الأقل لتقديمها للعملاء");
        return;
      }
    }

    setStep((prev) => Math.min(6, prev + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handlePrev = () => {
    setStep((prev) => Math.max(1, prev - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleAddCustomService = () => {
    if (!newServiceName.trim()) {
      toast.error("يرجى كتابة اسم الخدمة");
      return;
    }
    setServices((prev) => [
      ...prev,
      {
        name: newServiceName.trim(),
        price: Number(newServicePrice) || 100,
        durationMin: Number(newServiceDuration) || 30,
        selected: true,
      },
    ]);
    setNewServiceName("");
    setNewServicePrice(150);
    setNewServiceDuration(30);
    toast.success("تمت إضافة الخدمة بنجاح");
  };

  const handleAddSimulatedFile = (name: string) => {
    if (!documents.includes(name)) {
      setDocuments((prev) => [...prev, name]);
      toast.success(`تم إرفاق: ${name}`);
    }
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);
      const selectedServices: ApplicationService[] = services
        .filter((s) => s.selected)
        .map((s) => ({
          name: s.name,
          price: s.price,
          durationMin: s.durationMin,
        }));

      const payload: SubmitApplicationPayload = {
        businessName: formData.businessName.trim(),
        ownerName: formData.ownerName.trim(),
        phone: formData.phone.trim(),
        email: formData.email.trim(),
        branchName: formData.branchName.trim() || formData.businessName.trim(),
        area: formData.area,
        address: formData.address.trim(),
        lat: formData.lat,
        lng: formData.lng,
        capacity: formData.capacity,
        workingHours,
        services: selectedServices,
        documents,
      };

      const res = await submitApplication(payload);
      setActiveApp(res);
      if (typeof window !== "undefined") {
        localStorage.setItem("carzen_application_id", res.id);
      }
      toast.success("تم إرسال طلب الانضمام بنجاح!");
      router.replace(`/register?id=${res.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "حدث خطأ أثناء إرسال الطلب";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // --- RENDER: STATUS SCREEN ---
  if (activeApp) {
    const isApproved = activeApp.status === "approved";
    const isNeedsChanges = activeApp.status === "needs_changes";
    const isRejected = activeApp.status === "rejected";

    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <div className="text-center">
          <BrandLogo subtitle="بوابة الشركاء" className="mx-auto mb-6" />
          <div
            className={`mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl ${
              isApproved
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : isNeedsChanges
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : isRejected
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-sky-500/15 text-sky-600 dark:text-sky-400"
            }`}
          >
            {isApproved ? (
              <CheckCircle2 className="size-8" />
            ) : isNeedsChanges ? (
              <AlertCircle className="size-8" />
            ) : isRejected ? (
              <Trash2 className="size-8" />
            ) : (
              <Clock3 className="size-8" />
            )}
          </div>

          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {isApproved
              ? "تهانينا! تمت الموافقة على مغسلتك 🎉"
              : isNeedsChanges
              ? "مطلوب استكمال بعض التعديلات"
              : isRejected
              ? "نعتذر، لم يتم قبول الطلب"
              : "طلبك قيد المراجعة الآن ⏳"}
          </h1>

          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            {isApproved
              ? "تم اعتماد حسابك وفرعك على منصة كارزن بنجاح. يمكنك الآن الدخول لبوابة الشركاء لبدء التشغيل."
              : isNeedsChanges
              ? activeApp.reviewNote || "يرجى مراجعة الملاحظات وتعديل البيانات المطلوبة للتفعيل."
              : isRejected
              ? activeApp.reviewNote || "شكراً لاهتمامك، لا تتطابق بيانات المغسلة مع معايير المنصة الحالية."
              : "يقوم فريق مراجعة شركاء كارزن بفحص المستندات ومعاينة الموقع وسيتم إشعارك خلال 24 ساعة."}
          </p>
        </div>

        <Card className="mt-8 border-border/60 shadow-sm">
          <CardContent className="space-y-4 p-6">
            <div className="flex items-center justify-between border-b pb-3 text-sm">
              <span className="text-muted-foreground">رقم الطلب</span>
              <span className="num font-semibold text-primary">{activeApp.id}</span>
            </div>
            <div className="flex items-center justify-between border-b pb-3 text-sm">
              <span className="text-muted-foreground">اسم المنشأة</span>
              <span className="font-medium">{activeApp.businessName}</span>
            </div>
            <div className="flex items-center justify-between border-b pb-3 text-sm">
              <span className="text-muted-foreground">المالك / المسؤول</span>
              <span className="font-medium">{activeApp.ownerName}</span>
            </div>
            <div className="flex items-center justify-between border-b pb-3 text-sm">
              <span className="text-muted-foreground">رقم الهاتف</span>
              <span className="num font-medium dir-ltr text-right">{activeApp.phone}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">حالة الطلب</span>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  isApproved
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                    : isNeedsChanges
                    ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                    : isRejected
                    ? "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                    : "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
                }`}
              >
                {isApproved
                  ? "معتمد (Approved)"
                  : isNeedsChanges
                  ? "مطلوب تعديلات"
                  : isRejected
                  ? "مرفوض"
                  : "قيد المراجعة (Pending)"}
              </span>
            </div>
          </CardContent>
        </Card>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {isApproved ? (
            <Link href="/login" className="w-full sm:w-auto">
              <Button size="lg" className="w-full">
                دخول بوابة الشركاء (تسجيل الدخول)
              </Button>
            </Link>
          ) : (
            <Button
              variant="outline"
              onClick={() => loadApplicationStatus(activeApp.id)}
              disabled={fetchingStatus}
              className="w-full sm:w-auto"
            >
              <RefreshCw className={`me-2 size-4 ${fetchingStatus ? "animate-spin" : ""}`} />
              تحديث حالة الطلب
            </Button>
          )}

          <Button
            variant="ghost"
            onClick={() => {
              if (typeof window !== "undefined") {
                localStorage.removeItem("carzen_application_id");
              }
              setActiveApp(null);
              setStep(1);
              router.replace("/register");
            }}
            className="w-full sm:w-auto text-muted-foreground"
          >
            تقديم طلب لمغسلة أخرى
          </Button>
        </div>
      </div>
    );
  }

  // --- RENDER: WIZARD FORM ---
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      {/* Top Header */}
      <header className="mb-8 flex flex-col items-center text-center">
        <BrandLogo subtitle="بوابة الشركاء" className="mb-4" />
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">طلب انضمام مغسلة شريكة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          انضم إلى شبكة كارزن واجعل مغسلتك رقمية بالكامل لاستقبال آلاف حجوزات العملاء.
        </p>
        <div className="mt-3 text-xs text-muted-foreground">
          لديك حساب شريك بالفعل؟{" "}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            تسجيل الدخول هنا
          </Link>
        </div>
      </header>

      {/* Progress Steps Indicator */}
      <div className="mb-8 overflow-x-auto pb-2">
        <div className="flex min-w-[560px] items-center justify-between">
          {STEPS.map((s, idx) => {
            const isDone = s.num < step;
            const isCurrent = s.num === step;
            const Icon = s.icon;

            return (
              <div key={s.num} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={`flex size-10 items-center justify-center rounded-xl text-sm font-semibold transition-all ${
                      isDone
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : isCurrent
                        ? "border-2 border-primary bg-primary/10 text-primary ring-4 ring-primary/15"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isDone ? <Check className="size-5" /> : <Icon className="size-4" />}
                  </div>
                  <span
                    className={`text-xs whitespace-nowrap ${
                      isCurrent ? "font-bold text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {s.title}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div
                    className={`mx-2 mb-4 h-0.5 w-10 sm:w-16 transition-colors ${
                      s.num < step ? "bg-primary" : "bg-border"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step Content Card */}
      <Card className="border-border/60 shadow-md">
        <CardContent className="p-6 sm:p-8">
          {/* STEP 1: BUSINESS & OWNER INFO */}
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">1. بيانات المنشأة والمالك</h2>
                <p className="text-sm text-muted-foreground">
                  المعلومات الأساسية للتواصل والتسجيل الرسمي لحساب المغسلة.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="businessName">اسم المغسلة التجاري *</Label>
                  <Input
                    id="businessName"
                    placeholder="مثال: مغسلة النور لخدمات السيارات"
                    value={formData.businessName}
                    onChange={(e) => setFormData({ ...formData, businessName: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ownerName">اسم المالك أو المسؤول *</Label>
                  <Input
                    id="ownerName"
                    placeholder="مثال: كريم عبد السلام"
                    value={formData.ownerName}
                    onChange={(e) => setFormData({ ...formData, ownerName: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phone">رقم الموبايل للتسجيل والتواصل *</Label>
                  <Input
                    id="phone"
                    type="tel"
                    dir="ltr"
                    className="text-right"
                    placeholder="01012345678"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    سيتم استخدام هذا الرقم لتسجيل دخول المالك إلى بوابة الشركاء لاحقاً.
                  </p>
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="email">البريد الإلكتروني (اختياري)</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="owner@wash.com"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: LOCATION & BRANCH */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">2. موقع الفرع والعنوان</h2>
                <p className="text-sm text-muted-foreground">
                  تحديد المنطقة والعنوان الدقيق ليتمكن العملاء من الوصول إليك بسهولة.
                </p>
              </div>

              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="branchName">اسم الفرع (اختياري)</Label>
                    <Input
                      id="branchName"
                      placeholder="مثال: فرع التسعين الشمالي"
                      value={formData.branchName}
                      onChange={(e) => setFormData({ ...formData, branchName: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="area">المنطقة الجغرافية *</Label>
                    <select
                      id="area"
                      value={formData.area}
                      onChange={(e) => setFormData({ ...formData, area: e.target.value })}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {AREAS.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="address">العنوان التفصيلي للفرع *</Label>
                  <Textarea
                    id="address"
                    rows={2}
                    placeholder="مثال: شارع التسعين الشمالي، محطة بنزين وطنية، التجمع الخامس، القاهرة الجديدة"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  />
                </div>

                {/* Simulated Coordinates Card */}
                <div className="rounded-xl border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <MapPin className="size-4 text-primary" />
                    <span>إحداثيات الموقع على الخريطة (GPS Coordinates)</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    تُستخدم لحساب المسافة الدقيقة بين العميل والمغسلة على تطبيق كارزن.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-4 text-xs font-mono">
                    <span className="rounded bg-muted px-2 py-1">خط العرض (Lat): {formData.lat}</span>
                    <span className="rounded bg-muted px-2 py-1">خط الطول (Lng): {formData.lng}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: CAPACITY & HOURS */}
          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">3. سعة المغسلة وساعات العمل</h2>
                <p className="text-sm text-muted-foreground">
                  تحديد سعة حارات الغسيل ومواعيد العمل الأسبوعية لمنع تكدس الحجوزات.
                </p>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="capacity">
                    سعة حارات الغسيل (عدد السيارات في نفس الوقت) *
                  </Label>
                  <div className="flex items-center gap-3">
                    <Input
                      id="capacity"
                      type="number"
                      min={1}
                      max={20}
                      className="w-28 text-center font-bold"
                      value={formData.capacity}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          capacity: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                        })
                      }
                    />
                    <span className="text-sm text-muted-foreground">حارة غسيل متزامنة (Bays)</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <Label className="text-sm font-semibold">مواعيد العمل خلال أيام الأسبوع:</Label>
                  <div className="divide-y rounded-xl border bg-muted/15">
                    {workingHours.map((h, i) => (
                      <div
                        key={i}
                        className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                      >
                        <span className="w-24 font-medium">{WEEKDAYS[i]}</span>

                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={h.closed}
                              onChange={(e) => {
                                const copy = [...workingHours];
                                copy[i] = { ...copy[i], closed: e.target.checked };
                                setWorkingHours(copy);
                              }}
                              className="size-4 accent-primary"
                            />
                            عطلة
                          </label>

                          {!h.closed ? (
                            <div className="flex items-center gap-1.5 font-mono text-xs">
                              <Input
                                type="time"
                                value={h.open}
                                onChange={(e) => {
                                  const copy = [...workingHours];
                                  copy[i] = { ...copy[i], open: e.target.value };
                                  setWorkingHours(copy);
                                }}
                                className="h-8 w-24 p-1 text-center"
                              />
                              <span>إلى</span>
                              <Input
                                type="time"
                                value={h.close}
                                onChange={(e) => {
                                  const copy = [...workingHours];
                                  copy[i] = { ...copy[i], close: e.target.value };
                                  setWorkingHours(copy);
                                }}
                                className="h-8 w-24 p-1 text-center"
                              />
                            </div>
                          ) : (
                            <span className="text-xs font-semibold text-rose-500">مغلق طوال اليوم</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: SERVICES & PRICING */}
          {step === 4 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">4. باقات وخدمات الغسيل</h2>
                <p className="text-sm text-muted-foreground">
                  حدد الخدمات التي تقدمها مع أسعارها المقترحة ومتوسط المدة بالدقائق.
                </p>
              </div>

              <div className="space-y-3">
                {services.map((svc, idx) => (
                  <div
                    key={idx}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                      svc.selected
                        ? "border-primary/50 bg-primary/5 shadow-xs"
                        : "border-border/60 bg-muted/20 opacity-70"
                    }`}
                  >
                    <label className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={svc.selected}
                        onChange={(e) => {
                          const copy = [...services];
                          copy[idx] = { ...copy[idx], selected: e.target.checked };
                          setServices(copy);
                        }}
                        className="size-4.5 accent-primary"
                      />
                      <div>
                        <div className="font-semibold">{svc.name}</div>
                        <div className="text-xs text-muted-foreground">
                          المدة: {svc.durationMin} دقيقة تقريبية
                        </div>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          value={svc.price}
                          disabled={!svc.selected}
                          onChange={(e) => {
                            const copy = [...services];
                            copy[idx] = { ...copy[idx], price: Number(e.target.value) || 0 };
                            setServices(copy);
                          }}
                          className="h-9 w-20 text-center font-bold"
                        />
                        <span className="text-xs text-muted-foreground">ج.م</span>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Add Custom Service Row */}
                <div className="mt-4 rounded-xl border border-dashed p-4">
                  <div className="mb-2 text-xs font-semibold text-muted-foreground">
                    إضافة خدمة أخرى خاصة بمغسلتك:
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      placeholder="اسم الخدمة (مثال: نانو سيراميك)"
                      value={newServiceName}
                      onChange={(e) => setNewServiceName(e.target.value)}
                      className="flex-1 min-w-[160px]"
                    />
                    <Input
                      type="number"
                      placeholder="السعر"
                      value={newServicePrice}
                      onChange={(e) => setNewServicePrice(Number(e.target.value) || 0)}
                      className="w-20 text-center"
                    />
                    <Input
                      type="number"
                      placeholder="المدة"
                      value={newServiceDuration}
                      onChange={(e) => setNewServiceDuration(Number(e.target.value) || 20)}
                      className="w-20 text-center"
                    />
                    <Button type="button" variant="secondary" onClick={handleAddCustomService}>
                      <Plus className="me-1 size-4" /> إضافة
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: DOCUMENTS & PHOTOS */}
          {step === 5 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">5. المستندات والصور</h2>
                <p className="text-sm text-muted-foreground">
                  رفع المستندات يعجل من سرعة اعتماد المغسلة وتفعيلها فوراً للعملاء.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div
                  onClick={() => handleAddSimulatedFile(`صورة_واجهة_${Date.now().toString(36)}.jpg`)}
                  className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center transition-colors hover:bg-primary/10"
                >
                  <Upload className="mb-2 size-8 text-primary" />
                  <span className="text-sm font-semibold">صورة واجهة المغسلة</span>
                  <span className="mt-1 text-xs text-muted-foreground">اضغط لرفع صورة JPG أو PNG</span>
                </div>

                <div
                  onClick={() => handleAddSimulatedFile(`سجل_تجاري_${Date.now().toString(36)}.pdf`)}
                  className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/30 p-6 text-center transition-colors hover:bg-muted/50"
                >
                  <FileText className="mb-2 size-8 text-muted-foreground" />
                  <span className="text-sm font-semibold">السجل التجاري أو البطاقة الضريبية</span>
                  <span className="mt-1 text-xs text-muted-foreground">اضغط لرفع ملف PDF أو صورة</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">المستندات المرفقة بالطلب ({documents.length}):</Label>
                <div className="space-y-1.5">
                  {documents.map((doc, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 text-primary" />
                        <span className="font-medium">{doc}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDocuments(documents.filter((_, idx) => idx !== i))}
                        className="text-rose-500 hover:text-rose-700"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP 6: REVIEW & CONFIRM */}
          {step === 6 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">6. مراجعة وتأكيد بيانات الطلب</h2>
                <p className="text-sm text-muted-foreground">
                  تأكد من صحة بياناتك قبل الإرسال النهائي لفريق اعتماد الشركاء.
                </p>
              </div>

              <div className="space-y-4 text-sm">
                <div className="rounded-xl border bg-muted/20 p-4 space-y-2">
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">اسم المغسلة:</span>
                    <span className="font-bold text-foreground">{formData.businessName}</span>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">المالك / المسؤول:</span>
                    <span className="font-semibold">{formData.ownerName}</span>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">رقم الهاتف:</span>
                    <span className="num font-semibold dir-ltr text-right">{formData.phone}</span>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">المنطقة والعنوان:</span>
                    <span className="text-right">
                      {AREAS.find((a) => a.id === formData.area)?.name} — {formData.address}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">سعة المغسلة:</span>
                    <span className="font-bold">{formData.capacity} سيارات في نفس الوقت</span>
                  </div>
                </div>

                <div className="rounded-xl border bg-muted/20 p-4">
                  <div className="mb-2 font-bold">
                    الخدمات المختارة ({services.filter((s) => s.selected).length}):
                  </div>
                  <ul className="space-y-1 text-xs">
                    {services
                      .filter((s) => s.selected)
                      .map((s, i) => (
                        <li key={i} className="flex justify-between">
                          <span>{s.name}</span>
                          <span className="font-semibold text-primary">
                            {s.price} ج.م ({s.durationMin} دقيقة)
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Wizard Footer Controls */}
          <div className="mt-8 flex items-center justify-between border-t pt-6">
            {step > 1 ? (
              <Button type="button" variant="outline" onClick={handlePrev} disabled={loading}>
                <ArrowRight className="me-2 size-4" /> السابق
              </Button>
            ) : (
              <div />
            )}

            {step < 6 ? (
              <Button type="button" onClick={handleNext}>
                التالي <ArrowLeft className="ms-2 size-4" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
              >
                {loading ? (
                  <>
                    <RefreshCw className="me-2 size-4 animate-spin" /> جاري إرسال الطلب...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="me-2 size-4" /> إرسال طلب الانضمام
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
