// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Big-endian Qt QDataStream writer — the encode side of qdatastream.ts, for
// building outbound WSJT-X messages (Reply, etc.).
export class Writer {
  private chunks: Buffer[] = [];

  u8(v: number) { const b = Buffer.allocUnsafe(1); b.writeUInt8(v & 0xff); this.chunks.push(b); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(v & 0xffff); this.chunks.push(b); return this; }
  u32(v: number) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v >>> 0); this.chunks.push(b); return this; }
  i32(v: number) { const b = Buffer.allocUnsafe(4); b.writeInt32BE(v | 0); this.chunks.push(b); return this; }
  f64(v: number) { const b = Buffer.allocUnsafe(8); b.writeDoubleBE(v); this.chunks.push(b); return this; }

  // utf8 string as a Qt QByteArray: quint32 length + bytes; null = 0xffffffff.
  utf8(s: string | null) {
    if (s == null) return this.u32(0xffffffff);
    const body = Buffer.from(s, "utf8");
    this.u32(body.length);
    this.chunks.push(body);
    return this;
  }

  // QTime as quint32 ms since midnight (0xffffffff = null).
  qtimeMs(ms: number | null) { return this.u32(ms == null ? 0xffffffff : ms); }

  // QColor (QDataStream v7+ format): qint8 spec, then quint16 alpha/r/g/b/pad,
  // 8-bit components scaled to 16-bit (v*0x101). null = Invalid spec (clears).
  qcolor(c: { r: number; g: number; b: number; a?: number } | null) {
    if (!c) return this.u8(0).u16(0).u16(0).u16(0).u16(0).u16(0); // Invalid
    return this.u8(1) // Rgb spec
      .u16((c.a ?? 255) * 0x101)
      .u16(c.r * 0x101).u16(c.g * 0x101).u16(c.b * 0x101)
      .u16(0); // pad
  }

  build() { return Buffer.concat(this.chunks); }
}
