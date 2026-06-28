// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Shared types across backend ingest, DB, and the WS wire format.

export type MsgType =
  | "cq" // CQ call (broadcast), may carry a grid
  | "grid" // directed call carrying a 4-char grid
  | "report" // signal report (e.g. -13, R-13)
  | "rrr" // RRR acknowledgement
  | "rr73" // RR73
  | "73" // 73 sign-off
  | "exchange" // contest exchange (class + ARRL section)
  | "unknown";

// Result of parsing the decoded FT8 *text* (e.g. "W4DW K9OM R 1E WI").
export interface Ft8Parsed {
  toCall: string | null; // null for CQ (broadcast)
  fromCall: string | null;
  msgType: MsgType;
  grid: string | null; // Maidenhead if present in the text
  reportDb: number | null; // signal report embedded in the text, if any
  section: string | null; // ARRL/RAC section if a contest exchange
  fdClass: string | null; // Field Day class token, e.g. "2D" / "1E" / "5A"
  exchange: string | null; // raw exchange remainder (everything after the calls)
  cqModifier: string | null; // DX / FD / POTA / etc.
}

// A fully-enriched spot: a Decode joined with current Status state + resolved geo.
export interface Spot {
  id?: number;
  receivedAt: string; // ISO-8601 UTC
  instance: string; // WSJT-X Id (supports multiple rigs later)
  rxCall: string | null; // the local receiver (from Status)
  rxGrid: string | null; // canonical location datum
  rxLat: number | null; // derived (center of grid square) — not stored
  rxLon: number | null;
  band: string | null; // e.g. "15m"
  dialFreq: number; // Hz
  mode: string; // FT8, FT4, ...
  snr: number; // OUR receive strength: how well rxCall heard fromCall (edge fromCall->rxCall), dB
  dt: number; // time offset, s
  audioDf: number; // audio offset within the passband, Hz (the ~3 kHz window)
  decodeTimeMs: number | null; // FT8 cycle time (ms since midnight UTC); identifies the decode period
  rawMessage: string;
  fromCall: string | null;
  toCall: string | null;
  msgType: MsgType;
  exchange: string | null;
  cqModifier: string | null; // CQ modifier from the CQ text (DX / FD / POTA / …)
  section: string | null;
  fdClass: string | null; // Field Day class, e.g. "2D"
  // Embedded report carried in the message text (e.g. "W1ABC K9OM R-10"): how
  // fromCall heard toCall (edge toCall->fromCall). Distinct from `snr` above.
  reportDb: number | null;
  // Transmitter (fromCall) canonical location: grid and/or ARRL section (the
  // `section` field above). lat/lon are derived (center of grid square).
  txGrid: string | null;
  txLat: number | null; // derived — not stored
  txLon: number | null;
  txSource: GeoSource;
  // Recipient (toCall) canonical location — the *other* end of the QSO, so the
  // live view can draw arcs between the two nodes (not back to us).
  toGrid: string | null;
  toSection: string | null;
  toLat: number | null; // derived — not stored
  toLon: number | null;
  toSource: GeoSource;
  isNew: boolean;
  lowConf: boolean;
  offAir: boolean;
}

export interface LatLon {
  lat: number;
  lon: number;
}

// Per-ARRL-section rollup for the hunt widget.
export interface SectionStat {
  section: string; // code, e.g. "WI"
  name: string; // full name
  state: string | null; // US state polygon name for the outline overlay (null = Canada/PR/VI)
  stationsHeard: number; // distinct stations copied from this section
  bestSnr: number | null; // strongest reception
  closestKm: number | null; // nearest station we've heard from it
  worked: boolean; // we copied a closing handshake from this section to our own call
}

// A currently-active QSO between two *other* stations (never us). Live only.
export interface Exchange {
  cqer: string; // the station that called CQ / was being called
  responder: string; // the station working them (the chosen one, if a pileup)
  cqerClass: string | null; // Field Day class each station sent, e.g. "2D"
  responderClass: string | null;
  cqerSection: string | null; // ARRL section each station sent in its exchange, e.g. "EPA"
  responderSection: string | null;
  role: "cq" | "called"; // "cq" = we actually saw the CQ; "called" = inferred from who was called first
  // Which contest protocol's stage model applies. Field Day has no grid/report
  // steps (it's class+section), so the steps differ — see `steps`.
  protocol: "ft8" | "fieldday";
  steps: string[]; // canonical step labels for this protocol (the progress-bar segments)
  stage: string; // human label of how far the QSO has progressed
  stageRank: number; // 1..steps.length (0 = unknown)
  seenSteps: boolean[]; // length steps.length: which canonical steps we copied (rest are holes)
  msgCount: number; // total decodes observed in this pair (for filtering noise)
  // Bidirectional link SNR from the *embedded* reports — NOT our receive SNR.
  cqerHeardResponder: number | null; // avg report the CQer sent (how the CQer hears the responder)
  responderHeardCqer: number | null;
  retransmissions: number; // repeated identical messages across cycles (no ack)
  contenders: number; // distinct stations calling the CQer (pileup size)
  contenderCalls: string[]; // those callsigns (for map highlight of who's jumping in)
  halfCopy: boolean; // we only decoded one side of the exchange
  lastSeen: string;
  band: string | null;
  log: ExchangeLogEntry[]; // play-by-play of the decodes, with OUR receive SNR per line
}

export interface ExchangeLogEntry {
  t: string; // ISO time we received it
  from: string;
  to: string;
  msg: string; // raw decoded text
  snr: number; // OUR receive strength of this transmission
  type: string; // msgType
}

export type GeoSource = "cq-grid" | "msg-grid" | "callbook" | "section" | null;

export interface Station {
  call: string;
  grid: string | null;
  lat: number | null;
  lon: number | null;
  source: GeoSource;
  arrlSection: string | null;
  firstSeen: string;
  lastSeen: string;
}

// A station currently calling CQ (and not yet engaged), for the CQ-callers widget.
export interface CqCaller {
  call: string;
  snr: number; // OUR receive strength of their latest CQ
  distanceKm: number | null; // great-circle from our station to theirs
  grid: string | null;
  section: string | null; // ARRL section the caller advertised (from an exchange), if any
  fdClass: string | null; // Field Day class the caller advertised, e.g. "2D", if any
  fd: boolean; // advertised Field Day (CQ FD or a parsed class) somewhere in the window
  band: string | null;
  lastSeen: string;
  cqCount: number; // how many CQs in the window (persistence)
  qsosLastHour: number; // inferred completed QSOs in the last hour
  activeness: number; // 0..100: rate of contacts + transmit duty cycle (how hard they're running)
  workedAt: number | null; // ms timestamp we last logged a QSO with them (from WSJT-X), else null
}

// Our own operating state, from WSJT-X Status — so the UI knows when we're
// actively in a QSO (and auto-hunt can stand down).
export interface MyStatus {
  transmitting: boolean;
  txEnabled: boolean; // Tx is enabled = we're committed to working the current DX
  dxCall: string | null;
  dxGrid: string | null;
  txMessage: string | null;
  fastMode: boolean; // echoed back in Configure (it has no "no change" sentinel)
}

// A QSO WSJT-X told us it logged.
export interface QsoRecord {
  workedAt: string; // ISO
  call: string;
  grid: string | null;
  mode: string | null;
  band: string | null;
  reportSent: string | null;
  reportReceived: string | null;
  exchangeReceived: string | null;
}
