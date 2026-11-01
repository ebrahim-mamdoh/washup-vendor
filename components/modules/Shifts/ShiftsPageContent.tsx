"use client";

import { CalendarCheck2, ClipboardCheck } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlState } from "@/hooks/use-url-state";
import { DayClosingTab } from "@/components/modules/Shifts/DayClosingTab";
import { ShiftClockBar } from "@/components/modules/Shifts/ShiftClockBar";
import { ShiftClosingsTab } from "@/components/modules/Shifts/ShiftClosingsTab";
import { useAuthStore } from "@/lib/store/auth-store";

export type ShiftsUrlState = {
  tab: string;
  filter: string;
  page: number;
  shift: string;
  branch: string;
  date: string;
};

export type SetShiftsUrlState = (patch: Partial<ShiftsUrlState>, options?: { resetPage?: boolean }) => void;

/** D11 — shift closings review (MG-07 / OW-15) + end-of-day reconciliation (MG-08). */
export default function ShiftsPageContent() {
  const [state, setState] = useUrlState<ShiftsUrlState>({ tab: "closings", filter: "submitted", page: 1, shift: "", branch: "", date: "" });
  const canCloseDay = useAuthStore((s) => Boolean(s.account?.permissions.closeShift));

  return (
    <div className="space-y-6">
      <PageHeader
        title="الورديات والإغلاق"
        description="افتح ورديتك واقفلها بالنقدي الفعلي. المدير يراجع التقفيل ويغلق اليوم."
      />

      <ShiftClockBar />

      <Tabs value={state.tab} onValueChange={(tab) => setState({ tab: String(tab) })} className="gap-5">
        <TabsList className="h-10 w-full sm:w-fit">
          <TabsTrigger value="closings" className="px-4">
            <ClipboardCheck /> تقفيل الورديات
          </TabsTrigger>
          {canCloseDay ? (
            <TabsTrigger value="day" className="px-4">
              <CalendarCheck2 /> إغلاق اليوم
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="closings">
          <ShiftClosingsTab state={state} setState={setState} />
        </TabsContent>
        <TabsContent value="day">
          <DayClosingTab state={state} setState={setState} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
