// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Stateful enrichment: track WSJT-X Status (dial freq/band, local receiver) and
// turn each Decode into a fully-resolved Spot, persisting it and the station.
// Canonical location is symbolic (grid / ARRL section); lat/lon is derived via
// locate() (center of grid square) only for the live wire payload.
import type { Db } from "./db.ts";
import type { NetworkMessage, ReplyDecode } from "./wsjtx/messages.ts";
import type { GeoSource, MyStatus, QsoRecord, Spot } from "./types.ts";
import { parseFt8 } from "./wsjtx/ft8.ts";
import { locate } from "./geo/locate.ts";

interface RxState {
  dialFreq: number;
  mode: string | null;
  rxCall: string | null;
  rxGrid: string | null;
}

export class Ingest {
  private db: Db;
  private onSpot: (s: Spot) => void;
  private onQso?: (q: QsoRecord) => void;
  private onStatus?: (s: MyStatus) => void;
  private lastStatusKey = "";
  private state = new Map<string, RxState>(); // keyed by WSJT-X instance id
  // Latest CQ decode per callsign, kept so we can echo it back as a Reply (the
  // only decodes WSJT-X will act on are CQ/QRZ).
  private cqDecodes = new Map<string, ReplyDecode>();
  // Latest decode per callsign that was addressed to US — replaying it as a Reply
  // makes WSJT-X advance the QSO (as if we double-clicked their answer to our CQ).
  private toUsDecodes = new Map<string, ReplyDecode>();
  private worked = new Set<string>(); // stations WE have logged (from QSOLogged)
  private txState = new Map<string, { transmitting: boolean; txMessage: string | null }>();

  constructor(db: Db, onSpot: (s: Spot) => void, onQso?: (q: QsoRecord) => void, onStatus?: (s: MyStatus) => void) {
    this.db = db;
    this.onSpot = onSpot;
    this.onQso = onQso;
    this.onStatus = onStatus;
  }

  replyFor(call: string): ReplyDecode | undefined { return this.cqDecodes.get(call); }
  // A decode from `call` aimed at us — reply to advance an answerer's sequence.
  latestReplyFor(call: string): ReplyDecode | undefined { return this.toUsDecodes.get(call); }
  workedCalls(): string[] { return [...this.worked]; }

  handle(msg: NetworkMessage): void {
    if (msg.kind === "status") {
      this.state.set(msg.id ?? "", {
        dialFreq: msg.dialFreq, mode: msg.mode, rxCall: msg.deCall, rxGrid: msg.deGrid,
      });
      this.logTx(msg);
      // Broadcast our operating state when it changes (for auto-hunt + UI).
      const key = `${msg.transmitting}|${msg.txEnabled}|${msg.dxCall ?? ""}|${msg.dxGrid ?? ""}|${msg.txMessage ?? ""}`;
      if (key !== this.lastStatusKey) {
        this.lastStatusKey = key;
        console.log(`[status] tx=${msg.transmitting} en=${msg.txEnabled} dx=${msg.dxCall ?? "-"}/${msg.dxGrid ?? "-"} msg="${msg.txMessage ?? ""}"`);
        this.onStatus?.({ transmitting: msg.transmitting, txEnabled: msg.txEnabled, dxCall: msg.dxCall, dxGrid: msg.dxGrid, txMessage: msg.txMessage, fastMode: msg.fastMode });
      }
    } else if (msg.kind === "decode" && msg.message) {
      this.handleDecode(msg);
    } else if (msg.kind === "qsologged" && msg.dxCall) {
      this.worked.add(msg.dxCall);
      const rec: QsoRecord = {
        workedAt: new Date().toISOString(), call: msg.dxCall, grid: msg.dxGrid, mode: msg.mode,
        band: freqToBand(msg.dialFreq), reportSent: msg.reportSent, reportReceived: msg.reportReceived,
        exchangeReceived: msg.exchangeReceived,
      };
      this.db.insertQso(rec);
      this.onQso?.(rec);
      console.log(`[QSO ✓] ${rec.call} ${rec.grid ?? ""} ${rec.band ?? ""} ${rec.mode ?? ""} sent=${rec.reportSent ?? ""} rcvd=${rec.reportReceived ?? ""}${rec.exchangeReceived ? ` exch="${rec.exchangeReceived}"` : ""}`);
    }
  }

  // Log our transmissions (TX start + each changed Tx message) for live observation.
  private logTx(s: Extract<NetworkMessage, { kind: "status" }>): void {
    const key = s.id ?? "";
    const prev = this.txState.get(key) ?? { transmitting: false, txMessage: null };
    if (s.transmitting && (s.txMessage !== prev.txMessage || !prev.transmitting)) {
      console.log(`[TX] "${s.txMessage ?? ""}"${s.dxCall ? `  → ${s.dxCall}` : ""}`);
    } else if (!s.transmitting && prev.transmitting) {
      console.log(`[TX end]${s.dxCall ? `  (dx ${s.dxCall})` : ""}`);
    }
    this.txState.set(key, { transmitting: s.transmitting, txMessage: s.txMessage });
  }

