// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

import { expect, test } from "bun:test";
import { computeSectionStats } from "./sections-stats.ts";
import type { Spot } from "./types.ts";

let seq = 0;
const base = Date.parse("2026-06-27T19:00:00Z");
function spot(from: string | null, to: string | null, msgType: string, raw: string, extra: Partial<Spot> = {}): Spot {
  return {
    fromCall: from, toCall: to, msgType, rawMessage: raw, reportDb: null,
    receivedAt: new Date(base + seq++ * 10).toISOString(),
    decodeTimeMs: seq, band: "20m",
    cqModifier: null, section: null, fdClass: null,
    ...extra,
  } as unknown as Spot;
}

const find = (stats: ReturnType<typeof computeSectionStats>, sec: string) => stats.find((s) => s.section === sec)!;

test("only counts stations that advertised Field Day, not callbook sections", () => {
  const spots = [
    // Real FD station: sent a class+section exchange.
    spot("W3SK", "K9OM", "exchange", "K9OM W3SK 2D EPA", { section: "EPA", fdClass: "2D" }),
    // CQ FD with no exchange yet — still an advertiser.
    spot("N4XX", null, "cq", "CQ FD N4XX EM70", { cqModifier: "FD" }),
    // Non-FD station whose section came from a callbook lookup (no FD signal).
    spot("K1ABC", "W1AW", "grid", "W1AW K1ABC FN42", { section: "CT" }),
  ];
  const stats = computeSectionStats(spots);
  expect(find(stats, "EPA").stationsHeard).toBe(1); // the FD exchange station
  expect(find(stats, "CT").stationsHeard).toBe(0);  // callbook section is NOT a participant
});

test("a catch-all 'exchange' message with no class/section is NOT Field Day", () => {
  // The FT8 parser labels any unrecognized directed message msgType:"exchange".
  // Such a station (no fdClass, no real section) must not be treated as FD, even
  // if a callbook section rode along on the spot.
  const spots = [
    spot("K0BIE", "W1AW", "exchange", "W1AW K0BIE SOMETHING", { section: "CO" }),
  ];
  const stats = computeSectionStats(spots);
  expect(find(stats, "CO").stationsHeard).toBe(0);
});

test("an advertiser stays counted through a closing handshake that carries no section", () => {
  const rx = { rxCall: "K9OM" };
  const spots = [
    spot("W3SK", "K9OM", "exchange", "K9OM W3SK 2D EPA", { section: "EPA", fdClass: "2D", ...rx }),
    spot("W3SK", "K9OM", "rr73", "K9OM W3SK RR73", { ...rx }), // closes; no section/class
  ];
  const stats = computeSectionStats(spots);
  expect(find(stats, "EPA").stationsHeard).toBe(1);
  expect(find(stats, "EPA").worked).toBe(true);
});
