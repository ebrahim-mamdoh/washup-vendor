import { getData, send } from "@/lib/api/request";
import type { SubmitApplicationPayload, WashApplication } from "@/types/applications";

export async function submitApplication(payload: SubmitApplicationPayload): Promise<WashApplication> {
  const res = await send<WashApplication>("post", "/vendor/applications", payload, "تعذر إرسال طلب الانضمام");
  return res.data;
}

export function fetchApplication(id: string) {
  return getData<WashApplication>(`/vendor/applications/${id}`, undefined, "تعذر تحميل بيانات الطلب");
}
