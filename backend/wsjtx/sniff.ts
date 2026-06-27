// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Standalone WSJT-X UDP sniffer — proves we can receive + decode the stream.
// Wire format per WSJT-X Network/NetworkMessage.hpp: big-endian QDataStream,
// magic 0xadbccbda, then schema (quint32), then each message: type (quint32),
// Id (utf8), payload. Strings = quint32 length-prefixed UTF-8 (0xffffffff = null).
// Run: node backend/wsjtx/sniff.ts   (Node 24 strips the TS types natively)
import dgram from "node:dgram";

const MAGIC = 0xadbccbda;
const PORT = Number(process.env.WSJTX_PORT ?? 2237);

class Reader {
  private off = 0;
  private buf: Buffer;
  constructor(buf: Buffer) { this.buf = buf; }
  u8() { const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  bool() { return this.u8() !== 0; }
  u32() { const v = this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  i32() { const v = this.buf.readInt32BE(this.off); this.off += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.off); this.off += 8; return v; }
  f64() { const v = this.buf.readDoubleBE(this.off); this.off += 8; return v; }
  remaining() { return this.buf.length - this.off; }
  utf8(): string | null {
    const len = this.u32();
    if (len === 0xffffffff) return null;
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }
  qtime(): string | null {
    const ms = this.u32();
    if (ms === 0xffffffff) return null;
    const s = Math.floor(ms / 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }
}

function parse(buf: Buffer): Record<string, unknown> {
  const r = new Reader(buf);
  const magic = r.u32();
  if (magic !== MAGIC) return { type: "?", error: `bad magic 0x${magic.toString(16)}` };
  const schema = r.u32();
  const type = r.u32();
  const id = r.utf8();
  switch (type) {
    case 0:
      return { type: "Heartbeat", schema, id, maxSchema: r.u32(), version: r.utf8(), revision: r.utf8() };
    case 1:
      return {
        type: "Status", schema, id,
        dialFreq: r.u64(), mode: r.utf8(), dxCall: r.utf8(), report: r.utf8(), txMode: r.utf8(),
        txEnabled: r.bool(), transmitting: r.bool(), decoding: r.bool(), rxDF: r.i32(), txDF: r.i32(),
        deCall: r.utf8(), deGrid: r.utf8(), dxGrid: r.utf8(), txWatchdog: r.bool(),
        subMode: r.utf8(), fastMode: r.bool(), specialOp: r.remaining() >= 1 ? r.u8() : null,
      };
    case 2:
      return {
        type: "Decode", schema, id,
        isNew: r.bool(), time: r.qtime(), snr: r.i32(), dt: r.f64(), df: r.u32(),
        mode: r.utf8(), message: r.utf8(), lowConf: r.bool(), offAir: r.remaining() >= 1 ? r.bool() : null,
      };
    default:
      return { type: `#${type}`, schema, id };
  }
}

let count = 0;
const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

sock.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n✗ udp/${PORT} is already in use (GridTracker2 is holding it).`);
    console.error(`  Unicast UDP only delivers to one listener, so close GT2 (or repoint`);
    console.error(`  its WSJT-X tap) and re-run, OR set WSJTX_PORT to a port WSJT-X also sends to.\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

sock.on("message", (msg) => {
  let m: Record<string, any>;
  try { m = parse(msg as Buffer); } catch (err) { console.log(`[parse error] ${(err as Error).message}`); return; }
  count++;
  if (m.type === "Decode") {
    console.log(`[Decode]   ${m.time}  ${String(m.snr).padStart(3)} dB  df=${String(m.df).padStart(4)}Hz  ${m.mode}  "${m.message}"`);
  } else if (m.type === "Status") {
    console.log(`[Status]   de ${m.deCall}/${m.deGrid}  dial=${m.dialFreq}Hz  mode=${m.mode}  tx=${m.transmitting}  dec=${m.decoding}`);
  } else if (m.type === "Heartbeat") {
    console.log(`[Heartbeat] id="${m.id}" v=${m.version} rev=${m.revision} maxSchema=${m.maxSchema}`);
  } else {
    console.log(`[${m.type}] id="${m.id}"${m.error ? "  " + m.error : ""}`);
  }
});

sock.bind(PORT, () => console.log(`listening on udp/${PORT} … (decodes arrive on the 15s FT8 cycle; ctrl-C to stop)`));

process.on("SIGINT", () => { console.log(`\n${count} messages decoded. bye.`); process.exit(0); });
