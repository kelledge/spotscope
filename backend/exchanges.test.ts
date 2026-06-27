// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

import { expect, test } from "bun:test";
import { computeExchanges } from "./exchanges.ts";
import type { Spot } from "./types.ts";

let seq = 0;
const base = Date.parse("2026-06-27T19:00:00Z");
function spot(cycle: number, from: string | null, to: string | null, msgType: string, raw: string, reportDb: number | null = null): Spot {
  return {
    fromCall: from, toCall: to, msgType, rawMessage: raw, reportDb,
    receivedAt: new Date(base + cycle * 15000 + seq++ * 10).toISOString(),
    decodeTimeMs: cycle, band: "20m",
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
