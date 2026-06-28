// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

import { expect, test } from "bun:test";
import { computeExchanges } from "./exchanges.ts";
import type { Spot } from "./types.ts";

let seq = 0;
const base = Date.parse("2026-06-27T19:00:00Z");
function spot(cycle: number, from: string | null, to: string | null, msgType: string, raw: string, reportDb: number | null = null, extra: Partial<Spot> = {}): Spot {
  return {
    fromCall: from, toCall: to, msgType, rawMessage: raw, reportDb,
    receivedAt: new Date(base + cycle * 15000 + seq++ * 10).toISOString(),
    decodeTimeMs: cycle, band: "20m",
    cqModifier: null, section: null, fdClass: null,
    ...extra,
  } as unknown as Spot;
}

test("pileup + bidirectional reports + retransmission", () => {
  const spots = [
    spot(1, "W1AW", null, "cq", "CQ W1AW FN31"),
    spot(2, "K9OM", "W1AW", "grid", "W1AW K9OM EM48"),
    spot(2, "N4XX", "W1AW", "grid", "W1AW N4XX EM70"), // contender
    spot(2, "AB1C", "W1AW", "grid", "W1AW AB1C FN42"), // contender
    spot(3, "W1AW", "K9OM", "report", "K9OM W1AW -10", -10), // W1AW hears K9OM
    spot(4, "K9OM", "W1AW", "report", "W1AW K9OM R-12", -12), // K9OM hears W1AW
    spot(5, "K9OM", "W1AW", "report", "W1AW K9OM R-12", -12), // retransmission (no ack)
    spot(6, "W1AW", "K9OM", "rr73", "K9OM W1AW RR73"),
    spot(3, "N4XX", "W1AW", "grid", "W1AW N4XX EM70"), // N4XX still calling
  ];
  const ex = computeExchanges(spots);
  expect(ex.length).toBe(1);
  const e = ex[0];
  expect(e.cqer).toBe("W1AW");
  expect(e.responder).toBe("K9OM");
  expect(e.role).toBe("cq");
  expect(e.contenders).toBe(3);
  expect(e.cqerHeardResponder).toBe(-10);
  expect(e.responderHeardCqer).toBe(-12);
  expect(e.stageRank).toBe(5); // RR73
  expect(e.retransmissions).toBe(1);
  expect(e.halfCopy).toBe(false);
  expect(e.protocol).toBe("ft8");
  expect(e.steps.length).toBe(6);
});

test("field day exchange uses the FD stage model (no grid/report steps)", () => {
  const ex = computeExchanges([
    spot(1, "W3SK", null, "cq", "CQ FD W3SK FN20", null, { cqModifier: "FD" }),
    spot(2, "K9OM", "W3SK", "exchange", "W3SK K9OM 1D WI", null, { fdClass: "1D", section: "WI" }),
    spot(3, "W3SK", "K9OM", "exchange", "K9OM W3SK R 2A IL", null, { fdClass: "2A", section: "IL" }),
    spot(4, "K9OM", "W3SK", "rr73", "W3SK K9OM RR73"),
  ]);
  expect(ex.length).toBe(1);
  const e = ex[0];
  expect(e.protocol).toBe("fieldday");
  expect(e.steps.length).toBe(4);
  expect(e.cqer).toBe("W3SK");
  expect(e.responder).toBe("K9OM");
  expect(e.stageRank).toBe(4); // RR73 closes the FD exchange
  expect(e.cqerClass).toBe("2A");
  expect(e.responderClass).toBe("1D");
  expect(e.cqerSection).toBe("IL");
  expect(e.responderSection).toBe("WI");
  expect(e.seenSteps[0]).toBe(true); // CQ copied
  expect(e.seenSteps.every(Boolean)).toBe(true); // full copy: CQ → class+sect → R+exch → RR73
});

test("field day detected from exchange content even without the CQ", () => {
  const ex = computeExchanges([
    spot(2, "K9OM", "W3SK", "exchange", "W3SK K9OM 1D WI", null, { fdClass: "1D", section: "WI" }),
    spot(3, "W3SK", "K9OM", "exchange", "K9OM W3SK R 2A IL", null, { fdClass: "2A", section: "IL" }),
  ]);
  expect(ex.length).toBe(1);
  expect(ex[0].protocol).toBe("fieldday");
});

test("half-copy: only one side decoded (kept when ≥2 messages)", () => {
  const ex = computeExchanges([
    spot(1, "VK3X", null, "cq", "CQ VK3X QF22"),
    spot(2, "JA1Y", "VK3X", "grid", "VK3X JA1Y PM95"),
    spot(3, "JA1Y", "VK3X", "report", "VK3X JA1Y -15", -15),
  ]);
  expect(ex.length).toBe(1);
  expect(ex[0].cqer).toBe("VK3X");
  expect(ex[0].responder).toBe("JA1Y");
  expect(ex[0].halfCopy).toBe(true);
});

test("single-decode half-copy is filtered out as noise", () => {
  const ex = computeExchanges([
    spot(1, "VK3X", null, "cq", "CQ VK3X QF22"),
    spot(2, "JA1Y", "VK3X", "grid", "VK3X JA1Y PM95"),
  ]);
  expect(ex.length).toBe(0);
});

test("no directed traffic -> no live exchanges", () => {
  expect(computeExchanges([spot(1, "W1AW", null, "cq", "CQ W1AW FN31")]).length).toBe(0);
});
