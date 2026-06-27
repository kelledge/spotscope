// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

import { expect, test } from "bun:test";
import { parseFt8 } from "./ft8.ts";
import { gridToLatLon } from "../geo/maidenhead.ts";
import { sectionToLatLon } from "../geo/sections.ts";
import { decodeFdClass } from "../fieldday.ts";

test("parses + decodes Field Day class", () => {
  expect(parseFt8("W4DW K9OM R 1E WI").fdClass).toBe("1E");
  expect(parseFt8("CE3TSK K4BV 4A NFL").fdClass).toBe("4A");
  expect(parseFt8("CQ W5XO EM10").fdClass).toBeNull();
  const d = decodeFdClass("2D")!;
  expect(d.transmitters).toBe(2);
  expect(d.klass).toBe("D");
  expect(d.meaning).toContain("home");
  expect(decodeFdClass("XY")).toBeNull();
});

// Real messages captured from KF0JNM's live FT8 stream (15m, Field Day 2026).
test("CQ with grid", () => {
  const p = parseFt8("CQ W5XO EM10");
  expect(p.msgType).toBe("cq");
  expect(p.fromCall).toBe("W5XO");
  expect(p.toCall).toBeNull();
  expect(p.grid).toBe("EM10");
});

test("CQ FD modifier with grid", () => {
  const p = parseFt8("CQ FD K9BEL EN52");
  expect(p.msgType).toBe("cq");
  expect(p.cqModifier).toBe("FD");
  expect(p.fromCall).toBe("K9BEL");
  expect(p.grid).toBe("EN52");
});

test("contest exchange (class + section)", () => {
  const p = parseFt8("CE3TSK K4BV 4A NFL");
  expect(p.toCall).toBe("CE3TSK");
  expect(p.fromCall).toBe("K4BV");
  expect(p.msgType).toBe("exchange");
  expect(p.section).toBe("NFL");
  expect(p.grid).toBeNull();
});

test("roger + contest exchange", () => {
  const p = parseFt8("W4DW K9OM R 1E WI");
  expect(p.toCall).toBe("W4DW");
  expect(p.fromCall).toBe("K9OM");
  expect(p.msgType).toBe("exchange");
  expect(p.section).toBe("WI");
});

test("73 sign-off", () => {
  const p = parseFt8("W5SI HI3K 73");
  expect(p.msgType).toBe("73");
  expect(p.fromCall).toBe("HI3K");
  expect(p.toCall).toBe("W5SI");
});

test("RRR", () => {
  expect(parseFt8("W3APL K9BEL RRR").msgType).toBe("rrr");
});

test("standard signal report", () => {
  const p = parseFt8("W1ABC K9OM R-10");
  expect(p.msgType).toBe("report");
  expect(p.reportDb).toBe(-10);
});

test("standard grid exchange", () => {
  const p = parseFt8("K9OM W1ABC FN42");
  expect(p.msgType).toBe("grid");
  expect(p.grid).toBe("FN42");
});

test("maidenhead EM18 lands in Nebraska-ish", () => {
  const ll = gridToLatLon("EM18")!;
  expect(ll.lat).toBeCloseTo(38.5, 1);
  expect(ll.lon).toBeCloseTo(-97.0, 1);
});

test("maidenhead FN31 lands in Connecticut-ish", () => {
  const ll = gridToLatLon("FN31")!;
  expect(ll.lat).toBeCloseTo(41.5, 1);
  expect(ll.lon).toBeCloseTo(-73.0, 1);
});

test("section centroid resolves", () => {
  expect(sectionToLatLon("WI")).not.toBeNull();
  expect(sectionToLatLon("NFL")).not.toBeNull();
  expect(sectionToLatLon("ZZ")).toBeNull();
});
