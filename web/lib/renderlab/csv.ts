// CSV export, built in the browser from data the page already has.
//
// ── Why client-side ─────────────────────────────────────────────────────────────────────────────
//
// The rows are already loaded and the user has just chosen which of them and which columns they want.
// A server endpoint would re-query the database for data sitting in memory two feet away, and would
// have to re-implement the selection to do it. Building the file here is instant and cannot disagree
// with what is on screen.
//
// The exception is the "everything matching my filters" scope, which genuinely needs rows the page has
// not loaded — that fetches first, then comes back through here.
//
// ── The escaping rule is not ours to invent ─────────────────────────────────────────────────────
//
// `csvCell` below is deliberately identical to the one in src/app/api/url-sweep/export/route.ts,
// including the formula guard, so the two exports cannot drift into disagreeing about what is safe.
// They are not shared as one function because they build different things — that one writes an HTTP
// response, this one a Blob — but the rule they apply has to be the same rule.

/**
 * One CSV cell, per RFC 4180.
 *
 * The leading-character guard is the part that matters and is easy to leave out: a field beginning
 * `=`, `+`, `-` or `@` is executed as a formula by Excel and Google Sheets when the file is opened.
 * Our data is full of candidates — a path fragment, a negative word delta, an `@` in an anchor — so a
 * plain quote-and-escape would ship a spreadsheet that runs whatever a page title happened to contain.
 */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** A column a user can choose to include, and how to flatten it out of a row. */
export interface CsvColumn<T> {
  key: string;
  label: string;
  /** Anything not a string gets String()'d by csvCell; return "" rather than null for empty. */
  get: (row: T) => unknown;
  /** Ticked when the panel first opens. Everything else is available but off. */
  on?: boolean;
  /** Shown under the label in the picker, for columns whose meaning is not obvious from the name. */
  hint?: string;
}

export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const header = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.get(r))).join(","));
  // CRLF per the spec, and a UTF-8 BOM: without it Excel on Windows reads the file as the local
  // codepage and mangles every non-ASCII character in a title or anchor.
  return `﻿${[header, ...body].join("\r\n")}\r\n`;
}

/** Hand the file to the browser. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is enough and the object
  // must not be left to leak for the life of the page.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `render-lab-findings-2026-08-24.csv` */
export function stamped(base: string): string {
  return `${base}-${new Date().toISOString().slice(0, 10)}.csv`;
}
