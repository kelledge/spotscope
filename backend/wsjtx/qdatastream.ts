// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Big-endian Qt QDataStream reader for the WSJT-X UDP protocol.
// Strings are quint32 length-prefixed UTF-8 (0xffffffff = null); QTime is a
// quint32 of milliseconds since midnight.

export class Reader {
  private off = 0;
  private buf: Buffer;
  constructor(buf: Buffer | Uint8Array) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }
  u8() { const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  bool() { return this.u8() !== 0; }
  u32() { const v = this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  i32() { const v = this.buf.readInt32BE(this.off); this.off += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.off); this.off += 8; return Number(v); }
  i64() { const v = this.buf.readBigInt64BE(this.off); this.off += 8; return v; }
  f64() { const v = this.buf.readDoubleBE(this.off); this.off += 8; return v; }
  remaining() { return this.buf.length - this.off; }

  // QDateTime (QDataStream Qt_5_x): QDate(qint64 julian) + QTime(quint32 ms) +
  // quint8 timespec (+qint32 offset when spec==2). We only need to skip past it.
  qdatetime() {
    this.i64();
    this.u32();
    const spec = this.u8();
    if (spec === 2) this.i32();
  }

  utf8(): string | null {
    const len = this.u32();
    if (len === 0xffffffff) return null;
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }

  // QTime -> milliseconds since midnight (or null). Caller combines with a date.
  qtimeMs(): number | null {
    const ms = this.u32();
    return ms === 0xffffffff ? null : ms;
  }
}
