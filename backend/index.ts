// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// GridTracker backend: WSJT-X UDP -> ingest -> SQLite -> WebSocket/REST + static UI.
import index from "../frontend/index.html";
import { Db } from "./db.ts";
import { Ingest } from "./ingest.ts";
import { computeExchanges } from "./exchanges.ts";
import { computeCqCallers } from "./cq.ts";
import { computeSectionStats } from "./sections-stats.ts";
import { buildConfigure, buildHaltTx, buildHighlightCallsign, buildReply, parseNetworkMessage } from "./wsjtx/messages.ts";

const EXCHANGE_WINDOW_SEC = 90; // an exchange stays "live" while active within this window

// The WSJT-X source + instance id we last heard from, so we can send commands back.
let wsjtxPeer: { port: number; address: string } | null = null;
let wsjtxId = "WSJT-X";
let lastFastMode = false; // echoed in Configure
let wsClients = 0; // live UI/WebSocket subscribers

// WSJT-X ignores inbound commands unless "Accept UDP requests" is on. We can't
// get an ACK, but we can read that setting from its .ini (cached) and warn.
const WSJTX_INI = process.env.WSJTX_INI ?? `${process.env.HOME ?? ""}/.config/WSJT-X.ini`;
let acceptCache: { val: boolean; t: number } | null = null;
async function udpAccepted(): Promise<boolean> {
  if (acceptCache && Date.now() - acceptCache.t < 5000) return acceptCache.val;
  let val = true; // unknown -> don't block
  try {
    const m = (await Bun.file(WSJTX_INI).text()).match(/AcceptUDPRequests\s*=\s*(true|false)/i);
    if (m) val = m[1].toLowerCase() === "true";
  } catch { /* can't read ini */ }
  acceptCache = { val, t: Date.now() };
  return val;
}
async function ensureAccepted(): Promise<Response | null> {
  if (await udpAccepted()) return null;
  return Response.json({
    ok: false, error: "udp-disabled",
    hint: 'WSJT-X is ignoring commands — enable Settings → Reporting → UDP Server → "Accept UDP requests" (and "Notify on accepted UDP request")',
  }, { status: 409 });
}

const HTTP_PORT = Number(process.env.PORT ?? 8787);
const UDP_PORT = Number(process.env.WSJTX_PORT ?? 2237);
const WS_TOPIC = "spots";

// UDP forwarding (rebroadcast). WSJT-X emits to a single UDP destination, so once
// SpotScope owns 2237 every other tool (loggers, JTAlert, GridTracker, …) is shut
// out. We re-publish every datagram we receive, byte-for-byte, to one or more
// local ports those tools can listen on. ON BY DEFAULT; set UDP_FORWARD=0 to stop.
// UDP_FORWARD_TARGETS is a comma list of "port" or "host:port" (default WSJTX_PORT+1).
interface FwdTarget { host: string; port: number; }
function parseBool(v: string | undefined, dflt: boolean): boolean {
  return v == null || v === "" ? dflt : /^(1|true|on|yes)$/i.test(v.trim());
}
function parseTargets(spec: string): FwdTarget[] {
  const out: FwdTarget[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = raw.lastIndexOf(":"); // "host:port" or bare "port"
    const host = i > 0 ? raw.slice(0, i) : "127.0.0.1";
    const port = Number(i > 0 ? raw.slice(i + 1) : raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) out.push({ host, port });
  }
  return out;
}
const isLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
const UDP_FORWARD = parseBool(process.env.UDP_FORWARD, true);
const forwardTargets = (UDP_FORWARD ? parseTargets(process.env.UDP_FORWARD_TARGETS ?? String(UDP_PORT + 1)) : [])
  // Never forward to our own listen port: that's an infinite, amplifying loop.
  .filter((t) => {
    if (t.port === UDP_PORT && isLoopback(t.host)) {
      console.warn(`  ⚠ udp-forward target ${t.host}:${t.port} is our own listen port — skipping (would loop)`);
      return false;
    }
    return true;
  });

const db = new Db(process.env.GT_DB ?? "gridtracker.sqlite");

const PRODUCTION = process.env.NODE_ENV === "production";

