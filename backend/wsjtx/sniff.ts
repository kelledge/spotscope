// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// WSJT-X UDP terminal logger — decode + pretty-print every datagram WSJT-X emits,
// to explore how deeply we can integrate. Wire format per WSJT-X
// Network/NetworkMessage.hpp: big-endian QDataStream, magic 0xadbccbda, schema
// (quint32), then per message: type (quint32), Id (utf8), payload. Strings are
// quint32 length-prefixed UTF-8 (0xffffffff = null).
//
// Run:  bun run sniff
//   WSJTX_PORT=2238  read SpotScope's *forwarded* stream while it's running
//                    (SpotScope owns 2237 and forwards to 2238 by default)
//   WSJTX_HEX=1      also hex-dump every datagram (raw bytes, for reverse-eng)
import dgram from "node:dgram";

const MAGIC = 0xadbccbda;
const PORT = Number(process.env.WSJTX_PORT ?? 2237);
const HEX = /^(1|true|on|yes)$/i.test(process.env.WSJTX_HEX ?? "");

// Message type -> name (both directions; we only *receive* a subset).
const TYPES: Record<number, string> = {
  0: "Heartbeat", 1: "Status", 2: "Decode", 3: "Clear", 4: "Reply",
  5: "QSO Logged", 6: "Close", 7: "Replay", 8: "Halt Tx", 9: "Free Text",
  10: "WSPR Decode", 11: "Location", 12: "Logged ADIF", 13: "Highlight Callsign",
  14: "Switch Configuration", 15: "Configure",
};

