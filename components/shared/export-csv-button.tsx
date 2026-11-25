"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "../ui/button";
import { CSV_MAX_ROWS, downloadCsv, fetchAllPages, type CsvColumn } from "../../lib/export-csv";

type ExportCsvButtonProps<T> = {
  filename: string;
  columns: CsvColumn<T>[];
  rows: T[] | undefined;
  label?: string;
  /**
   * GAP-076: loads one page of the full (filtered) list. When given, the export fetches every page
   * instead of only the rows on screen.
   */
  fetchPage?: (page: number, perPage: number) => Promise<{ items: T[]; pagination: { has_next: boolean } }>;
};

/** Exports the active filters' rows: every page when `fetchPage` is given, else the rows on screen. */
export function ExportCsvButton<T>({ filename, columns, rows, label = "تصدير CSV", fetchPage }: ExportCsvButtonProps<T>) {
  const [busy, setBusy] = useState(false);
  const exportAll = async () => {
    if (!fetchPage) return;
    setBusy(true);
    try {
      const all = await fetchAllPages(fetchPage);
      if (!all.rows.length) {
        toast.info("لا توجد بيانات للتصدير");
        return;
      }
      downloadCsv(filename, columns, all.rows);
      if (all.truncated) toast.warning(`تم تصدير أول ${CSV_MAX_ROWS} صف فقط — ضيّق الفلاتر لتصدير الباقي`);
      else toast.success(`تم تصدير ${all.rows.length} صف`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر تصدير البيانات");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="lg"
      disabled={!rows?.length || busy}
      loading={busy}
      onClick={() => {
        if (!rows?.length) return;
        if (fetchPage) {
          void exportAll();
          return;
        }
        downloadCsv(filename, columns, rows);
        toast.success(`تم تصدير ${rows.length} صف`);
      }}
    >
      {!busy ? <Download /> : null}
      {label}
    </Button>
  );
}
