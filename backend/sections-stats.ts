// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Per-ARRL-section rollup for the hunt widget, from a window of spots.
// Pure function so it's testable.
import type { SectionStat, Spot } from "./types.ts";
import { SECTION_META } from "./geo/arrl-sections.ts";
import { haversineKm } from "./geo/distance.ts";

const COMPLETION = new Set(["rr73", "rrr", "73"]);

export function computeSectionStats(spots: Spot[]): SectionStat[] {
  // Build callsign -> section (sections only appear in contest exchanges, not in
  // the closing handshake, so we accumulate it from any message that carried one).
  const callSection = new Map<string, string>();
  for (const s of spots) {
    if (s.fromCall && s.section) callSection.set(s.fromCall, s.section);
  }
  const rxCall = [...spots].reverse().find((s) => s.rxCall)?.rxCall ?? null;

  interface Agg { calls: Set<string>; bestSnr: number | null; closestKm: number | null; worked: boolean }
  const agg = new Map<string, Agg>();
  const get = (sec: string) => {
    let a = agg.get(sec);
    if (!a) { a = { calls: new Set(), bestSnr: null, closestKm: null, worked: false }; agg.set(sec, a); }
    return a;
  };

  for (const s of spots) {
    if (!s.fromCall) continue;
    const sec = s.section ?? callSection.get(s.fromCall);
    if (!sec) continue;
    const a = get(sec);
    a.calls.add(s.fromCall);
    if (a.bestSnr == null || s.snr > a.bestSnr) a.bestSnr = s.snr;
    if (s.txLat != null && s.txLon != null && s.rxLat != null && s.rxLon != null) {
      const d = Math.round(haversineKm({ lat: s.rxLat, lon: s.rxLon }, { lat: s.txLat, lon: s.txLon }));
      if (a.closestKm == null || d < a.closestKm) a.closestKm = d;
    }
    // worked: this station sent us a closing handshake
    if (rxCall && s.toCall === rxCall && COMPLETION.has(s.msgType)) a.worked = true;
  }

  // Include EVERY section (0 stats for ones we haven't heard) so unworked
  // sections surface and can be sorted to the top for hunting.
  const out: SectionStat[] = [];
  for (const [section, meta] of Object.entries(SECTION_META)) {
    const a = agg.get(section);
    out.push({
      section, name: meta.name, state: meta.state ?? null,
      stationsHeard: a?.calls.size ?? 0,
      bestSnr: a?.bestSnr ?? null,
      closestKm: a?.closestKm ?? null,
      worked: a?.worked ?? false,
    });
  }
  out.sort((x, y) => x.section.localeCompare(y.section));
  return out;
}