class Reader {
  off = 0;
  constructor(private buf: Buffer) {}
  u8() { const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  bool() { return this.u8() !== 0; }
  u32() { const v = this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  i32() { const v = this.buf.readInt32BE(this.off); this.off += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.off); this.off += 8; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.off); this.off += 8; return v; }
  f64() { const v = this.buf.readDoubleBE(this.off); this.off += 8; return v; }
  remaining() { return this.buf.length - this.off; }
  rest() { return this.buf.subarray(this.off); }
  utf8(): string | null {
    const len = this.u32();
    if (len === 0xffffffff) return null;
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }
  // QTime -> "HH:MM:SS.mmm" since midnight UTC, or null.
  qtime(): string | null {
    const ms = this.u32();
    if (ms === 0xffffffff) return null;
    const s = Math.floor(ms / 1000), p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}.${p(ms % 1000, 3)}`;
  }
  // QDateTime: QDate(qint64 julian) + QTime(quint32 ms) + quint8 spec [+qint32 offset].
  qdatetime(): string | null {
    const jdn = Number(this.i64());
    const ms = this.u32();
    const spec = this.u8();
    const off = spec === 2 ? this.i32() : 0;
    if (!jdn || ms === 0xffffffff) return null;
    // Julian Day Number -> Gregorian (Fliegel & Van Flandern).
    const a = jdn + 32044, b = Math.floor((4 * a + 3) / 146097), c = a - Math.floor((146097 * b) / 4);
    const d = Math.floor((4 * c + 3) / 1461), e = c - Math.floor((1461 * d) / 4), m = Math.floor((5 * e + 2) / 153);
    const day = e - Math.floor((153 * m + 2) / 5) + 1, month = m + 3 - 12 * Math.floor(m / 10), year = 100 * b + d - 4800 + Math.floor(m / 10);
    const s = Math.floor(ms / 1000), pad = (n: number) => String(n).padStart(2, "0");
    const tz = spec === 1 ? "Z" : spec === 2 ? ` ${off >= 0 ? "+" : "-"}${Math.abs(off) / 3600}h` : " (local)";
    return `${year}-${pad(month)}-${pad(day)} ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${tz}`;
  }
}

const f = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
const q = (v: string | null) => (v === null ? "—" : `"${v}"`);
const mhz = (hz: bigint) => `${(Number(hz) / 1e6).toFixed(6)} MHz`;
const clock = () => {
  const d = new Date(), p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

// Hex + ASCII dump of a buffer (for unknown messages / WSJTX_HEX mode).
function hexdump(buf: Buffer, indent = "    "): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(16 * 3 - 1, " ");
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${indent}${String(i).padStart(4, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

function format(buf: Buffer): string {
  const r = new Reader(buf);
  if (r.u32() !== MAGIC) return `[?] not a WSJT-X datagram (bad magic)\n${hexdump(buf)}`;
  const schema = r.u32();
  const type = r.u32();
  const id = r.utf8();
  const name = TYPES[type] ?? `#${type}`;
  const head = `[${name}] id=${q(id)} schema=${schema}`;
  try {
    switch (type) {
      case 0:
        return `${head} maxSchema=${r.u32()} version=${q(r.utf8())} revision=${q(r.utf8())}`;
      case 1: {
        const dialFreq = r.u64(), mode = r.utf8(), dxCall = r.utf8(), report = r.utf8(), txMode = r.utf8();
        const txEnabled = r.bool(), transmitting = r.bool(), decoding = r.bool(), rxDF = r.i32(), txDF = r.i32();
        const deCall = r.utf8(), deGrid = r.utf8(), dxGrid = r.utf8(), txWatchdog = r.bool();
        const subMode = r.utf8(), fastMode = r.bool(), special = r.remaining() >= 1 ? r.u8() : null;
        let freqTol: number | null = null, trPeriod: number | null = null, cfg: string | null = null, txMsg: string | null = null;
        if (r.remaining() >= 8) { freqTol = r.u32(); trPeriod = r.u32(); cfg = r.remaining() >= 4 ? r.utf8() : null; txMsg = r.remaining() >= 4 ? r.utf8() : null; }
        return `${head}\n    de ${f(deCall)}/${f(deGrid)}  dx ${f(dxCall)}/${f(dxGrid)}  dial=${mhz(dialFreq)} mode=${f(mode)}${subMode ? "/" + subMode : ""} txMode=${f(txMode)}`
          + `\n    tx=${transmitting} txEnabled=${txEnabled} decoding=${decoding} watchdog=${txWatchdog} fast=${fastMode} special=${f(special)}`
          + `\n    rxDF=${rxDF} txDF=${txDF} report=${f(report)} freqTol=${f(freqTol)} T/R=${f(trPeriod)}s config=${q(cfg)}`
          + `\n    txMessage=${q(txMsg)}`;
      }
      case 2: {
        const isNew = r.bool(), time = r.qtime(), snr = r.i32(), dt = r.f64(), df = r.u32();
        const mode = r.utf8(), message = r.utf8(), lowConf = r.bool(), offAir = r.remaining() >= 1 ? r.bool() : null;
        return `${head}  ${f(time)}  ${String(snr).padStart(3)}dB dt=${dt.toFixed(1)} df=${String(df).padStart(4)}Hz ${f(mode)} new=${isNew} lowConf=${lowConf} offAir=${f(offAir)}\n    message=${q(message)}`;
      }
      case 3:
        return `${head} window=${r.remaining() >= 1 ? r.u8() : "—"}`;
      case 5: {
        const timeOff = r.qdatetime(), dxCall = r.utf8(), dxGrid = r.utf8(), txFreq = r.u64(), mode = r.utf8();
        const rSent = r.utf8(), rRcvd = r.utf8(), power = r.utf8(), comments = r.utf8(), nm = r.utf8();
        const timeOn = r.qdatetime(), op = r.utf8(), myCall = r.utf8(), myGrid = r.utf8();
        const exSent = r.remaining() >= 4 ? r.utf8() : null, exRcvd = r.remaining() >= 4 ? r.utf8() : null, prop = r.remaining() >= 4 ? r.utf8() : null;
        return `${head}\n    dx ${f(dxCall)}/${f(dxGrid)}  freq=${mhz(txFreq)} mode=${f(mode)}  sent=${f(rSent)} rcvd=${f(rRcvd)}`
          + `\n    exchSent=${q(exSent)} exchRcvd=${q(exRcvd)}  myCall=${f(myCall)}/${f(myGrid)} op=${f(op)}`
          + `\n    power=${q(power)} name=${q(nm)} comments=${q(comments)} prop=${q(prop)}`
          + `\n    on=${f(timeOn)}  off=${f(timeOff)}`;
      }
      case 6:
        return head; // Close — no payload
      case 10: {
        const isNew = r.bool(), time = r.qtime(), snr = r.i32(), dt = r.f64(), freq = r.u64();
        const drift = r.i32(), callsign = r.utf8(), grid = r.utf8(), power = r.i32(), offAir = r.remaining() >= 1 ? r.bool() : null;
        return `${head}  ${f(time)} ${snr}dB dt=${dt.toFixed(1)} freq=${mhz(freq)} drift=${drift} power=${power}dBm offAir=${f(offAir)} new=${isNew}\n    ${f(callsign)} ${f(grid)}`;
      }
      case 12:
        return `${head}\n${(r.utf8() ?? "—").split("\n").map((l) => "    " + l).join("\n")}`; // Logged ADIF text
      default:
        // Unknown / client->server type we don't normally receive — dump what's left.
        return r.remaining() ? `${head}\n${hexdump(r.rest())}` : head;
    }
  } catch (err) {
    return `${head}  [parse stopped: ${(err as Error).message}]\n${hexdump(r.rest())}`;
  }
}

let count = 0;
const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

sock.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n✗ udp/${PORT} is already in use.`);
    console.error(`  SpotScope (or GridTracker) likely owns it. To watch the stream while`);
    console.error(`  SpotScope runs, read its forwarded copy:  WSJTX_PORT=2238 bun run sniff\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

sock.on("message", (msg) => {
  count++;
  const buf = msg as Buffer;
  console.log(`\n${clock()}  (${buf.length}B)  ${format(buf)}`);
  if (HEX) console.log(hexdump(buf));
});

sock.bind(PORT, () => {
  console.log(`WSJT-X UDP logger — listening on udp/${PORT}${HEX ? " (hex on)" : ""}`);
  console.log(`Decodes arrive on the 15s FT8 cycle; Status/Heartbeat stream continuously. Ctrl-C to stop.\n`);
});

process.on("SIGINT", () => { console.log(`\n${count} datagrams. bye.`); process.exit(0); });
