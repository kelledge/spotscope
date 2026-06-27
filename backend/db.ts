// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// SQLite persistence (bun:sqlite). `messages` is the append-only source of
// truth (drives live view + graph replay); `stations` accretes resolved
// locations so we can place a callsign even when its current decode has no grid.
//
// We store only the *canonical* location datum (Maidenhead grid and/or ARRL
// section). lat/lon is derived via locate() (center of grid square) at read
// time — it is never persisted.
import { Database } from "bun:sqlite";
import type { GeoSource, QsoRecord, Spot, Station } from "./types.ts";
import type { ReplyDecode } from "./wsjtx/messages.ts";
import { locate } from "./geo/locate.ts";

const INSERT_SQL = `
  INSERT INTO messages (
    received_at, instance, rx_call, rx_grid, band, dial_freq, mode,
    snr, dt, audio_df, decode_time_ms, raw_message, from_call, to_call, msg_type, exchange, section,
    report_db, fd_class, tx_grid, tx_source, to_grid, to_section, to_source, is_new, low_conf, off_air
  ) VALUES (
    $received_at, $instance, $rx_call, $rx_grid, $band, $dial_freq, $mode,
    $snr, $dt, $audio_df, $decode_time_ms, $raw_message, $from_call, $to_call, $msg_type, $exchange, $section,
    $report_db, $fd_class, $tx_grid, $tx_source, $to_grid, $to_section, $to_source, $is_new, $low_conf, $off_air
  ) RETURNING id;`;

const UPSERT_STATION_SQL = `
  INSERT INTO stations (call, grid, source, arrl_section, first_seen, last_seen)
  VALUES ($call, $grid, $source, $section, $now, $now)
  ON CONFLICT(call) DO UPDATE SET
    last_seen = $now,
    grid         = COALESCE($grid, grid),
    arrl_section = COALESCE($section, arrl_section),
    -- upgrade source only when this decode actually carried a fix
    source = CASE WHEN ($grid IS NOT NULL OR $section IS NOT NULL) THEN $source ELSE source END;`;

export class Db {
  private db: Database;

  constructor(path = "gridtracker.sqlite") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  // Checkpoint the WAL back into the main file and close cleanly (shutdown).
  close() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        instance    TEXT,
        rx_call     TEXT,
        rx_grid     TEXT,
        band        TEXT,
        dial_freq   INTEGER,
        mode        TEXT,
        snr         INTEGER,
        dt          REAL,
        audio_df    INTEGER,
        decode_time_ms INTEGER,
        raw_message TEXT,
        from_call   TEXT,
        to_call     TEXT,
        msg_type    TEXT,
        exchange    TEXT,
        section     TEXT,
        report_db   INTEGER,
        fd_class    TEXT,
        tx_grid     TEXT,
        tx_source   TEXT,
        to_grid     TEXT,
        to_section  TEXT,
        to_source   TEXT,
        is_new      INTEGER,
        low_conf    INTEGER,
        off_air     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
      CREATE INDEX IF NOT EXISTS idx_messages_from_call   ON messages(from_call);
      CREATE INDEX IF NOT EXISTS idx_messages_to_call     ON messages(to_call);

      CREATE TABLE IF NOT EXISTS stations (
        call         TEXT PRIMARY KEY,
        grid         TEXT,
        source       TEXT,
        arrl_section TEXT,
        first_seen   TEXT,
        last_seen    TEXT
      );

