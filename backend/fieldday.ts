// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Decode an ARRL Field Day class like "2D" / "1E" / "5A".
// Format: <number of transmitters><entry class letter>.
const CLASS_MEANING: Record<string, string> = {
  A: "club / group, portable",
  B: "1–2 person, portable",
  C: "mobile",
  D: "home station (mains power)",
  E: "home station (battery / emergency power)",
  F: "emergency operations center (EOC)",
};

export interface FdClass {
  raw: string;
  transmitters: number;
  klass: string;
  meaning: string;
}

export function decodeFdClass(cls: string | null | undefined): FdClass | null {
  if (!cls) return null;
  const m = cls.toUpperCase().match(/^(\d{1,2})([A-F])$/);
  if (!m) return null;
  return { raw: cls.toUpperCase(), transmitters: Number(m[1]), klass: m[2], meaning: CLASS_MEANING[m[2]] ?? "?" };
}
