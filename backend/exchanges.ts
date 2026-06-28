// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Derive currently-active QSOs ("live exchanges") from a recent window of spots.
// Pure function over Spot[] so it's testable and restart-safe (no in-memory state).
//
// Key semantics:
//  - An exchange is the unordered pair {cqer, responder}. Role: the cqer is the
//    station we saw call CQ, else the station that was *called* first.
//  - Bidirectional SNR uses the EMBEDDED report (reportDb), not our receive snr:
//    a message from X carries "how X heard the other station".
//  - Retransmissions: identical message text repeated across distinct cycles.
//  - Pileup (contenders): distinct stations calling the same cqer.
//  - Half-copy: we only decoded one direction.
import type { Exchange, Spot } from "./types.ts";

interface D {
  from: string; to: string; msgType: string; reportDb: number | null;
  raw: string; t: number; cycle: number | null; band: string | null; mode: string | null; fdClass: string | null;
  section: string | null; cqModifier: string | null;
  snr: number; // OUR receive strength of this transmission
}

const pkey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };

// A protocol's QSO stage model: the canonical step labels (the progress-bar
// segments) and a function that ranks a single message within them. The CQ is
// step 1 but isn't a directed message — it's filled from the CQ set separately.
interface StageModel { steps: string[]; stageOf(d: D): { rank: number; label: string } }

// Standard FT8: CQ → grid → report → roger-report → RRR/RR73 → 73.
function stageFt8(d: D): { rank: number; label: string } {
  const R = d.raw.toUpperCase();
  const rest = R.split(/\s+/).slice(2); // tokens after "TO FROM"
  if (/(^|\s)73(\s|$)/.test(R)) return { rank: 6, label: "73 · closing" };
  if (R.includes("RR73")) return { rank: 5, label: "RR73" };
  if (R.includes("RRR")) return { rank: 5, label: "RRR" };
  const rogered = rest[0] === "R" || /^R[-+]\d/.test(rest[0] ?? "");
  if (d.msgType === "report" || d.msgType === "exchange") {
    return rogered ? { rank: 4, label: "roger report" } : { rank: 3, label: "report/exch" };
  }
  if (d.msgType === "grid") return { rank: 2, label: "answered" };
  if (d.msgType === "cq") return { rank: 1, label: "CQ" };
  return { rank: 0, label: d.msgType };
}

// Field Day: CQ → class+section → R + class+section → RR73/73. There is no grid
// or signal-report step; the exchange itself carries the class + ARRL section.
function stageFd(d: D): { rank: number; label: string } {
  const R = d.raw.toUpperCase();
  const rest = R.split(/\s+/).slice(2); // tokens after "TO FROM"
  if (/(^|\s)73(\s|$)/.test(R) || R.includes("RR73") || R.includes("RRR")) return { rank: 4, label: "RR73/73" };
  if (d.msgType === "exchange") {
    return rest[0] === "R" ? { rank: 3, label: "roger + class/sect" } : { rank: 2, label: "class/sect" };
  }
  if (d.msgType === "cq") return { rank: 1, label: "CQ" };
  return { rank: 0, label: d.msgType };
}

const MODELS: Record<"ft8" | "fieldday", StageModel> = {
  ft8: { steps: ["CQ", "grid", "report", "roger", "RR73", "73"], stageOf: stageFt8 },
  fieldday: { steps: ["CQ", "class+sect", "R+exch", "RR73/73"], stageOf: stageFd },
};

function topStage(msgs: D[], model: StageModel) {
  return msgs.map(model.stageOf).reduce((a, b) => (b.rank > a.rank ? b : a));
}

function avgReport(msgs: D[]): number | null {
  const v = msgs.map((m) => m.reportDb).filter((x): x is number => x != null);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
}

// Count retransmissions: same raw text seen in more than one decode cycle.
function retransmissions(msgs: D[]): number {
  const byRaw = new Map<string, Set<number>>();
  for (const m of msgs) {
    const cyc = m.cycle ?? m.t;
    const set = byRaw.get(m.raw) ?? new Set<number>();
    set.add(cyc);
    byRaw.set(m.raw, set);
  }
  let r = 0;
  for (const set of byRaw.values()) r += Math.max(0, set.size - 1);
  return r;
}