      CREATE TABLE IF NOT EXISTS qsos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        worked_at   TEXT NOT NULL,
        call        TEXT NOT NULL,
        grid        TEXT,
        mode        TEXT,
        band        TEXT,
        report_sent TEXT,
        report_received TEXT,
        exchange_received TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_qsos_call ON qsos(call);
    `);
    // Upgrade an existing DB in place (no-op on fresh ones — duplicate column throws).
    for (const col of ["fd_class TEXT"]) {
      try { this.db.exec(`ALTER TABLE messages ADD COLUMN ${col};`); } catch { /* present */ }
    }
  }

  insertSpot(s: Spot): number {
    const row = this.db.query(INSERT_SQL).get({
      $received_at: s.receivedAt, $instance: s.instance, $rx_call: s.rxCall, $rx_grid: s.rxGrid,
      $band: s.band, $dial_freq: s.dialFreq, $mode: s.mode, $snr: s.snr, $dt: s.dt,
      $audio_df: s.audioDf, $decode_time_ms: s.decodeTimeMs, $raw_message: s.rawMessage,
      $from_call: s.fromCall, $to_call: s.toCall,
      $msg_type: s.msgType, $exchange: s.exchange, $section: s.section, $report_db: s.reportDb,
      $fd_class: s.fdClass,
      $tx_grid: s.txGrid, $tx_source: s.txSource, $to_grid: s.toGrid, $to_section: s.toSection,
      $to_source: s.toSource, $is_new: s.isNew ? 1 : 0, $low_conf: s.lowConf ? 1 : 0,
      $off_air: s.offAir ? 1 : 0,
    }) as { id: number };
    return row.id;
  }

  upsertStation(call: string, grid: string | null, section: string | null, source: GeoSource, nowIso: string) {
    this.db.query(UPSERT_STATION_SQL).run({
      $call: call, $grid: grid, $section: section, $source: source, $now: nowIso,
    });
  }

  lookupStation(call: string): { grid: string | null; arrl_section: string | null; source: GeoSource } | null {
    return (this.db.query(`SELECT grid, arrl_section, source FROM stations WHERE call = $call;`).get({ $call: call }) as any) ?? null;
  }

  recentSpots(limit = 500): Spot[] {
    const rows = this.db.query(`SELECT * FROM messages ORDER BY id DESC LIMIT $limit;`).all({ $limit: limit }) as any[];
    return rows.reverse().map(rowToSpot);
  }

  // Latest CQ decode from a station, rebuilt as a Reply (survives restarts).
  latestCqDecodeFor(call: string): ReplyDecode | null {
    const r = this.db.query(
      `SELECT instance, decode_time_ms, snr, dt, audio_df, mode, raw_message
       FROM messages WHERE from_call = $call AND msg_type = 'cq' ORDER BY id DESC LIMIT 1;`,
    ).get({ $call: call }) as any;
    if (!r) return null;
    return {
      id: r.instance ?? "", timeMs: r.decode_time_ms, snr: r.snr, dt: r.dt,
      df: r.audio_df, mode: r.mode ?? "", message: r.raw_message, lowConfidence: false,
    };
  }

  insertQso(q: QsoRecord) {
    this.db.query(
      `INSERT INTO qsos (worked_at, call, grid, mode, band, report_sent, report_received, exchange_received)
       VALUES ($at, $call, $grid, $mode, $band, $rs, $rr, $ex);`,
    ).run({
      $at: q.workedAt, $call: q.call, $grid: q.grid, $mode: q.mode, $band: q.band,
      $rs: q.reportSent, $rr: q.reportReceived, $ex: q.exchangeReceived,
    });
  }

  // call -> ms timestamp of our most recent logged QSO with them.
  workedMap(): Map<string, number> {
    const rows = this.db.query(`SELECT call, MAX(worked_at) AS last FROM qsos GROUP BY call;`).all() as any[];
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.call, Date.parse(r.last));
    return m;
  }

  // All decodes involving a station (as sender or recipient), newest first.
  stationHistory(call: string, limit = 100): Spot[] {
    const rows = this.db.query(
      `SELECT * FROM messages WHERE from_call = $call OR to_call = $call ORDER BY id DESC LIMIT $limit;`,
    ).all({ $call: call, $limit: limit }) as any[];
    return rows.map(rowToSpot);
  }

  // Spots within a recent time window (for live-exchange computation).
  spotsSince(sinceIso: string): Spot[] {
    const rows = this.db.query(`SELECT * FROM messages WHERE received_at >= $since ORDER BY id ASC;`).all({ $since: sinceIso }) as any[];
    return rows.map(rowToSpot);
  }

  allStations(): Station[] {
    const rows = this.db.query(`SELECT * FROM stations;`).all() as any[];
    const out: Station[] = [];
    for (const r of rows) {
      const ll = locate(r.grid, r.arrl_section);
      if (!ll) continue; // not yet placeable
      out.push({
        call: r.call, grid: r.grid, lat: ll.lat, lon: ll.lon, source: r.source,
        arrlSection: r.arrl_section, firstSeen: r.first_seen, lastSeen: r.last_seen,
      });
    }
    return out;
  }
}

function rowToSpot(r: any): Spot {
  const txLL = locate(r.tx_grid, r.section);
  const toLL = locate(r.to_grid, r.to_section);
  const rxLL = locate(r.rx_grid, null);
  return {
    id: r.id, receivedAt: r.received_at, instance: r.instance, rxCall: r.rx_call, rxGrid: r.rx_grid,
    rxLat: rxLL?.lat ?? null, rxLon: rxLL?.lon ?? null, band: r.band, dialFreq: r.dial_freq,
    mode: r.mode, snr: r.snr, dt: r.dt, audioDf: r.audio_df, decodeTimeMs: r.decode_time_ms,
    rawMessage: r.raw_message,
    fromCall: r.from_call, toCall: r.to_call, msgType: r.msg_type, exchange: r.exchange,
    section: r.section, fdClass: r.fd_class, reportDb: r.report_db,
    txGrid: r.tx_grid, txLat: txLL?.lat ?? null, txLon: txLL?.lon ?? null, txSource: r.tx_source,
    toGrid: r.to_grid, toSection: r.to_section, toLat: toLL?.lat ?? null, toLon: toLL?.lon ?? null, toSource: r.to_source,
    isNew: !!r.is_new, lowConf: !!r.low_conf, offAir: !!r.off_air,
  };
}
