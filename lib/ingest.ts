import * as XLSX from "xlsx";

import type { RawRow } from "@/lib/types";
import { parseExportDate } from "@/lib/time";

/**
 * Reads the scheduling app's export. The scheduler downloads whatever the app
 * gives him, so .csv and .xlsx go through one path — SheetJS parses both from
 * the same buffer.
 */

/**
 * Header aliases. The export's column names are stable in practice, but a
 * re-export or a manual edit shifts capitalisation and spacing, and failing an
 * upload over "First name" vs "First Name" would be daft.
 */
const COLUMN_ALIASES: Record<keyof Omit<RawRow, "extra">, string[]> = {
  date: ["date", "datetime", "date time", "scheduled", "scheduled date", "start", "start date"],
  customer: ["customer", "client", "customer name", "client name", "account"],
  firstName: ["first name", "firstname", "first"],
  lastName: ["last name", "lastname", "last"],
  address: ["address", "service address", "street address", "location", "site address"],
  description: ["description", "job type", "service", "job", "type", "item"],
  notes: ["notes", "note", "comments", "comment", "instructions", "details"],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildHeaderMap(headers: string[]): Map<string, keyof Omit<RawRow, "extra">> {
  const map = new Map<string, keyof Omit<RawRow, "extra">>();
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(normalized)) {
        map.set(header, field as keyof Omit<RawRow, "extra">);
        break;
      }
    }
  }
  return map;
}

export type IngestResult = {
  rows: RawRow[];
  /** The most common date across the rows — the Saturday this export is for. */
  scheduleDate: string | null;
  /** Columns that were present but not recognised. Kept on each row's `extra`. */
  unrecognizedColumns: string[];
};

export class IngestError extends Error {}

export function readExport(buffer: ArrayBuffer, filename: string): IngestResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array", cellDates: true, raw: false });
  } catch {
    throw new IngestError(
      `Could not read ${filename}. It needs to be the .csv or .xlsx the scheduling app exports.`,
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new IngestError(`${filename} has no sheets in it.`);

  const sheet = workbook.Sheets[sheetName];
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  if (records.length === 0) {
    throw new IngestError(`${filename} has no rows in it.`);
  }

  const headers = Object.keys(records[0]);
  const headerMap = buildHeaderMap(headers);

  if (!headerMap.size) {
    throw new IngestError(
      `None of the columns in ${filename} were recognised. Expected at least Customer, Address and Notes. Found: ${headers.join(", ")}.`,
    );
  }

  const unrecognizedColumns = headers.filter((h) => !headerMap.has(h) && h.trim() !== "");

  const rows: RawRow[] = [];
  for (const record of records) {
    const row: RawRow = {};
    const extra: Record<string, string> = {};

    for (const [header, value] of Object.entries(record)) {
      const field = headerMap.get(header);
      const text = value instanceof Date ? value.toISOString() : String(value ?? "").trim();
      if (field) {
        row[field] = text;
      } else if (text) {
        extra[header] = text;
      }
    }

    if (Object.keys(extra).length > 0) row.extra = extra;

    // A row with no customer, address and notes is a spacer or a totals line.
    const hasContent = Boolean(
      row.customer?.trim() ||
        row.address?.trim() ||
        row.notes?.trim() ||
        row.firstName?.trim() ||
        row.lastName?.trim(),
    );
    if (hasContent) rows.push(row);
  }

  if (rows.length === 0) {
    throw new IngestError(`${filename} had rows, but none of them had a customer or an address.`);
  }

  return { rows, scheduleDate: mostCommonDate(rows), unrecognizedColumns };
}

/**
 * The Date column's date is reliable (its time is not — that is the scheduler's
 * previous manual guess). Taking the mode rather than the first row means one
 * stray row cannot mislabel the whole Saturday.
 */
function mostCommonDate(rows: RawRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const date = parseExportDate(row.date);
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