export function computeExchanges(spots: Spot[]): Exchange[] {
  const cqAt = new Map<string, number>();
  const cqMod = new Map<string, string>(); // caller -> CQ modifier (e.g. "FD"); CQs aren't directed
  const directed: D[] = [];
  for (const s of spots) {
    if (!s.fromCall) continue;
    const t = Date.parse(s.receivedAt);
    if (s.msgType === "cq") {
      cqAt.set(s.fromCall, t);
      if (s.cqModifier) cqMod.set(s.fromCall, s.cqModifier);
    }
    if (s.toCall) {
      directed.push({
        from: s.fromCall, to: s.toCall, msgType: s.msgType, reportDb: s.reportDb,
        raw: s.rawMessage, t, cycle: s.decodeTimeMs, band: s.band, mode: s.mode, fdClass: s.fdClass,
        section: s.section, cqModifier: s.cqModifier, snr: s.snr,
      });
    }
  }
  if (!directed.length) return [];

  // Collect both directions per unordered pair.
  const pairs = new Map<string, D[]>();
  for (const d of directed) push(pairs, pkey(d.from, d.to), d);

  const cqerOf = (a: string, b: string, msgs: D[]): string => {
    const ca = cqAt.get(a), cb = cqAt.get(b);
    if (ca != null && cb != null) return ca >= cb ? a : b;
    if (ca != null) return a;
    if (cb != null) return b;
    return msgs.reduce((m, x) => (x.t < m.t ? x : m), msgs[0]).to; // earliest called
  };

  // Group pairs by their cqer so a pileup collapses to one row (+ contender count).
  interface PInfo { partner: string; msgs: D[] }
  const byCqer = new Map<string, PInfo[]>();
  for (const [key, msgs] of pairs) {
    const [a, b] = key.split("|");
    const cqer = cqerOf(a, b, msgs);
    push(byCqer, cqer, { partner: cqer === a ? b : a, msgs });
  }

  const out: Exchange[] = [];
  for (const [cqer, plist] of byCqer) {
    const contenderSet = new Set(plist.map((p) => p.partner));
    // Field Day uses class+section rather than grid+report. Detect it per cqer:
    // the persisted "CQ FD" modifier, or a parsed class token in the directed
    // traffic (NOT msgType "exchange" — that's the parser's catch-all for any
    // unrecognized directed message and would misclassify ordinary QSOs).
    const allMsgs = plist.flatMap((p) => p.msgs);
    const protocol: "ft8" | "fieldday" =
      cqMod.get(cqer) === "FD" || allMsgs.some((m) => m.fdClass != null) ? "fieldday" : "ft8";
    const model = MODELS[protocol];
    // Primary partner = furthest-along, then most-recent.
    let primary = plist[0], best = -1, bestT = -1;
    for (const p of plist) {
      const rank = topStage(p.msgs, model).rank;
      const lt = Math.max(...p.msgs.map((m) => m.t));
      if (rank > best || (rank === best && lt > bestT)) { best = rank; bestT = lt; primary = p; }
    }
    const msgs = primary.msgs;
    const fromCqer = msgs.filter((m) => m.from === cqer);
    const fromResp = msgs.filter((m) => m.from === primary.partner);
    const stage = topStage(msgs, model);
    // Which canonical steps we actually copied (rest are holes). Step 1 is the CQ
    // (not a directed msg), so mark it from the CQ set; the rest from the traffic.
    const seenSteps = new Array(model.steps.length).fill(false);
    seenSteps[0] = cqAt.has(cqer);
    for (const m of msgs) {
      const r = model.stageOf(m).rank;
      if (r >= 2 && r <= model.steps.length) seenSteps[r - 1] = true;
    }
    const latestClass = (arr: D[]) => arr.filter((m) => m.fdClass).at(-1)?.fdClass ?? null;
    const latestSection = (arr: D[]) => arr.filter((m) => m.section).at(-1)?.section ?? null;
    out.push({
      cqer,
      responder: primary.partner,
      cqerClass: latestClass(fromCqer),
      responderClass: latestClass(fromResp),
      cqerSection: latestSection(fromCqer),
      responderSection: latestSection(fromResp),
      role: cqAt.has(cqer) ? "cq" : "called",
      protocol,
      steps: model.steps,
      stage: stage.label,
      stageRank: stage.rank,
      seenSteps,
      msgCount: msgs.length,
      cqerHeardResponder: avgReport(fromCqer),
      responderHeardCqer: avgReport(fromResp),
      retransmissions: retransmissions(fromCqer) + retransmissions(fromResp),
      contenders: contenderSet.size,
      contenderCalls: [...contenderSet],
      halfCopy: fromCqer.length === 0 || fromResp.length === 0,
      lastSeen: new Date(Math.max(...msgs.map((m) => m.t))).toISOString(),
      band: msgs[msgs.length - 1].band,
      mode: msgs[msgs.length - 1].mode,
      log: [...msgs].sort((a, b) => a.t - b.t).map((m) => ({
        t: new Date(m.t).toISOString(), from: m.from, to: m.to, msg: m.raw, snr: m.snr, type: m.msgType,
      })),
    });
  }
  // Filter noise: a half-copy with a single decode is just one overheard
  // transmission, not a trackable exchange. Full-copies are always kept.
  const filtered = out.filter((e) => !e.halfCopy || e.msgCount >= 2);
  // Stable order: sort by the pair identity so rows don't churn between polls.
  filtered.sort((a, b) => (a.cqer + a.responder).localeCompare(b.cqer + b.responder));
  return filtered;
}