  private handleDecode(d: Extract<NetworkMessage, { kind: "decode" }>): void {
    const st = this.state.get(d.id ?? "");
    const nowIso = new Date().toISOString();
    const p = parseFt8(d.message!);

    // Remember CQ decodes verbatim so the UI can ask WSJT-X to call this station.
    if (p.msgType === "cq" && p.fromCall) {
      this.cqDecodes.set(p.fromCall, {
        id: d.id ?? "", timeMs: d.timeMs, snr: d.snr, dt: d.dt, df: d.df,
        mode: d.mode ?? "", message: d.message!, lowConfidence: d.lowConf,
      });
    }

    // Someone is calling/answering US — surface it, and cache it so we can Reply
    // (advance the QSO) to a station breaking into our CQ.
    if (st?.rxCall && p.toCall === st.rxCall) {
      console.log(`[→ ${st.rxCall}] ${d.snr >= 0 ? "+" : ""}${d.snr}dB  "${d.message}"`);
      if (p.fromCall) {
        this.toUsDecodes.set(p.fromCall, {
          id: d.id ?? "", timeMs: d.timeMs, snr: d.snr, dt: d.dt, df: d.df,
          mode: d.mode ?? "", message: d.message!, lowConfidence: d.lowConf,
        });
      }
    }

    // Resolve transmitter location: message grid -> cached station -> section.
    let txGrid: string | null = p.grid;
    let txSection: string | null = p.section;
    let txSource: GeoSource = null;
    if (p.fromCall) {
      if (p.grid) {
        txSource = p.msgType === "cq" ? "cq-grid" : "msg-grid";
      } else {
        const cached = this.db.lookupStation(p.fromCall);
        if (cached?.grid) { txGrid = cached.grid; txSource = cached.source; }
        else if (cached?.arrl_section) { txSection = cached.arrl_section; txSource = "section"; }
        else if (p.section) { txSection = p.section; txSource = "section"; }
      }
      // Remember what we learned so future gridless decodes of this call resolve.
      this.db.upsertStation(p.fromCall, txGrid, txSection, txSource, nowIso);
    }

    // Resolve the recipient (toCall) from what we've already learned about it,
    // so the live view can draw an arc between the two QSO endpoints.
    let toGrid: string | null = null;
    let toSection: string | null = null;
    let toSource: GeoSource = null;
    if (p.toCall) {
      const cached = this.db.lookupStation(p.toCall);
      if (cached?.grid) { toGrid = cached.grid; toSource = cached.source; }
      else if (cached?.arrl_section) { toSection = cached.arrl_section; toSource = "section"; }
    }

    const txLL = locate(txGrid, txSection);
    const toLL = locate(toGrid, toSection);
    const rxLL = locate(st?.rxGrid, null);

    const spot: Spot = {
      receivedAt: nowIso,
      instance: d.id ?? "",
      rxCall: st?.rxCall ?? null,
      rxGrid: st?.rxGrid ?? null,
      rxLat: rxLL?.lat ?? null,
      rxLon: rxLL?.lon ?? null,
      band: st ? freqToBand(st.dialFreq) : null,
      dialFreq: st?.dialFreq ?? 0,
      mode: d.mode ?? st?.mode ?? "",
      snr: d.snr,
      dt: d.dt,
      audioDf: d.df,
      decodeTimeMs: d.timeMs,
      rawMessage: d.message!,
      fromCall: p.fromCall,
      toCall: p.toCall,
      msgType: p.msgType,
      exchange: p.exchange,
      cqModifier: p.cqModifier,
      section: txSection,
      fdClass: p.fdClass,
      reportDb: p.reportDb,
      txGrid, txLat: txLL?.lat ?? null, txLon: txLL?.lon ?? null, txSource,
      toGrid, toSection, toLat: toLL?.lat ?? null, toLon: toLL?.lon ?? null, toSource,
      isNew: d.isNew,
      lowConf: d.lowConf,
      offAir: d.offAir,
    };

    spot.id = this.db.insertSpot(spot);
    this.onSpot(spot);
  }
}

export function freqToBand(hz: number): string | null {
  const mhz = hz / 1e6;
  const bands: [number, number, string][] = [
    [1.8, 2.0, "160m"], [3.5, 4.0, "80m"], [5.3, 5.4, "60m"], [7.0, 7.3, "40m"],
    [10.1, 10.15, "30m"], [14.0, 14.35, "20m"], [18.068, 18.168, "17m"],
    [21.0, 21.45, "15m"], [24.89, 24.99, "12m"], [28.0, 29.7, "10m"],
    [50, 54, "6m"], [144, 148, "2m"], [222, 225, "1.25m"], [420, 450, "70cm"],
  ];
  for (const [lo, hi, name] of bands) if (mhz >= lo && mhz <= hi) return name;
  return null;
}
