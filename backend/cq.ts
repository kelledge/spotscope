// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Derive the set of stations *currently calling CQ* from a recent window of
// spots. A caller drops off the moment they engage — i.e. once a directed
// message involves them (they answer someone, or someone answers them) after
// their latest CQ. Pure function over Spot[] so it's testable.
import type { CqCaller, Spot } from "./types.ts";
import { haversineKm } from "./geo/distance.ts";

// Per-station behaviour over the hour window, for the activeness metric.
interface HourStat {
  cycles: Set<number>; // distinct decode cycles we heard them transmit
  first: number; last: number; // active span
  partners: Set<string>; // distinct stations they directed traffic at (contacts attempted/made)
  completed: Set<string>; // distinct partners they sent a closing handshake to (RR73/RRR/73)
}

// `recent` = short window for "who's calling CQ now"; `hour` = ~1h window for the
// activeness / completed-QSO stats.
export function computeCqCallers(recent: Spot[], hour: Spot[] = recent, worked: Map<string, number> = new Map()): CqCaller[] {
  const hourStat = new Map<string, HourStat>();
  const callSection = new Map<string, string>(); // accumulated section (CQs only carry a grid)
  for (const s of hour) {
    if (!s.fromCall) continue;
    if (s.section) callSection.set(s.fromCall, s.section);
    const t = Date.parse(s.receivedAt);
    let h = hourStat.get(s.fromCall);
    if (!h) { h = { cycles: new Set(), first: t, last: t, partners: new Set(), completed: new Set() }; hourStat.set(s.fromCall, h); }
    if (s.decodeTimeMs != null) h.cycles.add(s.decodeTimeMs);
    h.first = Math.min(h.first, t);
    h.last = Math.max(h.last, t);
    if (s.toCall) {
      h.partners.add(s.toCall);
      if (s.msgType === "rr73" || s.msgType === "rrr" || s.msgType === "73") h.completed.add(s.toCall);
    }
  }

  // Activeness 0..100: blends how fast they turn over contacts (vs ~1/min ceiling)
  // with how continuously they transmit (FT8 runner ≈ every other 15s cycle),
  // damped by confidence when we've only caught a couple of cycles.
  const activenessOf = (call: string): number => {
    const h = hourStat.get(call);
    if (!h) return 0;
    const spanSec = (h.last - h.first) / 1000;
    const activeMin = Math.max(0.25, spanSec / 60);
    const elapsedCycles = Math.max(1, spanSec / 15 + 1);
    const dutyN = Math.min(1, (h.cycles.size / elapsedCycles) / 0.5); // 0.5 = running cadence
    const rateN = Math.min(1, (h.partners.size / activeMin) / 1.0); // 1 contact/min = maxed
    const conf = Math.min(1, h.cycles.size / 4);
    return Math.round(100 * conf * (0.6 * rateN + 0.4 * dutyN));
  };

  const spots = recent;
  const lastCq = new Map<string, Spot>(); // latest CQ spot per caller
  const cqCount = new Map<string, number>();
  const directed: { from: string; to: string; t: number }[] = [];

  for (const s of spots) {
    if (!s.fromCall) continue;
    const t = Date.parse(s.receivedAt);
    if (s.msgType === "cq") {
      lastCq.set(s.fromCall, s);
      cqCount.set(s.fromCall, (cqCount.get(s.fromCall) ?? 0) + 1);
    }
    if (s.toCall) directed.push({ from: s.fromCall, to: s.toCall, t });
  }

  // Engaged = a directed message involving the caller *after* their latest CQ.
  const engaged = new Set<string>();
  for (const d of directed) {
    const ct = lastCq.get(d.to);
    if (ct && d.t > Date.parse(ct.receivedAt)) engaged.add(d.to); // someone answered them
    const cf = lastCq.get(d.from);
    if (cf && d.t > Date.parse(cf.receivedAt)) engaged.add(d.from); // they answered someone
  }

  const out: CqCaller[] = [];
  for (const [call, s] of lastCq) {
    if (engaged.has(call)) continue;
    const dist = s.rxLat != null && s.rxLon != null && s.txLat != null && s.txLon != null
      ? Math.round(haversineKm({ lat: s.rxLat, lon: s.rxLon }, { lat: s.txLat, lon: s.txLon }))
      : null;
    out.push({
      call, snr: s.snr, distanceKm: dist, grid: s.txGrid, section: callSection.get(call) ?? s.section,
      band: s.band, lastSeen: s.receivedAt, cqCount: cqCount.get(call) ?? 1,
      qsosLastHour: hourStat.get(call)?.completed.size ?? 0,
      activeness: activenessOf(call),
      workedAt: worked.get(call) ?? null,
    });
  }
  return out;
}