const server = Bun.serve({
  port: HTTP_PORT,
  development: !PRODUCTION, // prod: bundle the UI once (minified, cached) instead of per-request
  routes: {
    "/": index,
    "/api/spots": () => Response.json(db.recentSpots(800)),
    "/api/stations": () => Response.json(db.allStations()),
    "/api/station": (req: Request) => {
      const call = new URL(req.url).searchParams.get("call");
      return call ? Response.json(db.stationHistory(call)) : Response.json([], { status: 400 });
    },
    "/api/sections": () => Response.json(
      computeSectionStats(db.spotsSince(new Date(Date.now() - 2 * 3600 * 1000).toISOString())),
    ),
    "/api/exchanges": () => Response.json(
      computeExchanges(db.spotsSince(new Date(Date.now() - EXCHANGE_WINDOW_SEC * 1000).toISOString())),
    ),
    "/api/cq": () => Response.json(
      computeCqCallers(
        db.spotsSince(new Date(Date.now() - EXCHANGE_WINDOW_SEC * 1000).toISOString()),
        db.spotsSince(new Date(Date.now() - 3600 * 1000).toISOString()),
        db.workedMap(),
      ),
    ),
    // Ask WSJT-X to set up a QSO with this station (echo its CQ back as a Reply).
    "/api/call": {
      POST: async (req: Request) => {
        const { call } = await req.json().catch(() => ({ call: "" }));
        if (!call) return Response.json({ ok: false, error: "missing call" }, { status: 400 });
        const decode = ingest.replyFor(call) ?? db.latestCqDecodeFor(call);
        if (!decode) return Response.json({ ok: false, error: `no recent CQ from ${call}` }, { status: 404 });
        if (!wsjtxPeer) return Response.json({ ok: false, error: "WSJT-X not seen yet" }, { status: 503 });
        const blocked = await ensureAccepted();
        if (blocked) return blocked;
        udp.send(buildReply(decode), wsjtxPeer.port, wsjtxPeer.address);
        return Response.json({ ok: true, call, message: decode.message });
      },
    },
    // Highlight (or clear) a callsign in WSJT-X's Band Activity window.
    "/api/highlight": {
      POST: async (req: Request) => {
        const { call, on } = await req.json().catch(() => ({}));
        if (!call) return Response.json({ ok: false, error: "missing call" }, { status: 400 });
        if (!wsjtxPeer) return Response.json({ ok: false, error: "WSJT-X not seen yet" }, { status: 503 });
        const blocked = await ensureAccepted();
        if (blocked) return blocked;
        const bg = on ? { r: 79, g: 209, b: 255 } : null; // cyan highlight, or clear
        udp.send(buildHighlightCallsign(wsjtxId, call, bg), wsjtxPeer.port, wsjtxPeer.address);
        return Response.json({ ok: true });
      },
    },
    // Point WSJT-X at a specific station (e.g. an answerer from our CQ pileup).
    "/api/dx": {
      POST: async (req: Request) => {
        const { call, grid } = await req.json().catch(() => ({}));
        if (!call) return Response.json({ ok: false, error: "missing call" }, { status: 400 });
        if (!wsjtxPeer) return Response.json({ ok: false, error: "WSJT-X not seen yet" }, { status: 503 });
        const blocked = await ensureAccepted();
        if (blocked) return blocked;
        udp.send(buildConfigure(wsjtxId, { dxCall: call, dxGrid: grid ?? "", fastMode: lastFastMode, generateMessages: true }), wsjtxPeer.port, wsjtxPeer.address);
        return Response.json({ ok: true, call });
      },
    },
    // Abort an in-progress transmission.
    "/api/halt": {
      POST: async () => {
        if (!wsjtxPeer) return Response.json({ ok: false, error: "WSJT-X not seen yet" }, { status: 503 });
        const blocked = await ensureAccepted();
        if (blocked) return blocked;
        udp.send(buildHaltTx(wsjtxId, false), wsjtxPeer.port, wsjtxPeer.address);
        return Response.json({ ok: true });
      },
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe(WS_TOPIC);
      console.log(`  [client] connected (${ws.remoteAddress}) — ${++wsClients} online`);
    },
    message() {},
    close(ws) {
      ws.unsubscribe(WS_TOPIC);
      wsClients = Math.max(0, wsClients - 1);
      console.log(`  [client] disconnected — ${wsClients} online`);
    },
  },
});

const ingest = new Ingest(db, (spot) => {
  server.publish(WS_TOPIC, JSON.stringify({ type: "spot", spot }));
}, (qso) => {
  server.publish(WS_TOPIC, JSON.stringify({ type: "qso", qso }));
}, (status) => {
  lastFastMode = status.fastMode;
  server.publish(WS_TOPIC, JSON.stringify({ type: "status", status }));
});

// Dedicated sender so forwarded traffic (and any chatter back to it) stays off
// the WSJT-X command path. Opened only when there's somewhere to forward to. The
// error handler swallows ICMP port-unreachable (ECONNREFUSED), delivered out of
// band when nothing is listening on a target port — forwarding is best-effort.
const fwdSock = forwardTargets.length ? await Bun.udpSocket({ socket: { error() {} } }) : null;

const udp = await Bun.udpSocket({
  port: UDP_PORT,
  socket: {
    data(_socket, buf, port, address) {
      wsjtxPeer = { port, address }; // remember where to send Reply messages
      // Rebroadcast verbatim before parsing, so even frames we don't decode reach
      // downstream tools (and a parse throw can't swallow the forward). Best-effort:
      // if no consumer is up on a target, the send throws ECONNREFUSED — ignore it.
      if (fwdSock) {
        for (const t of forwardTargets) {
          try { fwdSock.send(buf, t.port, t.host); } catch { /* no listener on that port */ }
        }
      }
      const msg = parseNetworkMessage(buf as Buffer);
      if (msg) ingest.handle(msg);
    },
  },
});

const link = `http://localhost:${HTTP_PORT}`;
console.log(`\n  SpotScope is up${PRODUCTION ? "" : " (dev)"} — open the UI:\n`);
console.log(`      \x1b[1;36m\x1b]8;;${link}\x1b\\${link}\x1b]8;;\x1b\\\x1b[0m\n`);
console.log(`  WSJT-X UDP  listening on udp/${udp.port}`);
console.log(`  udp forward ${forwardTargets.length ? `→ ${forwardTargets.map((t) => `${t.host}:${t.port}`).join(", ")}` : UDP_FORWARD ? "on (no valid targets)" : "off"}`);
console.log(`  database    ${process.env.GT_DB ?? "gridtracker.sqlite"}\n`);

// Graceful shutdown. As PID 1 in a container there are no default signal
// handlers, so without these SIGTERM is ignored and `docker stop` SIGKILLs us
// after the grace period. Stop the listeners and exit promptly.
let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${sig} received — shutting down…`);
  try { server.stop(true); } catch {}
  try { udp.close(); } catch {}
  try { fwdSock?.close(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
