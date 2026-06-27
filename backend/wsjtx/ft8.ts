// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Parse decoded FT8/FT4 message *text* into structured fields.
// Grammar:
//   CQ [modifier] <from> [grid]
//   <to> <from> <exchange...>
// where <exchange> is one of: grid | report(±dB / R±dB) | RRR | RR73 | 73 |
// contest exchange (class + ARRL section, optionally prefixed with R).
import type { Ft8Parsed, MsgType } from "../types.ts";
import { isSection } from "../geo/sections.ts";

const GRID4 = /^[A-R]{2}[0-9]{2}$/i;
const GRID6 = /^[A-R]{2}[0-9]{2}[A-X]{2}$/i;
const REPORT = /^R?[-+]\d{1,2}$/; // -13, +05, R-13, R+00
const CQ_MODIFIERS = new Set([
  "DX", "FD", "TEST", "POTA", "SOTA", "QRP", "NA", "SA", "EU", "AS", "AF", "OC",
  "WW", "AA", "USA",
]);

const isGrid = (t: string) => GRID4.test(t) || GRID6.test(t);

function classify(rest: string[]): { msgType: MsgType; section: string | null; reportDb: number | null } {
  if (rest.length === 0) return { msgType: "unknown", section: null, reportDb: null };
  const joined = rest.join(" ").toUpperCase();
  if (joined === "RR73") return { msgType: "rr73", section: null, reportDb: null };
  if (joined === "RRR") return { msgType: "rrr", section: null, reportDb: null };
  if (joined === "73") return { msgType: "73", section: null, reportDb: null };
  if (rest.length === 1 && isGrid(rest[0])) return { msgType: "grid", section: null, reportDb: null };
  if (rest.length === 1 && REPORT.test(rest[0])) {
    return { msgType: "report", section: null, reportDb: parseReport(rest[0]) };
  }
  // Contest exchange: last token a known section => exchange (e.g. "R 1E WI", "4A NFL").
  const last = rest[rest.length - 1].toUpperCase();
  if (isSection(last)) return { msgType: "exchange", section: last, reportDb: null };
  // A leading report with trailing junk, or anything else.
  if (REPORT.test(rest[0])) return { msgType: "report", section: null, reportDb: parseReport(rest[0]) };
  return { msgType: "exchange", section: isSection(last) ? last : null, reportDb: null };
}

function parseReport(tok: string): number | null {
  const m = tok.match(/[-+]\d{1,2}/);
  return m ? Number(m[0]) : null;
}

export function parseFt8(text: string): Ft8Parsed {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const base: Ft8Parsed = {
    toCall: null, fromCall: null, msgType: "unknown", grid: null,
    reportDb: null, section: null, fdClass: null, exchange: null, cqModifier: null,
  };
  if (tokens.length === 0) return base;

  if (tokens[0].toUpperCase() === "CQ") {
    let rest = tokens.slice(1);
    let grid: string | null = null;
    if (rest.length && isGrid(rest[rest.length - 1])) grid = rest.pop()!.toUpperCase();
    const fromCall = rest.length ? rest[rest.length - 1] : null;
    const cqModifier = rest.length > 1 && CQ_MODIFIERS.has(rest[0].toUpperCase()) ? rest[0].toUpperCase() : null;
    return { ...base, toCall: null, fromCall, msgType: "cq", grid, cqModifier };
  }

  // Directed message: <to> <from> <exchange...>
  const toCall = tokens[0];
  const fromCall = tokens[1] ?? null;
  const rest = tokens.slice(2);
  const { msgType, section, reportDb } = classify(rest);
  const grid = msgType === "grid" ? rest[0].toUpperCase() : null;
  const fdClass = rest.find((t) => /^\d{1,2}[A-F]$/i.test(t))?.toUpperCase() ?? null;
  return {
    ...base, toCall, fromCall, msgType, grid, reportDb, section, fdClass,
    exchange: rest.length ? rest.join(" ") : null,
  };
}
