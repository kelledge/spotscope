// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Parse a raw WSJT-X UDP datagram into a typed NetworkMessage.
// Field order/types per WSJT-X Network/NetworkMessage.hpp (schema 3).
import { Reader } from "./qdatastream.ts";
import { Writer } from "./qwriter.ts";

export const MAGIC = 0xadbccbda;

export interface Heartbeat {
  kind: "heartbeat";
  id: string | null;
  maxSchema: number;
  version: string | null;
  revision: string | null;
}

export interface Status {
  kind: "status";
  id: string | null;
  dialFreq: number;
  mode: string | null;
  dxCall: string | null;
  report: string | null;
  txMode: string | null;
  txEnabled: boolean;
  transmitting: boolean;
  decoding: boolean;
  rxDf: number;
  txDf: number;
  deCall: string | null;
  deGrid: string | null;
  dxGrid: string | null;
  txWatchdog: boolean;
  subMode: string | null;
  fastMode: boolean;
  specialOp: number | null;
  configName: string | null;
  txMessage: string | null; // what we're currently set to transmit
}

export interface QsoLogged {
  kind: "qsologged";
  id: string | null;
  dxCall: string | null;
  dxGrid: string | null;
  dialFreq: number;
  mode: string | null;
  reportSent: string | null;
  reportReceived: string | null;
  exchangeSent: string | null;
  exchangeReceived: string | null;
  myCall: string | null;
}

export interface Decode {
  kind: "decode";
  id: string | null;
  isNew: boolean;
  timeMs: number | null; // ms since midnight UTC
  snr: number;
  dt: number;
  df: number;
  mode: string | null;
  message: string | null;
  lowConf: boolean;
  offAir: boolean;
}

export interface Other {
  kind: "other";
  type: number;
  id: string | null;
}

export type NetworkMessage = Heartbeat | Status | Decode | QsoLogged | Other;

// The decode fields needed to build a Reply that WSJT-X will match. WSJT-X only
// acts on a Reply if it EXACTLY matches a prior CQ/QRZ decode it made.
export interface ReplyDecode {
  id: string;
  timeMs: number | null;
  snr: number;
  dt: number;
  df: number;
  mode: string;
  message: string;
  lowConfidence: boolean;
}

// Build a Reply (type 4) datagram. Sending this to WSJT-X is equivalent to the
// operator double-clicking that decode: it sets up the QSO and the Tx messages.
export function buildReply(d: ReplyDecode, schema = 2): Buffer {
  return new Writer()
    .u32(MAGIC).u32(schema).u32(4)
    .utf8(d.id)
    .qtimeMs(d.timeMs)
    .i32(d.snr)
    .f64(d.dt)
    .u32(d.df)
    .utf8(d.mode)
    .utf8(d.message)
    .bool(d.lowConfidence)
    .u8(0) // keyboard modifiers: none
    .build();
}

type Rgb = { r: number; g: number; b: number };

// HighlightCallsign (13): paint a callsign in WSJT-X's Band Activity / Rx windows.
// Pass bg=null to clear the highlight for that callsign.
export function buildHighlightCallsign(id: string, callsign: string, bg: Rgb | null, fg: Rgb | null = { r: 0, g: 0, b: 0 }, highlightLast = false, schema = 2): Buffer {
  return new Writer()
    .u32(MAGIC).u32(schema).u32(13)
    .utf8(id)
    .utf8(callsign)
    .qcolor(bg)
    .qcolor(bg ? fg : null)
    .bool(highlightLast)
    .build();
}

// Configure (15): set the DX call/grid (and generate Tx messages) to point WSJT-X
// at a chosen station. utf8 ""/quint32 0xffffffff mean "no change"; the two bools
// have no sentinel so Fast Mode must echo the current value.
export function buildConfigure(id: string, opts: { dxCall?: string; dxGrid?: string; fastMode: boolean; generateMessages?: boolean; rxDf?: number }, schema = 2): Buffer {
  return new Writer()
    .u32(MAGIC).u32(schema).u32(15)
    .utf8(id)
    .utf8("") // mode: no change
    .u32(0xffffffff) // frequency tolerance: no change
    .utf8("") // submode: no change
    .bool(opts.fastMode) // fast mode (echo current)
    .u32(0xffffffff) // T/R period: no change
    .u32(opts.rxDf ?? 0xffffffff) // Rx DF: no change unless given
    .utf8(opts.dxCall ?? "")
    .utf8(opts.dxGrid ?? "")
    .bool(opts.generateMessages ?? true)
    .build();
}

// HaltTx (8): stop transmitting. autoTxOnly=false halts immediately.
export function buildHaltTx(id: string, autoTxOnly = false, schema = 2): Buffer {
  return new Writer()
    .u32(MAGIC).u32(schema).u32(8)
    .utf8(id)
    .bool(autoTxOnly)
    .build();
}

export function parseNetworkMessage(buf: Buffer | Uint8Array): NetworkMessage | null {
  try {
    return parse(buf);
  } catch {
    return null; // truncated / unexpected message — ignore safely
  }
}

function parse(buf: Buffer | Uint8Array): NetworkMessage | null {
  const r = new Reader(buf);
  if (r.u32() !== MAGIC) return null;
  r.u32(); // schema (unused — we read fields conditionally on remaining())
  const type = r.u32();
  const id = r.utf8();
  switch (type) {
    case 0:
      return { kind: "heartbeat", id, maxSchema: r.u32(), version: r.utf8(), revision: r.utf8() };
    case 1: {
      const st: Status = {
        kind: "status", id,
        dialFreq: r.u64(), mode: r.utf8(), dxCall: r.utf8(), report: r.utf8(), txMode: r.utf8(),
        txEnabled: r.bool(), transmitting: r.bool(), decoding: r.bool(), rxDf: r.i32(), txDf: r.i32(),
        deCall: r.utf8(), deGrid: r.utf8(), dxGrid: r.utf8(), txWatchdog: r.bool(),
        subMode: r.utf8(), fastMode: r.bool(), specialOp: r.remaining() >= 1 ? r.u8() : null,
        configName: null, txMessage: null,
      };
      // trailing schema-3 fields: frequency tolerance, T/R period, config name, tx message
      if (r.remaining() >= 8) {
        r.u32(); r.u32();
        st.configName = r.remaining() >= 4 ? r.utf8() : null;
        st.txMessage = r.remaining() >= 4 ? r.utf8() : null;
      }
      return st;
    }
    case 5: {
      r.qdatetime(); // time off
      const dxCall = r.utf8(), dxGrid = r.utf8(), dialFreq = r.u64(), mode = r.utf8();
      const reportSent = r.utf8(), reportReceived = r.utf8();
      r.utf8(); r.utf8(); r.utf8(); // tx power, comments, name
      r.qdatetime(); // time on
      r.utf8(); // operator call
      const myCall = r.utf8();
      r.utf8(); // my grid
      const exchangeSent = r.remaining() >= 4 ? r.utf8() : null;
      const exchangeReceived = r.remaining() >= 4 ? r.utf8() : null;
      return { kind: "qsologged", id, dxCall, dxGrid, dialFreq, mode, reportSent, reportReceived, exchangeSent, exchangeReceived, myCall };
    }
    case 2:
      return {
        kind: "decode", id,
        isNew: r.bool(), timeMs: r.qtimeMs(), snr: r.i32(), dt: r.f64(), df: r.u32(),
        mode: r.utf8(), message: r.utf8(), lowConf: r.bool(),
        offAir: r.remaining() >= 1 ? r.bool() : false,
      };
    default:
      return { kind: "other", type, id };
  }
}
