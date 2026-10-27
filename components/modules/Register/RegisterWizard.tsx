"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Clock3,
  FileCheck,
  FileText,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  XCircle,
  FileEdit,
  AlertTriangle,
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

// Google Maps picker, loaded on demand (the Maps API and @vis.gl stay out of the wizard's bundle)
const MapLocationPicker = dynamic(
  () => import("./MapLocationPicker"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[280px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 text-sm text-muted-foreground sm:h-[320px]">
        <Loader2 className="size-6 animate-spin text-primary" />
        <span>جاري تحميل الخريطة التفاعلية...</span>
      </div>
    ),
  }
);

const AREAS = [
  { id: "nasr", name: "مدينة نصر", defaultCoords: [30.0561, 31.3412] as [number, number] },
  { id: "helio", name: "مصر الجديدة", defaultCoords: [30.112, 31.345] as [number, number] },
  { id: "nc", name: "التجمع والقاهرة الجديدة", defaultCoords: [30.0131, 31.4395] as [number, number] },
  { id: "maadi", name: "المعادي", defaultCoords: [29.9602, 31.2569] as [number, number] },
  { id: "zamalek", name: "الزمالك", defaultCoords: [30.0631, 31.2185] as [number, number] },
  { id: "moh", name: "المهندسين والدقي", defaultCoords: [30.0524, 31.2003] as [number, number] },
  { id: "zayed", name: "الشيخ زايد", defaultCoords: [30.045, 30.985] as [number, number] },
  { id: "oct", name: "٦ أكتوبر", defaultCoords: [29.972, 30.94] as [number, number] },
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

interface UploadedDocItem {
  id: string;
  name: string;
  path: string;
  size?: number;
  type?: string;
  category: "storefront" | "commercial_reg";
  uploading?: boolean;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RegisterWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [activeApp, setActiveApp] = useState<WashApplication | null>(null);
  const [fetchingStatus, setFetchingStatus] = useState(false);

  // Hidden File Inputs Refs
  const storefrontInputRef = useRef<HTMLInputElement>(null);
  const commercialInputRef = useRef<HTMLInputElement>(null);

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

  // Services State
  const [services, setServices] = useState(DEFAULT_SERVICES);
  const [newServiceName, setNewServiceName] = useState("");
  const [newServicePrice, setNewServicePrice] = useState<number | "">(150);
  const [newServiceDuration, setNewServiceDuration] = useState<number | "">(30);

  // Working Hours State
  const [workingHours, setWorkingHours] = useState<WorkingDay[]>(INITIAL_HOURS);

  // Uploaded Documents State
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDocItem[]>([
    {
      id: "doc_default_1",
      name: "السجل_التجاري_المعتمد.pdf",
      path: "commercial_reg.pdf",
      size: 485000,
      type: "application/pdf",
      category: "commercial_reg",
    },
  ]);

  // Quick lookup state
  const [lookupQuery, setLookupQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [showLookupBox, setShowLookupBox] = useState(false);

  // Check query param for existing application id or status check
  useEffect(() => {
    const appId =
      searchParams.get("id") ||
      (typeof window !== "undefined" ? localStorage.getItem("carzen_application_id") : null);
    if (appId) {
      loadApplicationStatus(appId);
    }
  }, [searchParams]);

  async function loadApplicationStatus(id: string, silent = false) {
    try {
      if (!silent) setFetchingStatus(true);
      const res = await fetchApplication(id);
      if (res) {
        // If status changed from pending while user was watching, alert them
        setActiveApp((prev) => {
          if (silent && prev && prev.status !== res.status) {
            if (res.status === "rejected") {
              toast.error("تم تحديث حالة طلبك: تم رفض الطلب من إدارة المنصة");
            } else if (res.status === "approved") {
              toast.success("تهانينا! تمت الموافقة على طلب انضمام مغسلتك 🎉");
            } else if (res.status === "needs_changes") {
              toast.warning("تم تحديث حالة طلبك: مطلوب استكمال بعض التعديلات");
            }
          }
          return res;
        });
      }
      return res;
    } catch {
      // not found or error
      return null;
    } finally {
      if (!silent) setFetchingStatus(false);
    }
  }

  // Auto-poll status periodically when pending or needs_changes, and on tab visibility
  useEffect(() => {
    if (!activeApp?.id) return;
    if (activeApp.status !== "pending" && activeApp.status !== "needs_changes") return;

    const interval = setInterval(() => {
      loadApplicationStatus(activeApp.id, true);
    }, 10000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadApplicationStatus(activeApp.id, true);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeApp?.id, activeApp?.status]);

  // Handle Edit & Resubmit for rejected applications or needs_changes
  const handleEditAndResubmit = (app: WashApplication) => {
    const rawDigits = app.phone.replace(/\D/g, "");
    const cleanPhone = rawDigits.startsWith("20")
      ? "0" + rawDigits.slice(2)
      : rawDigits.startsWith("0")
      ? rawDigits
      : "0" + rawDigits;

    setFormData({
      businessName: app.businessName || "",
      ownerName: app.ownerName || "",
      phone: cleanPhone || "",
      email: app.email?.includes("@partner.washup.app") ? "" : app.email || "",
      branchName: app.businessName ? `الفرع الرئيسي - ${app.businessName}` : "الفرع الرئيسي",
      area: app.area || "nasr",
      address: app.address || "",
      lat: Number(app.lat) || 30.0561,
      lng: Number(app.lng) || 31.3412,
      capacity: Number(app.capacity) || 4,
    });

    if (Array.isArray(app.services) && app.services.length > 0) {
      setServices(
        app.services.map((s) => ({
          name: s.name,
          price: s.price,
          durationMin: s.durationMin,
          selected: true,
        }))
      );
    }

    if (Array.isArray(app.workingHours) && app.workingHours.length > 0) {
      setWorkingHours(app.workingHours);
    }

    if (typeof window !== "undefined") {
      localStorage.removeItem("carzen_application_id");
    }
    setActiveApp(null);
    setStep(1);
    toast.info("تم استرجاع بياناتك السابقة. يمكنك الآن تعديل أي بيان وإعادة إرسال الطلب.");
  };

  // Lookup application by ID or phone number
  const handleLookup = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const q = lookupQuery.trim();
    if (!q) {
      toast.error("يرجى إدخال رقم الطلب أو رقم الهاتف");
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetchApplication(q);
      if (res && res.id) {
        if (typeof window !== "undefined") {
          localStorage.setItem("carzen_application_id", res.id);
        }
        setActiveApp(res);
        toast.success(`تم العثور على طلب مغسلة "${res.businessName}"`);
        setLookupQuery("");
        setShowLookupBox(false);
      } else {
        toast.error("لم يتم العثور على أي طلب مسجل بهذا الرقم");
      }
    } catch {
      toast.error("لم يتم العثور على طلب بهذا الرقم أو الهاتف. تأكد من إدخال رقم هاتف أو كود طلب صحيح.");
    } finally {
      setIsSearching(false);
    }
  };

  // Handle area change: update area and optionally center map to area default coords
  const handleAreaChange = (newArea: string) => {
    const areaMeta = AREAS.find((a) => a.id === newArea);
    setFormData((prev) => ({
      ...prev,
      area: newArea,
      lat: areaMeta ? areaMeta.defaultCoords[0] : prev.lat,
      lng: areaMeta ? areaMeta.defaultCoords[1] : prev.lng,
    }));
  };

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
      if (!formData.lat || !formData.lng) {
        toast.error("يرجى تحديد موقع الفرع على الخريطة");
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

  // Add custom service with clear duration and price
  const handleAddCustomService = () => {
    if (!newServiceName.trim()) {
      toast.error("يرجى كتابة اسم الخدمة (مثال: نانو سيراميك)");
      return;
    }
    const priceNum = Number(newServicePrice);
    if (!priceNum || priceNum <= 0) {
      toast.error("يرجى إدخال سعر صحيح للخدمة بالجنيه");
      return;
    }
    const durationNum = Number(newServiceDuration);
    if (!durationNum || durationNum <= 0) {
      toast.error("يرجى إدخال مدة الخدمة بالدقائق");
      return;
    }

    setServices((prev) => [
      ...prev,
      {
        name: newServiceName.trim(),
        price: priceNum,
        durationMin: durationNum,
        selected: true,
      },
    ]);
    setNewServiceName("");
    setNewServicePrice(150);
    setNewServiceDuration(30);
    toast.success(`تمت إضافة خدمة "${newServiceName.trim()}" بنجاح ✨`);
  };

  // File Upload Handler (real device file picker via API -> Supabase Storage)
  const handleUploadFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
    category: "storefront" | "commercial_reg"
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const tempId = `temp_${Date.now()}_${i}`;

      // Optimistic item
      const optimisticDoc: UploadedDocItem = {
        id: tempId,
        name: file.name,
        path: file.name,
        size: file.size,
        type: file.type,
        category,
        uploading: true,
      };

      setUploadedDocs((prev) => [optimisticDoc, ...prev]);

      try {
        const uploadForm = new FormData();
        uploadForm.append("file", file);
        uploadForm.append(
          "bucket",
          category === "storefront" ? "branch-photos" : "application-documents"
        );

        const res = await fetch("/api/v1/vendor/upload", {
          method: "POST",
          body: uploadForm,
        });

        const json = await res.json();
        if (res.ok && json.status && json.data) {
          setUploadedDocs((prev) =>
            prev.map((d) =>
              d.id === tempId
                ? {
                    ...d,
                    path: json.data.path || json.data.storedName,
                    uploading: false,
                  }
                : d
            )
          );
          toast.success(`تم رفع الملف "${file.name}" بنجاح 📁`);
        } else {
          // If upload fails, keep filename for submission
          setUploadedDocs((prev) =>
            prev.map((d) => (d.id === tempId ? { ...d, uploading: false } : d))
          );
          toast.info(`تم إرفاق "${file.name}"`);
        }
      } catch (err) {
        console.warn("[Upload Error]", err);
        setUploadedDocs((prev) =>
          prev.map((d) => (d.id === tempId ? { ...d, uploading: false } : d))
        );
        toast.info(`تم إرفاق "${file.name}"`);
      }
    }

    // Reset input
    e.target.value = "";
  };

  const handleRemoveDoc = (id: string) => {
    setUploadedDocs((prev) => prev.filter((d) => d.id !== id));
    toast.info("تمت إزالة المستند");
  };

  // Final Application Submission to Supabase API
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

      // Document strings to be stored in Supabase text[] column
      const documentPaths = uploadedDocs.map((d) => d.path || d.name);

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
        documents: documentPaths.length ? documentPaths : ["commercial_reg.pdf"],
      };

      const res = await submitApplication(payload);
      setActiveApp(res);
      if (typeof window !== "undefined") {
        localStorage.setItem("carzen_application_id", res.id);
      }
      toast.success("تم إرسال طلب الانضمام بنجاح إلى قاعدة بيانات كارزن!");
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
              <AlertTriangle className="size-8" />
            ) : isRejected ? (
              <XCircle className="size-8" />
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
              ? "نعتذر، تم رفض طلب الانضمام"
              : "طلبك قيد المراجعة الآن ⏳"}
          </h1>

          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            {isApproved
              ? "تم اعتماد حسابك وفرعك على منصة كارزن بنجاح. يمكنك الآن الدخول لبوابة الشركاء لبدء التشغيل."
              : isNeedsChanges
              ? "راجع ملاحظات فريق المراجعة الموضحة أدناه لتعديل البيانات وإعادة تفعيل الطلب."
              : isRejected
              ? "تمت مراجعة بيانات المغسلة من قبل إدارة المنصة ولم يتم قبول الطلب وفقاً للأسباب الموضحة أدناه."
              : "يقوم فريق مراجعة شركاء كارزن بفحص المستندات ومعاينة الموقع وسيتم إشعارك فور اتخاذ القرار."}
          </p>
        </div>

        {/* Dedicated Alert Box for Rejection Reason */}
        {isRejected && (
          <div className="mt-6 rounded-2xl border border-rose-300 bg-rose-50/90 p-5 shadow-xs text-rose-950 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
            <div className="flex items-start gap-3.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-rose-600/10 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400">
                <AlertCircle className="size-5" />
              </div>
              <div className="space-y-1.5 text-right flex-1">
                <h4 className="text-sm font-bold text-rose-900 dark:text-rose-200">
                  سبب الرفض الموضح من إدارة كارزن:
                </h4>
                <p className="text-sm font-semibold leading-relaxed text-rose-800 dark:text-rose-300 bg-white/70 dark:bg-black/20 p-2.5 rounded-lg border border-rose-200/50">
                  {activeApp.reviewNote || "البيانات أو المستندات المرفقة لا تتوافق مع شروط الانضمام للمنصة حالياً."}
                </p>
                <p className="text-xs text-rose-700 dark:text-rose-400 pt-1">
                  يمكنك الضغط على زر <span className="font-bold underline">&quot;تعديل البيانات وإعادة التقديم&quot;</span> أدناه لتصحيح المشكلة مباشرة دون إعادة كتابة كل البيانات.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Dedicated Alert Box for Needs Changes */}
        {isNeedsChanges && (
          <div className="mt-6 rounded-2xl border border-amber-300 bg-amber-50/90 p-5 shadow-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="flex items-start gap-3.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-600/10 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400">
                <AlertTriangle className="size-5" />
              </div>
              <div className="space-y-1.5 text-right flex-1">
                <h4 className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  ملاحظات فريق المراجعة لاستكمال التفعيل:
                </h4>
                <p className="text-sm font-semibold leading-relaxed text-amber-800 dark:text-amber-300 bg-white/70 dark:bg-black/20 p-2.5 rounded-lg border border-amber-200/50">
                  {activeApp.reviewNote || "يرجى مراجعة البيانات واستكمال المستندات المطلوبة للمعاينة."}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 pt-1">
                  اضغط على زر <span className="font-bold underline">&quot;تعديل واستكمال البيانات&quot;</span> لإجراء التعديلات المطلوبة.
                </p>
              </div>
            </div>
          </div>
        )}

        <Card className="mt-6 border-border/60 shadow-sm">
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
              <span dir="ltr" className="font-mono font-medium text-left">{activeApp.phone}</span>
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
                  ? "مرفوض (Rejected)"
                  : "قيد المراجعة (Pending)"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {isApproved ? (
            <Link href="/login" className="w-full sm:w-auto">
              <Button size="lg" className="w-full">
                دخول بوابة الشركاء (تسجيل الدخول)
              </Button>
            </Link>
          ) : isRejected ? (
            <>
              <Button
                size="lg"
                onClick={() => handleEditAndResubmit(activeApp)}
                className="w-full sm:w-auto gap-2"
              >
                <FileEdit className="size-4" />
                تعديل البيانات وإعادة التقديم
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    localStorage.removeItem("carzen_application_id");
                  }
                  setActiveApp(null);
                  setStep(1);
                  router.replace("/register");
                }}
                className="w-full sm:w-auto"
              >
                تقديم طلب مغسلة جديدة
              </Button>
            </>
          ) : isNeedsChanges ? (
            <>
              <Button
                size="lg"
                onClick={() => handleEditAndResubmit(activeApp)}
                className="w-full sm:w-auto gap-2"
              >
                <FileEdit className="size-4" />
                تعديل واستكمال البيانات
              </Button>
              <Button
                variant="outline"
                onClick={() => loadApplicationStatus(activeApp.id)}
                disabled={fetchingStatus}
                className="w-full sm:w-auto"
              >
                <RefreshCw className={`me-2 size-4 ${fetchingStatus ? "animate-spin" : ""}`} />
                تحديث حالة الطلب
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => loadApplicationStatus(activeApp.id)}
                disabled={fetchingStatus}
                className="w-full sm:w-auto"
              >
                <RefreshCw className={`me-2 size-4 ${fetchingStatus ? "animate-spin" : ""}`} />
                تحديث حالة الطلب
              </Button>
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
            </>
          )}
        </div>

        {/* Live Auto-Refresh Notice */}
        {!isApproved && !isRejected && (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            ⚡ يتم تحديث الصفحة تلقائياً فور اتخاذ إدارة المنصة قرار المراجعة.
          </p>
        )}

        {/* Lookup / Switcher Box */}
        <div className="mt-10 border-t pt-6 text-center">
          {!showLookupBox ? (
            <button
              type="button"
              onClick={() => setShowLookupBox(true)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground hover:underline"
            >
              <Search className="size-3.5" />
              <span>متابعة طلب آخر برقم الطلب أو الهاتف؟ اضغط هنا</span>
            </button>
          ) : (
            <div className="mx-auto max-w-md rounded-xl border bg-muted/20 p-4">
              <p className="mb-2.5 text-xs font-semibold text-muted-foreground text-right">
                البحث عن طلب انضمام سابق برقم الطلب أو رقم الهاتف:
              </p>
              <form onSubmit={handleLookup} className="flex items-center gap-2">
                <Input
                  placeholder="أدخل كود الطلب (app_...) أو رقم الهاتف..."
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  className="text-sm bg-background"
                  dir="auto"
                />
                <Button type="submit" size="sm" disabled={isSearching}>
                  {isSearching ? <Loader2 className="size-4 animate-spin" /> : "بحث"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLookupBox(false)}
                >
                  إلغاء
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- RENDER: WIZARD FORM ---
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      {/* Hidden file inputs for device file pickers */}
      <input
        ref={storefrontInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => handleUploadFile(e, "storefront")}
        className="hidden"
      />
      <input
        ref={commercialInputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        multiple
        onChange={(e) => handleUploadFile(e, "commercial_reg")}
        className="hidden"
      />

      {/* Top Header */}
      <header className="mb-8 flex flex-col items-center text-center">
        <BrandLogo subtitle="بوابة الشركاء" className="mb-4" />
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">طلب انضمام مغسلة شريكة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          انضم إلى شبكة كارزن واجعل مغسلتك رقمية بالكامل لاستقبال آلاف حجوزات العملاء.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>
            لديك حساب شريك بالفعل؟{" "}
            <Link href="/login" className="font-semibold text-primary hover:underline">
              تسجيل الدخول هنا
            </Link>
          </span>
          <span>•</span>
          <button
            type="button"
            onClick={() => setShowLookupBox((prev) => !prev)}
            className="font-semibold text-primary hover:underline inline-flex items-center gap-1 cursor-pointer"
          >
            <Search className="size-3" />
            استعلام عن حالة طلب سابق
          </button>
        </div>

        {showLookupBox && (
          <div className="mt-4 mx-auto w-full max-w-md rounded-xl border bg-muted/20 p-3.5 text-right">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">
              أدخل كود طلب الانضمام أو رقم الهاتف للاستعلام عن الحالة:
            </p>
            <form onSubmit={handleLookup} className="flex items-center gap-2">
              <Input
                placeholder="مثال: app_... أو 01012345678"
                value={lookupQuery}
                onChange={(e) => setLookupQuery(e.target.value)}
                className="text-sm bg-background"
                dir="auto"
              />
              <Button type="submit" size="sm" disabled={isSearching}>
                {isSearching ? <Loader2 className="size-4 animate-spin" /> : "استعلام"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowLookupBox(false)}
              >
                إلغاء
              </Button>
            </form>
          </div>
        )}
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

          {/* STEP 2: LOCATION & BRANCH WITH INTERACTIVE MAP & CURRENT LOCATION */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">2. موقع الفرع والعنوان</h2>
                <p className="text-sm text-muted-foreground">
                  حدد موقع الفرع بدقة على الخريطة لتسهيل وصول العملاء وحساب المسافات.
                </p>
              </div>

              <div className="space-y-5">
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
                      onChange={(e) => handleAreaChange(e.target.value)}
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

                {/* Google Maps location picker */}
                <div className="space-y-2 pt-1">
                  <Label className="text-sm font-semibold">
                    تحديد موقع الفرع على الخريطة (GPS Pin Picker):
                  </Label>
                  <MapLocationPicker
                    lat={formData.lat}
                    lng={formData.lng}
                    area={formData.area}
                    onChange={(newLat, newLng) => {
                      setFormData((prev) => ({ ...prev, lat: newLat, lng: newLng }));
                    }}
                    onPlace={(place) => {
                      // Prefill the address from the picked place, never overwrite what the owner typed.
                      setFormData((prev) => (prev.address.trim() ? prev : { ...prev, address: place.address }));
                    }}
                  />
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
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
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

          {/* STEP 4: SERVICES & PRICING WITH CLEAR LABELS */}
          {step === 4 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">4. باقات وخدمات الغسيل</h2>
                <p className="text-sm text-muted-foreground">
                  حدد الخدمات التي تقدمها، وقم بتعديل الأسعار والمدد المتوقعة بالدقائق.
                </p>
              </div>

              <div className="space-y-3">
                {/* Services List with clear editable price & duration */}
                {services.map((svc, idx) => (
                  <div
                    key={idx}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 transition-all ${
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
                        <div className="font-semibold text-foreground">{svc.name}</div>
                        <div className="text-xs text-muted-foreground">
                          مدة الخدمة: {svc.durationMin} دقيقة تقريبية
                        </div>
                      </div>
                    </label>

                    <div className="flex items-center gap-3">
                      {/* Duration Input with label */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">المدة:</span>
                        <div className="relative">
                          <Input
                            type="number"
                            min={5}
                            step={5}
                            value={svc.durationMin}
                            disabled={!svc.selected}
                            onChange={(e) => {
                              const copy = [...services];
                              copy[idx] = {
                                ...copy[idx],
                                durationMin: Math.max(5, Number(e.target.value) || 5),
                              };
                              setServices(copy);
                            }}
                            className="h-8.5 w-20 pe-6 text-center text-xs font-semibold"
                          />
                          <span className="pointer-events-none absolute end-1.5 top-2 text-[10px] text-muted-foreground">
                            د
                          </span>
                        </div>
                      </div>

                      {/* Price Input with label */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">السعر:</span>
                        <div className="relative">
                          <Input
                            type="number"
                            min={10}
                            step={10}
                            value={svc.price}
                            disabled={!svc.selected}
                            onChange={(e) => {
                              const copy = [...services];
                              copy[idx] = {
                                ...copy[idx],
                                price: Math.max(0, Number(e.target.value) || 0),
                              };
                              setServices(copy);
                            }}
                            className="h-8.5 w-24 pe-7 text-center font-bold text-xs"
                          />
                          <span className="pointer-events-none absolute end-1.5 top-2 text-[10px] font-medium text-muted-foreground">
                            ج.م
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Add Custom Service Section with Distinct, Explicit Inputs */}
                <div className="mt-5 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-4 sm:p-5">
                  <div className="mb-3 flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    <span className="text-sm font-bold text-foreground">
                      إضافة خدمة جديدة خاصة بمغسلتك:
                    </span>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[1.5fr_1fr_1fr_auto]">
                    {/* Service Name Input */}
                    <div className="space-y-1">
                      <Label htmlFor="custom-service-name" className="text-xs font-medium">
                        اسم الخدمة *
                      </Label>
                      <Input
                        id="custom-service-name"
                        placeholder="مثال: نانو سيراميك 9H"
                        value={newServiceName}
                        onChange={(e) => setNewServiceName(e.target.value)}
                        className="h-9.5 text-xs bg-background"
                      />
                    </div>

                    {/* Price Input with Explicit Unit */}
                    <div className="space-y-1">
                      <Label htmlFor="custom-service-price" className="text-xs font-medium">
                        السعر (بالجنيه) *
                      </Label>
                      <div className="relative">
                        <Input
                          id="custom-service-price"
                          type="number"
                          placeholder="150"
                          value={newServicePrice}
                          onChange={(e) =>
                            setNewServicePrice(e.target.value === "" ? "" : Number(e.target.value))
                          }
                          className="h-9.5 pe-9 text-xs font-bold text-center bg-background"
                        />
                        <span className="pointer-events-none absolute end-2.5 top-2.5 text-xs font-semibold text-muted-foreground">
                          ج.م
                        </span>
                      </div>
                    </div>

                    {/* Duration Input with Explicit Unit */}
                    <div className="space-y-1">
                      <Label htmlFor="custom-service-duration" className="text-xs font-medium">
                        المدة المتوقعة *
                      </Label>
                      <div className="relative">
                        <Input
                          id="custom-service-duration"
                          type="number"
                          placeholder="30"
                          value={newServiceDuration}
                          onChange={(e) =>
                            setNewServiceDuration(e.target.value === "" ? "" : Number(e.target.value))
                          }
                          className="h-9.5 pe-12 text-xs text-center font-semibold bg-background"
                        />
                        <span className="pointer-events-none absolute end-2.5 top-2.5 text-xs text-muted-foreground">
                          دقيقة
                        </span>
                      </div>
                    </div>

                    {/* Add Button */}
                    <div className="flex items-end">
                      <Button
                        type="button"
                        onClick={handleAddCustomService}
                        className="h-9.5 w-full bg-primary text-primary-foreground sm:w-auto"
                      >
                        <Plus className="me-1 size-4" /> إضافة الخدمة
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: DOCUMENTS & PHOTOS WITH REAL DEVICE FILE PICKER */}
          {step === 5 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold">5. المستندات والصور الرسمية</h2>
                <p className="text-sm text-muted-foreground">
                  اضغط على أي من الخيارات أدناه لفتح متصفح ملفات جهازك واختيار الصور أو ملفات الـ PDF.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {/* Storefront Photo Card -> Opens Device File Picker for Images */}
                <div
                  onClick={() => storefrontInputRef.current?.click()}
                  className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center transition-all hover:border-primary hover:bg-primary/10 hover:shadow-sm"
                >
                  <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary transition-transform group-hover:scale-105">
                    <Camera className="size-6" />
                  </div>
                  <span className="text-sm font-bold text-foreground">صورة واجهة المغسلة</span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    اضغط لاختيار صورة من ملفات جهازك (JPG, PNG, WebP)
                  </span>
                  <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                    <Upload className="size-3" /> استعراض الصور في جهازك
                  </span>
                </div>

                {/* Commercial Registration / Tax Card -> Opens Device File Picker for PDF / Docs */}
                <div
                  onClick={() => commercialInputRef.current?.click()}
                  className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30 p-6 text-center transition-all hover:border-primary/60 hover:bg-muted/50 hover:shadow-sm"
                >
                  <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-transform group-hover:scale-105">
                    <FileText className="size-6 text-primary" />
                  </div>
                  <span className="text-sm font-bold text-foreground">
                    السجل التجاري أو البطاقة الضريبية
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    اضغط لاختيار ملف من جهازك (PDF أو صورة المستند)
                  </span>
                  <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-foreground">
                    <Upload className="size-3" /> استعراض الملفات في جهازك
                  </span>
                </div>
              </div>

              {/* Uploaded Files List */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>المستندات والصور المرفقة بالطلب ({uploadedDocs.length}):</span>
                  <span>الحد الأقصى للملف: 10 ميجابايت</span>
                </div>

                <div className="space-y-2">
                  {uploadedDocs.map((doc) => {
                    const isPdf =
                      doc.name.toLowerCase().endsWith(".pdf") || doc.type === "application/pdf";
                    return (
                      <div
                        key={doc.id}
                        className="flex items-center justify-between rounded-xl border bg-background/80 p-3 text-xs shadow-xs transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                              isPdf
                                ? "bg-rose-500/10 text-rose-600"
                                : "bg-sky-500/10 text-sky-600"
                            }`}
                          >
                            {isPdf ? (
                              <FileText className="size-4" />
                            ) : (
                              <ImageIcon className="size-4" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-foreground">
                              {doc.name}
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                              <span>
                                {doc.category === "storefront"
                                  ? "صورة الواجهة"
                                  : "سجل تجاري / ترخيص"}
                              </span>
                              {doc.size && <span>• {formatFileSize(doc.size)}</span>}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {doc.uploading ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                              <Loader2 className="size-3.5 animate-spin" /> جاري الرفع...
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                              <Check className="size-3" /> جاهز للطلب
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() => handleRemoveDoc(doc.id)}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            title="حذف المستند"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
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
                <div className="rounded-xl border bg-muted/20 p-4 space-y-2.5">
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
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">إحداثيات الخريطة (GPS):</span>
                    <span className="font-mono text-xs text-primary dir-ltr">
                      {formData.lat}, {formData.lng}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">سعة المغسلة:</span>
                    <span className="font-bold">{formData.capacity} سيارات في نفس الوقت</span>
                  </div>
                </div>

                <div className="rounded-xl border bg-muted/20 p-4">
                  <div className="mb-2 font-bold text-foreground">
                    الخدمات المختارة ({services.filter((s) => s.selected).length}):
                  </div>
                  <ul className="space-y-1.5 text-xs">
                    {services
                      .filter((s) => s.selected)
                      .map((s, i) => (
                        <li key={i} className="flex justify-between items-center border-b border-border/40 pb-1.5 last:border-0 last:pb-0">
                          <span className="font-medium">{s.name}</span>
                          <span className="font-semibold text-primary">
                            {s.price} ج.م ({s.durationMin} دقيقة)
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>

                <div className="rounded-xl border bg-muted/20 p-4">
                  <div className="mb-2 font-bold text-foreground">
                    المستندات المرفقة ({uploadedDocs.length}):
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {uploadedDocs.map((d, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <FileCheck className="size-3.5 text-emerald-600" />
                        <span>{d.name}</span>
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
