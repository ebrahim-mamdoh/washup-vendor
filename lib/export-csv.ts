/** Hard cap for one export: 50 pages of 100 rows. */
export const CSV_MAX_ROWS = 5000;

/**
 * GAP-076: loads every page of a paginated list (100 rows per request, the API maximum) with the
 * filters already applied, up to `CSV_MAX_ROWS`. Returns the rows and whether the cap cut it short.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<{ items: T[]; pagination: { has_next: boolean } }>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchPage(page, 100);
    rows.push(...res.items);
    if (!res.pagination.has_next || !res.items.length) return { rows, truncated: false };
    if (rows.length >= CSV_MAX_ROWS) return { rows: rows.slice(0, CSV_MAX_ROWS), truncated: true };
  }
}

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

function escapeCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Downloads rows as a UTF-8 CSV. The BOM makes Excel open Arabic text
 * correctly instead of showing mojibake.
 */
export function downloadCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]) {
  const lines = [
    columns.map((c) => escapeCell(c.header)).join(","),
    ...rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(",")),
  ];
  const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
