// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import type { Spot } from "../backend/types.ts";
import { decodeFdClass } from "../backend/fieldday.ts";
import { gridToLatLon } from "../backend/geo/maidenhead.ts";
import { haversineKm } from "../backend/geo/distance.ts";

// --- Theme: auto (follow OS) / dark / light, persisted. Runs before the map so
// the OSM tiles get the correct (or no) filter from the first paint. ---
type ThemePref = "auto" | "dark" | "light";
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
let themePref = (localStorage.getItem("gt-theme") as ThemePref) || "auto";

function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "auto" && prefersDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  localStorage.setItem("gt-theme", pref);
  document.querySelectorAll<HTMLButtonElement>("#theme button").forEach((b) =>
    b.classList.toggle("active", b.dataset.pref === pref));
}
applyTheme(themePref);
prefersDark.addEventListener("change", () => { if (themePref === "auto") applyTheme("auto"); });
document.getElementById("theme")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b?.dataset.pref) { themePref = b.dataset.pref as ThemePref; applyTheme(themePref); }
});

const map = L.map("map", {
  worldCopyJump: true, preferCanvas: true,
  zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120, // finer scroll-wheel zoom steps
}).setView([39.5, -98.35], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const stationLayer = L.layerGroup().addTo(map);
const arcLayer = L.layerGroup().addTo(map);
const pingLayer = L.layerGroup().addTo(map);
const focusLayer = L.layerGroup().addTo(map);
const autoTargetLayer = L.layerGroup().addTo(map);
const selectLayer = L.layerGroup().addTo(map); // the currently-selected station's cue

interface StationView { marker: L.CircleMarker; lastSeen: number; }
const stations = new Map<string, StationView>();

// `line` is the visible arc; `hit` is a wide invisible line on top so the thin
// arc is easy to click (-> pin its exchange). Both fade/reap together.
interface ArcView { line: L.Polyline; hit: L.Polyline; created: number; }
const arcs: ArcView[] = [];
const ARC_TTL = 30_000;

let spotCount = 0;
const el = (id: string) => document.getElementById(id)!;

// SNR -> color: -21 dB red, ramping to rich green by 0 dB (clamped). Lightness
// stays high enough that the weak (red) end is legible on the dark theme.
function snrColor(snr: number): string {
  const t = Math.max(0, Math.min(1, (snr + 21) / 21));
  const hue = Math.round(t * 130); // 0 red -> 130 green
  const light = Math.round(52 + t * 6); // 52% (red) -> 58% (green): readable across the range
  return `hsl(${hue}, 80%, ${light}%)`;
}

// Distance -> color: near is warm/orange, far is cool/blue (out to ~5000 km).
function distanceColor(km: number | null): string {
  if (km == null) return "var(--muted)";
  const t = Math.max(0, Math.min(1, km / 5000));
  return `hsl(${Math.round(35 + t * 185)}, 75%, 60%)`; // 35 (orange) -> 220 (blue)
}

// Points along the great-circle path between two coords.
function greatCircle(a: [number, number], b: [number, number], seg = 48): [number, number][] {
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const lat1 = rad(a[0]), lon1 = rad(a[1]), lat2 = rad(b[0]), lon2 = rad(b[1]);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
  ));
  if (!d) return [a, b];
  // The slerp below already traces the SHORTER arc (d is the minor angle). But
  // atan2 snaps each longitude back into [-180,180], so an arc over the dateline
  // jumps +179 -> -179 and Leaflet draws a flat line across the whole map. Unwrap
  // the longitudes into a continuous run so it renders the real short path.
  const pts: [number, number][] = [];
  let prevLon = NaN;
  for (let i = 0; i <= seg; i++) {
    const f = i / seg;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    let lon = deg(Math.atan2(y, x));
    if (!Number.isNaN(prevLon)) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([deg(Math.atan2(z, Math.hypot(x, y))), lon]);
  }
  return pts;
}

// Deterministic [0,1) hash of a string (FNV-1a, seeded) — stable per callsign so
// a station's jitter never shifts between the 3s re-renders.
function hash01(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// Spread same-grid stations so they don't stack on the square's center. The true
// position within the square is unknown, so a deterministic per-call offset
// (scaled to the grid's precision) is more honest than piling everyone on center.
function spread(call: string, lat: number, lon: number, grid: string | null): [number, number] {
  const g = grid?.toUpperCase() ?? "";
  const [mlat, mlon] = /^[A-R]{2}[0-9]{2}[A-X]{2}$/.test(g) ? [0.018, 0.036] // 6-char subsquare
    : /^[A-R]{2}[0-9]{2}$/.test(g) ? [0.34, 0.7] // 4-char square
    : [0.45, 0.6]; // gridless (section) — biggest spread
  return [lat + mlat * (2 * hash01(call, 1) - 1), lon + mlon * (2 * hash01(call, 2) - 1)];
}

// Our reception of a station is shown as an expanding "sonar" pulse colored by
// receive strength — NOT an arc back to us.
function ping(lat: number, lon: number, snr: number) {
  const color = snrColor(snr);
  const ring = L.circleMarker([lat, lon], { radius: 4, color, weight: 2, fill: false, opacity: 0.9 }).addTo(pingLayer);
  const start = performance.now();
  const dur = 1300;
  function frame(now: number) {
    const t = Math.min(1, (now - start) / dur);
    ring.setRadius(4 + t * 20);
    ring.setStyle({ opacity: 0.9 * (1 - t) });
    if (t < 1) requestAnimationFrame(frame);
    else pingLayer.removeLayer(ring);
  }
  requestAnimationFrame(frame);
}

// Node fill encodes OUR receive strength (how well *we* heard them). The rx
// (our own) node is gold; a node we've only seen as a QSO recipient is neutral
// until we decode it directly.
function upsertStation(call: string, lat: number, lon: number, opts: { isRx?: boolean; ourSnr?: number | null } = {}) {
  const color = opts.isRx ? "#ffd34f" : opts.ourSnr != null ? snrColor(opts.ourSnr) : "#3a6b8c";
  let s = stations.get(call);
  if (!s) {
    const marker = L.circleMarker([lat, lon], {
      radius: opts.isRx ? 8 : 6, color, weight: 1.5, fillColor: color, fillOpacity: 0.8,
    }).bindTooltip(mapLabel(call), { direction: "top" });
    marker.on("click", () => openStationHistory(call)); // click a node -> its history
    marker.addTo(stationLayer);
    stations.set(call, { marker, lastSeen: Date.now() });
    el("stationCount").textContent = String(stations.size);
  } else {
    s.marker.setLatLng([lat, lon]);
    s.lastSeen = Date.now();
    s.marker.setTooltipContent(mapLabel(call)); // FD class/section may have arrived since
    if (opts.isRx || opts.ourSnr != null) s.marker.setStyle({ color, fillColor: color });
  }
}

// Marker tooltip: the callsign, plus class + section for Field Day participants so
// the map reads their exchange at a glance (not just on hover).
function mapLabel(call: string): string {
  const i = stationInfo.get(call);
  if (!i?.fd) return call;
  const tag = [i.fdClass, i.section].filter(Boolean).join(" ");
  return tag ? `${call} · ${tag}` : call;
}

// --- Distribution of spots across the audio passband (the ~3 kHz window) ---
const FREQ_MAX = 3000, FREQ_BINS = 60, BIN_HZ = FREQ_MAX / FREQ_BINS;
const freqBins = new Array<number>(FREQ_BINS).fill(0);
let freqTotal = 0;
const freqCanvas = document.getElementById("freq") as HTMLCanvasElement;

function addFreq(df: number) {
  const b = Math.max(0, Math.min(FREQ_BINS - 1, Math.floor(df / BIN_HZ)));
  freqBins[b]++;
  freqTotal++;
  renderFreq();
}

// --- Band-activity rates (crowding) ---
interface RateRec { t: number; cycle: number | null; }
const rateBuf: RateRec[] = [];

function recordRate(tMs: number, cycle: number | null) {
  rateBuf.push({ t: tMs, cycle });
}

function renderRates() {
  const now = Date.now();
  while (rateBuf.length && rateBuf[0].t < now - 3_600_000) rateBuf.shift(); // keep last hour
  const inMin = rateBuf.filter((r) => r.t > now - 60_000);
  // spots/decode = avg spots per FT8 cycle over the last minute (cycle = decode time)
  const cyclesMin = new Set(inMin.filter((r) => r.cycle != null).map((r) => r.cycle)).size;
  el("rTotal").textContent = String(freqTotal);
  el("rDecode").textContent = cyclesMin ? (inMin.length / cyclesMin).toFixed(1) : "0";
  el("rMin").textContent = String(inMin.length);
  el("rHour").textContent = String(rateBuf.length);
}
setInterval(renderRates, 2000); // decay rolling windows even when idle

// Round count step so the Y axis lands on nice integers (1, 2, 5, 10, …).
function niceStep(max: number, target = 4): number {
  const raw = max / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return Math.max(1, step * pow);
}

const FREQ_PAD_L = 22; // left gutter for Y-axis count labels
let highlightDf: number | null = null; // a hovered station's audio offset, marked on the histogram

function renderFreq() {
  const ctx = freqCanvas?.getContext("2d");
  if (!ctx) return;
  const w = freqCanvas.width, h = freqCanvas.height, padT = 3;
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--accent").trim() || "#4fd1ff";
  const muted = cs.getPropertyValue("--muted").trim() || "#6b8aa3";
  const grid = cs.getPropertyValue("--grid").trim() || "rgba(95,168,211,0.15)";

  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...freqBins);
  const plotH = h - padT;
  const bw = (w - FREQ_PAD_L) / FREQ_BINS;
  const y = (v: number) => h - (v / max) * plotH;

  // Y axis: gridline + the actual spot count at each nice step.
  ctx.font = "9px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  const step = niceStep(max);
  for (let c = 0; c <= max + 1e-6; c += step) {
    const gy = Math.round(y(c)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(FREQ_PAD_L, gy); ctx.lineTo(w, gy); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(String(c), FREQ_PAD_L - 3, y(c));
  }

  // Bars.
  ctx.fillStyle = accent;
  for (let i = 0; i < FREQ_BINS; i++) {
    const bh = (freqBins[i] / max) * plotH;
    if (bh > 0) ctx.fillRect(FREQ_PAD_L + i * bw, h - bh, Math.max(1, bw - 1), bh);
  }

  // Marker for a hovered station's audio offset (where they sit in the band).
  if (highlightDf != null) {
    const x = FREQ_PAD_L + (Math.max(0, Math.min(FREQ_MAX, highlightDf)) / FREQ_MAX) * (w - FREQ_PAD_L);
    ctx.strokeStyle = "#ffd34f";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  const peak = document.getElementById("freqPeak");
  if (peak) peak.textContent = String(max);
}

function addSpot(spot: Spot) {
  spotCount++;
  noteStation(spot);
  if (spot.rxLat != null && spot.rxLon != null) ourLL = { lat: spot.rxLat, lon: spot.rxLon };
  if (spot.rxCall) ourCall = spot.rxCall;
  if (spot.toCall && spot.toCall === ourCall && spot.fromCall && spot.fromCall !== myQsoCall) {
    // Someone calling us (not our current partner). Track their "interest": +1 per
    // attempt this QSO, +1 per attempt this session (the latter persists).
    const prev = cqPileup.get(spot.fromCall);
    cqPileup.set(spot.fromCall, {
      snr: spot.snr, grid: spot.txGrid, lastSeen: Date.now(),
      qsoTries: qsoActive ? (prev?.qsoTries ?? 0) + 1 : 0,
      sessionTries: (prev?.sessionTries ?? 0) + 1,
    });
    if (qsoActive) renderPileup();
    else if (cqActive) cqCallCount = 0; // got a reply to our CQ — no longer calling into the void
  }
  // A station we tried but lost (incl. our lingering stolen partner) may be circling
  // back — check unconditionally, not just for non-partner callers.
  maybeComeback(spot);
  // Our DX just transmitted to someone other than us -> they're working someone else.
  if (qsoActive && spot.fromCall === myQsoCall && spot.toCall && spot.toCall !== ourCall) {
    dxStolen(spot.toCall);
  }
  // Our partner signed off to us -> QSO closing; prime the next-up handoff.
  if (qsoActive && spot.fromCall === myQsoCall && spot.toCall === ourCall && (spot.msgType === "rr73" || spot.msgType === "73")) {
    finishHandoff();
  }
  autoConsider(spot); // auto-hunt: maybe queue this CQ
  // Watch-next-CQ: the armed target just called CQ -> alert + pre-stage. Small
  // delay so a CQ already on screen at arm time doesn't trip it immediately.
  if (watchTarget && spot.fromCall === watchTarget && spot.msgType === "cq" && Date.now() - watchArmedAt > 1200) {
    fireWatch(watchTarget);
  }
  el("count").textContent = String(spotCount);
  if (spot.rxCall) el("rx").textContent = `${spot.rxCall}${spot.rxGrid ? " / " + spot.rxGrid : ""}`;
  if (spot.band) {
    el("dialNow").textContent = `${spot.mode} · ${(spot.dialFreq / 1e6).toFixed(3)} MHz`;
    setCurrentBandMode(spot.band, spot.mode); // decode confirms the band/mode
  }
  // HUD shows the two SNRs separately: our reception vs the embedded report.
  el("last").textContent =
    `rx ${spot.snr} dB${spot.reportDb != null ? `  ·  rprt ${spot.reportDb} dB` : ""}   ${spot.rawMessage}`;

  addFreq(spot.audioDf); // distribution across the audio passband
  recordRate(Date.now(), spot.decodeTimeMs);
  renderRates();

  // Same-grid stations stack on the square's center; spread them by a stable
  // per-call offset so they're individually visible/clickable. Use the SAME
  // jittered points for the node, its pulse, and the arc so everything lines up.
  const txPos = spot.fromCall && spot.txLat != null && spot.txLon != null
    ? spread(spot.fromCall, spot.txLat, spot.txLon, spot.txGrid) : null;
  const toPos = spot.toCall && spot.toLat != null && spot.toLon != null
    ? spread(spot.toCall, spot.toLat, spot.toLon, spot.toGrid) : null;

  // Don't pulse/arc anything filtered off the map (wrong band/mode, or non-FD in
  // Field Day mode) — their markers are hidden by applySectionFilter below.
  const fdShow = (call: string | null) =>
    (!huntEnabled || (!!call && isFieldDay(call))) && (!call || stationPassesBand(call));

  // Nodes: transmitter colored by OUR receive strength; recipient + us placed too.
  if (spot.fromCall && txPos) {
    upsertStation(spot.fromCall, txPos[0], txPos[1], { ourSnr: spot.snr });
    if (fdShow(spot.fromCall)) ping(txPos[0], txPos[1], spot.snr); // pulse = our reception of this station
  }
  if (spot.toCall && toPos) upsertStation(spot.toCall, toPos[0], toPos[1], {});
  if (spot.rxCall && spot.rxLat != null && spot.rxLon != null)
    upsertStation(spot.rxCall, spot.rxLat, spot.rxLon, { isRx: true }); // us: stay exact

  // Arc = the traffic BETWEEN the two QSO nodes (fromCall -> toCall), not back to
  // us. Colored by the embedded report (the inter-node link SNR) when present,
  // else a neutral link color. A wide invisible hit-line sits on top so the thin
  // arc is easy to click -> pin that pair's exchange.
  if (txPos && toPos && spot.fromCall && spot.toCall && fdShow(spot.fromCall) && fdShow(spot.toCall)) {
    const path = greatCircle([txPos[0], txPos[1]], [toPos[0], toPos[1]]);
    const color = spot.reportDb != null ? snrColor(spot.reportDb) : "#5fa8d3";
    const line = L.polyline(path, { color, weight: 1.6, opacity: 0.9 }).addTo(arcLayer);
    const hit = L.polyline(path, { color: "#000", weight: 10, opacity: 0 }).addTo(arcLayer);
    const from = spot.fromCall, to = spot.toCall;
    hit.on("click", (ev) => { L.DomEvent.stop(ev); activateExchangeForPair(from, to); });
    // Single shared canvas: hit-test picks the topmost (last-drawn) layer, so push
    // arcs to the back — a station pin always wins a click where they overlap.
    line.bringToBack(); hit.bringToBack();
    arcs.push({ line, hit, created: Date.now() });
  }

  if (huntEnabled || bandFilterOn) applySectionFilter(); // keep new stations within the active filters
}

// Fade + reap arcs.
setInterval(() => {
  const now = Date.now();
  for (let i = arcs.length - 1; i >= 0; i--) {
    const age = now - arcs[i].created;
    if (age > ARC_TTL) {
      arcLayer.removeLayer(arcs[i].line);
      arcLayer.removeLayer(arcs[i].hit);
      arcs.splice(i, 1);
    } else arcs[i].line.setStyle({ opacity: 0.9 * (1 - age / ARC_TTL) });
  }
}, 500);

// --- Map focus: isolate a set of stations (dim the rest), with role labels. ---
let focusActive = false;
// Style for a non-focused station while a focus is active: faintly dimmed —
// unless FD mode would hide it anyway, in which case keep it fully hidden so
// focusing never resurrects filtered-out (non-FD) nodes.
function dimStyle(call: string): L.PathOptions {
  if (call !== ourCall && !stationPassesBand(call)) return { opacity: 0, fillOpacity: 0 };
  if (huntEnabled && call !== ourCall && !isFieldDay(call)) return { opacity: 0, fillOpacity: 0 };
  return { opacity: 0.12, fillOpacity: 0.05 };
}
function focusCalls(targets: { call: string; role: string; color: string }[]) {
  clearFocus();
  focusActive = true;
  if (map.hasLayer(arcLayer)) map.removeLayer(arcLayer);
  if (map.hasLayer(pingLayer)) map.removeLayer(pingLayer);
  const keep = new Set(targets.map((t) => t.call));
  stations.forEach((s, call) =>
    s.marker.setStyle(keep.has(call) ? { opacity: 1, fillOpacity: 1 } : dimStyle(call)));
  for (const t of targets) {
    const s = stations.get(t.call);
    if (!s) continue;
    const ll = s.marker.getLatLng();
    L.circleMarker(ll, { radius: 11, color: t.color, weight: 2.5, fill: false, opacity: 0.95 }).addTo(focusLayer);
    L.tooltip({ permanent: true, direction: "top", offset: [0, -10], className: "focus-label" })
      .setLatLng(ll).setContent(`${t.call} · ${t.role}`).addTo(focusLayer);
  }
}
function clearFocus() {
  if (!focusActive) return;
  focusActive = false;
  focusLayer.clearLayers();
  if (!map.hasLayer(arcLayer)) map.addLayer(arcLayer);
  if (!map.hasLayer(pingLayer)) map.addLayer(pingLayer);
  applySectionFilter(); // restore per-section visibility (not a blanket reset)
}

// Mirror the hovered station as a highlight in WSJT-X's Band Activity window.
// Keeps a single active highlight; fire-and-forget (no toast — hover is frequent).
let wsjtxHL: string | null = null;
const postHighlight = (call: string, on: boolean) =>
  fetch("/api/highlight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call, on }) }).catch(() => {});
function wsjtxHighlight(call: string | null) {
  if (call === wsjtxHL) return;
  if (wsjtxHL) postHighlight(wsjtxHL, false);
  wsjtxHL = call;
  if (call) postHighlight(call, true);
}

// --- Per-station knowledge from the spot stream, for hover info cards ---
interface SInfo {
  spots: number; lastSnr: number; minSnr: number; maxSnr: number; sumSnr: number;
  grid: string | null; section: string | null; fdClass: string | null; located: boolean;
  fd: boolean; // sticky: has this station ever *advertised* Field Day?
  lastDf: number; band: string | null; mode: string | null; lastSeen: number;
}
const stationInfo = new Map<string, SInfo>();
function noteStation(spot: Spot) {
  if (!spot.fromCall) return;
  let i = stationInfo.get(spot.fromCall);
  if (!i) {
    i = { spots: 0, lastSnr: spot.snr, minSnr: 99, maxSnr: -99, sumSnr: 0, grid: null, section: null, fdClass: null, located: false, fd: false, lastDf: spot.audioDf, band: spot.band, mode: spot.mode, lastSeen: 0 };
    stationInfo.set(spot.fromCall, i);
  }
  i.spots++;
  i.lastSnr = spot.snr; i.sumSnr += spot.snr;
  i.minSnr = Math.min(i.minSnr, spot.snr); i.maxSnr = Math.max(i.maxSnr, spot.snr);
  i.lastDf = spot.audioDf; i.band = spot.band; i.mode = spot.mode; i.lastSeen = Date.parse(spot.receivedAt);
  if (spot.txGrid) i.grid = spot.txGrid;
  if (spot.section) i.section = spot.section;
  if (spot.fdClass) i.fdClass = spot.fdClass;
  // Advertised Field Day: CQ FD, or a parsed class token (every real FD exchange
  // carries class+section together, so fdClass catches the exchange too). NOT
  // msgType "exchange" — the parser's catch-all tags any unrecognized directed
  // message that way, which would misclassify ordinary traffic as Field Day.
  if (spot.cqModifier === "FD" || spot.fdClass) i.fd = true;
  if (spot.txLat != null) i.located = true;
}

const card = document.getElementById("card") as HTMLDivElement;
const hAge = (t: number) => { const s = (Date.now() - t) / 1000; return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
// Relative age label + freshness color (green = now, red = stale ~2 min).
const relLabel = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 1 ? "now" : s < 60 ? `-${Math.round(s)}s` : s < 3600 ? `-${Math.round(s / 60)}m` : `-${Math.round(s / 3600)}h`; };
const freshColor = (iso: string) => { const t = Math.max(0, Math.min(1, ((Date.now() - Date.parse(iso)) / 1000) / 120)); return `hsl(${Math.round(120 * (1 - t))}, 70%, 50%)`; };

function showCard(call: string, x: number, y: number) {
  const i = stationInfo.get(call);
  let body: string;
  if (!i || i.spots === 0) {
    // We never decoded this station ourselves — only heard others call them.
    body = `<div class="card-none">not directly copied — we've only seen others call them.</div>
      <div class="card-unknown">⚠ location unknown — no grid heard</div>`;
  } else {
    const avg = Math.round(i.sumSnr / i.spots);
    body = `<div class="card-row"><span>rx snr</span><b style="color:${snrColor(i.lastSnr)}">${i.lastSnr} dB</b></div>`
      + `<div class="card-row"><span>range</span><b>${i.minSnr}…${i.maxSnr} (avg ${avg})</b></div>`
      + `<div class="card-row"><span>spots</span><b>${i.spots}</b></div>`
      + `<div class="card-row"><span>audio</span><b>${i.lastDf} Hz</b></div>`
      + `<div class="card-row"><span>band</span><b>${i.band ?? "?"}</b></div>`
      + `<div class="card-row"><span>heard</span><b>${hAge(i.lastSeen)} ago</b></div>`
      + (i.located
        ? `<div class="card-row"><span>grid</span><b>${i.grid ?? i.section}</b></div>`
        : `<div class="card-unknown">⚠ location unknown — no grid copied for this call</div>`);
  }
  card.innerHTML = `<div class="card-call">${call}</div>${body}`;
  card.hidden = false;
  card.style.left = `${Math.min(x + 14, window.innerWidth - 252)}px`;
  card.style.top = `${Math.min(y + 14, window.innerHeight - (card.offsetHeight || 150) - 8)}px`;
}
function hideCard() { card.hidden = true; }
function bandHighlight(df: number | null) { highlightDf = df; renderFreq(); }

// A highlight ring + role label on a station node.
function ring(call: string, color: string, role: string, radius = 11, weight = 2.5) {
  const s = stations.get(call);
  if (!s) return;
  const ll = s.marker.getLatLng();
  L.circleMarker(ll, { radius, color, weight, fill: false, opacity: 0.95 }).addTo(focusLayer);
  L.tooltip({ permanent: true, direction: "top", offset: [0, -radius], className: "focus-label" })
    .setLatLng(ll).setContent(`${call} · ${role}`).addTo(focusLayer);
}

// --- Live exchanges: active QSOs between other stations, polled from backend ---
interface Exchange {
  cqer: string; responder: string; cqerClass: string | null; responderClass: string | null;
  cqerSection: string | null; responderSection: string | null;
  role: string; protocol: "ft8" | "fieldday"; steps: string[];
  stage: string; stageRank: number; seenSteps: boolean[]; msgCount: number;
  cqerHeardResponder: number | null; responderHeardCqer: number | null;
  retransmissions: number; contenders: number; contenderCalls: string[];
  halfCopy: boolean; lastSeen: string; band: string | null; mode: string | null;
  log: { t: string; from: string; to: string; msg: string; snr: number; type: string }[];
}
let currentExchanges: Exchange[] = [];

// Role visual language for an exchange — one source of truth so the list, the map
// rings, and the detail panel all agree on who's who. Each role gets a distinct
// color + icon. "calling" (contenders still trying) is NEUTRAL grey, not a warning
// color: they're just waiting, nothing's wrong. (.chip-cq / .pileup in CSS mirror
// these for backgrounds the inline styles can't reach.)
const EX_ROLE = {
  cq:      { color: "#5fa8d3", icon: "📣", label: "CQ" },                 // the caller / host (steel blue, from chip-exch)
  worked:  { color: "#34d399", icon: "🤝", label: "worked" },             // the chosen replier (winner)
  calling: { color: "#94a3b8", icon: "⏳", label: "calling — no reply" }, // contenders, neutral
} as const;

// QSO progress bar. One segment per protocol step (6 for FT8, 4 for Field Day);
// steps we copied are filled, steps within the progressed range that we MISSED
// are holes, later steps are empty. The step labels are the segment tooltips.
function progressBar(seen: boolean[], rank: number, steps: string[]): string {
  let holes = 0;
  const cells = steps.map((label, i) => {
    if (seen?.[i]) return `<i class="on" title="${label} · copied"></i>`;
    if (i < rank) { holes++; return `<i class="hole" title="${label} · missed"></i>`; }
    return `<i title="${label}"></i>`;
  }).join("");
  const got = seen?.filter(Boolean).length ?? 0;
  return `<span class="exprog" title="copied ${got}/${steps.length} · ${holes} hole${holes === 1 ? "" : "s"}">${cells}</span>`;
}
// dB value colored by the SNR scale.
const snrCell = (v: number | null) => (v != null ? `<b style="color:${snrColor(v)}">${v} dB</b>` : "<b>—</b>");

// Field Day class badge (e.g. "2D") with a decoded tooltip.
function fdBadge(cls: string | null): string {
  const d = decodeFdClass(cls);
  return d ? ` <span class="fdcls" title="${d.transmitters} tx · ${d.meaning}">${d.raw}</span>` : "";
}
// Class + ARRL section tags for a Field Day station — the at-a-glance exchange.
function fdTag(cls: string | null, section: string | null): string {
  const sec = section ? ` <span class="fdsec" title="ARRL section ${section}">${section}</span>` : "";
  return fdBadge(cls) + sec;
}

async function refreshExchanges() {
  try {
    const all: Exchange[] = await fetch("/api/exchanges").then((r) => r.json());
    const ex = all
      .filter((e) => !bandFilterOn || ((!curBand || !e.band || e.band === curBand) && (!curMode || !e.mode || e.mode === curMode)))
      .filter((e) => !huntEnabled || e.protocol === "fieldday");
    currentExchanges = ex;
    el("exCount").textContent = String(ex.length);
    const list = el("exList");
    if (!ex.length) { list.className = "ex-empty"; list.textContent = huntEnabled ? "no Field Day exchanges" : "no active exchanges"; return; }
    list.className = pinnedKey ? "pinned" : "";
    list.innerHTML = ex.map((e) => {
      const pileup = e.contenders > 1 ? `<span class="pileup">${EX_ROLE.calling.icon} ${e.contenders} calling</span>` : "";
      const flags = `${e.halfCopy ? '<span class="half">½ copy</span>' : ""}${e.retransmissions ? `<span class="retx">↻ ${e.retransmissions}</span>` : ""}`;
      const selected = `${e.cqer}|${e.responder}` === pinnedKey;
      const party = (call: string, r: typeof EX_ROLE.cq) =>
        `<span class="ex-party-call" style="color:${r.color}" title="${r.label}"><span class="ex-ic">${r.icon}</span><b data-call="${call}">${call}</b></span>`;
      return `<div class="exrow${selected ? " selected" : ""}" data-cqer="${e.cqer}" data-resp="${e.responder}" data-cont="${e.contenderCalls.join(" ")}">
        <div class="exrow-top"><span class="ex-pair">${party(e.cqer, EX_ROLE.cq)}${fdTag(e.cqerClass, e.cqerSection)}<button class="watch-mini ${watchTarget === e.cqer ? "on" : ""}" data-watch="${e.cqer}" title="watch ${e.cqer} — alert on its next CQ">👁</button><span class="swap">⇄</span>${party(e.responder, EX_ROLE.worked)}${fdTag(e.responderClass, e.responderSection)}</span>${pileup}</div>
        <div class="exrow-stage">${e.protocol === "fieldday" ? '<span class="exproto" title="Field Day exchange (class + section)">FD</span>' : ""}${progressBar(e.seenSteps, e.stageRank, e.steps)}<span class="exstage">${e.stage}</span>${flags}</div>
        <div class="exrow-snr">
          <span>${e.cqer} hears ${e.responder}: ${snrCell(e.cqerHeardResponder)}</span>
          <span>${e.responder} hears ${e.cqer}: ${snrCell(e.responderHeardCqer)}</span>
        </div>
      </div>`;
    }).join("");
    if (pinnedKey) {
      const pinned = currentExchanges.find((x) => `${x.cqer}|${x.responder}` === pinnedKey);
      if (pinned) showExchangeDetail(pinned); // keep the pinned detail live
    }
  } catch { /* ignore */ }
}
setInterval(refreshExchanges, 3000);

// Hover an exchange -> isolate it on the map: a great-circle SNR path between
// the two QSO stations, dashed "still calling" paths for the pileup, the winner
// emphasized, plus the per-station info card + band-activity marker.
function focusExchange(e: Exchange) {
  clearFocus();
  focusActive = true;
  if (map.hasLayer(arcLayer)) map.removeLayer(arcLayer);
  if (map.hasLayer(pingLayer)) map.removeLayer(pingLayer);
  const contenders = e.contenderCalls.filter((c) => c !== e.responder && c !== e.cqer);
  const keep = new Set([e.cqer, e.responder, ...contenders]);
  stations.forEach((s, call) => s.marker.setStyle(keep.has(call) ? { opacity: 1, fillOpacity: 1 } : dimStyle(call)));

  const at = (call: string) => stations.get(call)?.marker.getLatLng() ?? null;
  const cqLL = at(e.cqer), rLL = at(e.responder);

  // Winner link: solid great-circle, colored by the embedded SNR if we have it.
  if (cqLL && rLL) {
    const snr = e.cqerHeardResponder ?? e.responderHeardCqer;
    L.polyline(greatCircle([cqLL.lat, cqLL.lng], [rLL.lat, rLL.lng]),
      { color: snr != null ? snrColor(snr) : EX_ROLE.worked.color, weight: 3, opacity: 0.95 }).addTo(focusLayer);
  }
  // Still-trying: dashed paths from each contender to the CQer (no reply yet). The
  // DASH says "calling, unanswered". Drawn as a dark casing + a bold bright-blue
  // line on top so the traces read over any basemap — thin/faint lines vanish.
  for (const c of contenders) {
    const cLL = at(c);
    if (cLL && cqLL) {
      const arc = greatCircle([cLL.lat, cLL.lng], [cqLL.lat, cqLL.lng]);
      L.polyline(arc, { color: "#04111d", weight: 5, opacity: 0.6 }).addTo(focusLayer); // casing/halo
      L.polyline(arc, { color: "#4fd1ff", weight: 2.5, opacity: 1, dashArray: "9 6" }).addTo(focusLayer);
    }
  }
  ring(e.cqer, EX_ROLE.cq.color, `${EX_ROLE.cq.icon} CQ`);
  ring(e.responder, EX_ROLE.worked.color, `${EX_ROLE.worked.icon} worked`, 13, 3.5); // the winner, emphasized
  for (const c of contenders) ring(c, EX_ROLE.calling.color, `${EX_ROLE.calling.icon} ${EX_ROLE.calling.label}`);
}

// --- Pinned exchange detail view (opened by click) ---
let pinnedKey: string | null = null;
let prevView: { center: L.LatLng; zoom: number } | null = null; // map view to restore on close
const exdetail = document.getElementById("exdetail") as HTMLDivElement;

// One uniform card per party — located or not — dumping everything we know.
function partyCard(call: string, role: string, roleColor: string, cls: string | null, section: string | null = null): string {
  const i = stationInfo.get(call);
  const located = !!i?.located;
  const loc = located ? (i!.grid ?? i!.section ?? "?") : `<span class="exd-noloc-tag">⚠ no grid copied</span>`;
  const fd = decodeFdClass(cls);
  const snr = i && i.spots > 0 ? `${i.lastSnr} dB (${i.minSnr}…${i.maxSnr})` : "not directly copied";
  const grid = i?.grid ?? "";
  return `<div class="exd-party ${located ? "" : "exd-noloc"}">
    <div class="exd-party-top"><b class="exd-party-name" data-station="${call}" style="color:${roleColor}" title="open ${call}'s station view">${call}</b><span class="exd-party-actions">${role ? `<span class="exd-role">${role}</span>` : ""}<button class="watch-btn ${watchTarget === call ? "on" : ""}" data-watch="${call}" title="watch ${call} — alert + pre-stage a reply when they next call CQ">👁 watch</button><button class="queue-btn" data-queue="${call}" data-grid="${grid}" title="queue ${call} in WSJT-X — sets up the call; then press Enable Tx">📻 queue</button></span></div>
    <div class="exd-party-row"><span>location</span><b>${loc}</b></div>
    ${fd ? `<div class="exd-party-row"><span>class</span><b title="${fd.meaning}">${fd.raw} · ${fd.transmitters}tx</b></div>` : ""}
    ${section ? `<div class="exd-party-row"><span>section</span><b>${section}</b></div>` : ""}
    <div class="exd-party-row"><span>rx snr</span><b>${snr}</b></div>
    <div class="exd-party-row"><span>spots</span><b>${i?.spots ?? 0}</b></div>
  </div>`;
}

function showExchangeDetail(e: Exchange) {
  el("exdTitle").textContent = `${e.cqer} ⇄ ${e.responder}`;
  const holes = e.seenSteps.filter((s, i) => !s && i < e.stageRank).length;
  const contenders = e.contenderCalls.filter((c) => c !== e.responder && c !== e.cqer);
  el("exdBody").innerHTML = `
    <div class="exd-stage">${e.protocol === "fieldday" ? '<span class="exproto" title="Field Day exchange (class + section)">FD</span>' : ""}${progressBar(e.seenSteps, e.stageRank, e.steps)}<b>${e.stage}</b></div>
    <div class="exd-snr">${e.msgCount} msgs · ${holes} hole${holes === 1 ? "" : "s"}${e.halfCopy ? " · ½ copy" : ""}${e.retransmissions ? ` · ↻ ${e.retransmissions} retx` : ""}${e.band ? ` · ${e.band}` : ""}</div>
    <div class="exd-snr">
      <div>${e.cqer} hears ${e.responder}: ${snrCell(e.cqerHeardResponder)}</div>
      <div>${e.responder} hears ${e.cqer}: ${snrCell(e.responderHeardCqer)}</div>
    </div>
    ${partyCard(e.cqer, `${EX_ROLE.cq.icon} ${e.role === "cq" ? "CQ" : "called"}`, EX_ROLE.cq.color, e.cqerClass, e.cqerSection)}
    ${partyCard(e.responder, `${EX_ROLE.worked.icon} worked`, EX_ROLE.worked.color, e.responderClass, e.responderSection)}
    ${contenders.length ? `<div class="exd-sub">still calling — no reply (${contenders.length})</div>${contenders.map((c) => partyCard(c, `${EX_ROLE.calling.icon} calling`, EX_ROLE.calling.color, null)).join("")}` : ""}
    <div class="exd-sub">event log · our copy</div>
    <div class="exd-log">${e.log.map((l) => {
      const time = new Date(l.t).toLocaleTimeString([], { hour12: false });
      return `<div class="exd-log-row"><span class="exd-log-t">${time}</span><span class="exd-log-rel" style="color:${freshColor(l.t)}">${relLabel(l.t)}</span><b class="exd-log-snr" style="color:${snrColor(l.snr)}">${l.snr}</b><span class="exd-log-msg">${l.msg}</span></div>`;
    }).join("")}</div>
  `;
  exdetail.hidden = false;
}

function closeDetail() {
  pinnedKey = null;
  markExSelected(null);
  exdetail.hidden = true;
  clearFocus();
  if (prevView) { map.flyTo(prevView.center, prevView.zoom, { duration: 0.6 }); prevView = null; }
}
function refocusPinned() {
  const e = pinnedKey ? currentExchanges.find((x) => `${x.cqer}|${x.responder}` === pinnedKey) : null;
  if (e) focusExchange(e); else clearFocus();
}
document.getElementById("exdClose")?.addEventListener("click", closeDetail);

// --- Station history (click a node) ---
const stnhist = document.getElementById("stnhist") as HTMLDivElement;
function hideExchangeDetail() { pinnedKey = null; markExSelected(null); exdetail.hidden = true; prevView = null; clearFocus(); }
function closeStationHistory() { stnhist.hidden = true; clearSelection(); }

// Map cue for the selected station (its details widget is open): a loud one-shot
// burst the moment it's selected, plus a persistent outline while it stays open.
let selectedCall: string | null = null;
function selectStation(call: string) {
  clearSelection();
  selectedCall = call;
  const s = stations.get(call);
  if (!s) return; // off the map (e.g. found via search but never copied) — dialog still shows
  const ll = s.marker.getLatLng();
  const icon = (cls: string) => L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  L.marker(ll, { icon: icon("sel-outline"), interactive: false, zIndexOffset: 1100 }).addTo(selectLayer); // persistent
  L.marker(ll, { icon: icon("sel-burst"), interactive: false, zIndexOffset: 1100 }).addTo(selectLayer); // transient
}
function clearSelection() { selectedCall = null; selectLayer.clearLayers(); }
interface HistGroup { partner: string; count: number; first: number; last: number; saw: number[]; rep: number[] }

function showStationHistory(call: string, history: Spot[]) {
  el("stnTitle").textContent = call;
  const i = stationInfo.get(call);

  // Collapse by who they were working: count, time span, avg SNR (ours + reported).
  const groups = new Map<string, HistGroup>();
  for (const s of history) {
    const partner = s.fromCall === call ? (s.toCall ?? "CQ") : (s.fromCall ?? "?");
    let g = groups.get(partner);
    const t = Date.parse(s.receivedAt);
    if (!g) { g = { partner, count: 0, first: t, last: t, saw: [], rep: [] }; groups.set(partner, g); }
    g.count++;
    g.first = Math.min(g.first, t);
    g.last = Math.max(g.last, t);
    if (s.fromCall === call) g.saw.push(s.snr); // our copy of THIS station
    if (s.reportDb != null) g.rep.push(s.reportDb); // SNR exchanged in the messages
  }
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const cell = (v: number | null) => (v != null ? `<b style="color:${snrColor(v)}">${v}</b>` : "—");
  const rows = [...groups.values()].sort((a, b) => b.count - a.count || b.last - a.last).map((g) => {
    const spanMin = Math.round((g.last - g.first) / 60000);
    const span = g.count < 2 ? "once" : spanMin >= 1 ? `over ${spanMin}m` : "rapid";
    return `<div class="stn-grp">
      <div class="stn-grp-top"><b>${g.partner}</b><span class="stn-grp-cnt">×${g.count}</span><span class="stn-grp-when">${relLabel(new Date(g.last).toISOString())}</span></div>
      <div class="stn-grp-meta">saw ${cell(avg(g.saw))} · rprt ${cell(avg(g.rep))} · ${span}</div>
    </div>`;
  }).join("");
  // The station's own exchange card pinned at the top (with the queue action),
  // then the scrollable "talking to" history below.
  el("stnBody").innerHTML =
    partyCard(call, "", "var(--accent)", i?.fdClass ?? null, i?.section ?? null)
    + `<div class="exd-sub">talking to · ${groups.size} (${history.length} msgs)</div>`
    + `<div class="stn-talking">${rows}</div>`;
  stnhist.hidden = false;
}
async function openStationHistory(call: string) {
  hideExchangeDetail();
  const s = stations.get(call);
  if (s) map.panTo(s.marker.getLatLng(), { animate: true, duration: 0.5 });
  selectStation(call); // loud one-shot + persistent outline on the map
  try {
    const history: Spot[] = await fetch(`/api/station?call=${encodeURIComponent(call)}`).then((r) => r.json());
    showStationHistory(call, history);
  } catch { /* ignore */ }
}

// --- Quick station finder: type a callsign, jump to its dialog (+ map node) ---
const stationSearch = document.getElementById("stationSearch") as HTMLInputElement;
const stationOptions = document.getElementById("stationOptions") as HTMLDataListElement;
function refreshStationOptions() {
  const calls = [...new Set([...stations.keys(), ...stationInfo.keys()])].sort();
  stationOptions.innerHTML = calls.map((c) => `<option value="${c}"></option>`).join("");
}
let lastFind = "";
function findStation() {
  const call = stationSearch.value.trim().toUpperCase();
  if (!call || call === lastFind) return; // dedupe Enter + change firing together
  lastFind = call;
  setTimeout(() => { lastFind = ""; }, 800);
  openStationHistory(call);
  if (!stations.has(call) && !stationInfo.has(call)) toast(`${call} — not heard this session`, false);
}
stationSearch.addEventListener("focus", refreshStationOptions);
stationSearch.addEventListener("change", findStation); // picking a suggestion
stationSearch.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { findStation(); stationSearch.blur(); }
});
document.getElementById("stnClose")?.addEventListener("click", closeStationHistory);

// Easy dismiss: click the map background or press Esc to drop any open panel.
map.on("click", () => {
  if (pinnedKey || !exdetail.hidden) closeDetail();
  if (!stnhist.hidden) closeStationHistory();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (pinnedKey || !exdetail.hidden) closeDetail();
  if (!stnhist.hidden) closeStationHistory();
});

let lastExHover = "";
const exListEl = el("exList");
// Reflect the selected exchange in the list at once, without waiting for the
// next 3s rebuild (which also applies these classes inline).
function markExSelected(key: string | null) {
  exListEl.classList.toggle("pinned", !!key);
  exListEl.querySelectorAll(".exrow.selected").forEach((r) => r.classList.remove("selected"));
  if (!key) return;
  for (const r of Array.from(exListEl.querySelectorAll(".exrow")) as HTMLElement[]) {
    if (`${r.dataset.cqer}|${r.dataset.resp}` === key) { r.classList.add("selected"); break; }
  }
}
const placeCard = (ev: MouseEvent) => {
  const callEl = (ev.target as HTMLElement).closest("[data-call]") as HTMLElement | null;
  if (callEl?.dataset.call) {
    showCard(callEl.dataset.call, ev.clientX, ev.clientY);
    bandHighlight(stationInfo.get(callEl.dataset.call)?.lastDf ?? null);
    wsjtxHighlight(callEl.dataset.call);
  } else { hideCard(); bandHighlight(null); wsjtxHighlight(null); }
};
exListEl.addEventListener("mouseover", (ev) => {
  if (pinnedKey) return; // a selected exchange owns the view; hover/preview is off
  const row = (ev.target as HTMLElement).closest(".exrow") as HTMLElement | null;
  if (row) {
    const key = `${row.dataset.cqer}|${row.dataset.resp}`;
    if (key !== lastExHover) {
      lastExHover = key;
      const e = currentExchanges.find((x) => x.cqer === row.dataset.cqer && x.responder === row.dataset.resp);
      if (e) focusExchange(e);
    }
  }
  placeCard(ev as MouseEvent);
});
exListEl.addEventListener("mousemove", (ev) => { if (!pinnedKey) placeCard(ev as MouseEvent); });
exListEl.addEventListener("mouseleave", () => { lastExHover = ""; refocusPinned(); hideCard(); bandHighlight(null); wsjtxHighlight(null); });

// Pin an exchange: selected cue + detail panel + frame all parties on the map.
// Shared by the list-row click and the map-arc click.
function pinExchange(e: Exchange) {
  const key = `${e.cqer}|${e.responder}`;
  if (pinnedKey === key) { closeDetail(); return; } // toggle: click the pinned one again to exit
  if (!pinnedKey) prevView = { center: map.getCenter(), zoom: map.getZoom() }; // remember where to return
  pinnedKey = key;
  markExSelected(key);
  focusExchange(e);
  showExchangeDetail(e);
  // Frame EVERY located party — both QSO ends and the pileup callers — so a
  // cross-continent pileup isn't lost when, e.g., the winner sent only a report
  // (no grid): the located US callers must still pull the view out to fit them.
  const pts = [e.cqer, e.responder, ...e.contenderCalls]
    .map((c) => stations.get(c)?.marker.getLatLng())
    .filter((p): p is L.LatLng => !!p);
  if (pts.length >= 2) {
    map.flyToBounds(L.latLngBounds(pts).pad(0.25), { duration: 0.8, maxZoom: 9 });
  } else if (pts.length === 1) {
    // only one node located -> keep current zoom, just pan to it
    map.panTo(pts[0], { animate: true, duration: 0.8 });
  } // none located -> leave the view untouched
}

// Click a map arc -> pin the live exchange for that from/to pair (the winner link
// if it's the chosen pair, else a contender calling the cqer). No-op if the pair
// isn't part of a current exchange (e.g. an aged-out arc).
function activateExchangeForPair(a: string, b: string) {
  const pair = (e: Exchange) => (e.cqer === a && e.responder === b) || (e.cqer === b && e.responder === a);
  const contender = (e: Exchange) =>
    (e.cqer === a && e.contenderCalls.includes(b)) || (e.cqer === b && e.contenderCalls.includes(a));
  const e = currentExchanges.find(pair) ?? currentExchanges.find(contender);
  if (e) pinExchange(e);
}

// Click an exchange row -> pin it.
exListEl.addEventListener("click", (ev) => {
  const row = (ev.target as HTMLElement).closest(".exrow") as HTMLElement | null;
  if (!row) return;
  const e = currentExchanges.find((x) => x.cqer === row.dataset.cqer && x.responder === row.dataset.resp);
  if (e) pinExchange(e);
});

// --- CQ callers: stations calling CQ, gone once they engage. Sort age/dist/snr. ---
interface CqCaller {
  call: string; snr: number; distanceKm: number | null; grid: string | null;
  section: string | null; fdClass: string | null; fd: boolean; band: string | null; mode: string | null; lastSeen: string; cqCount: number;
  qsosLastHour: number; activeness: number; workedAt: number | null;
}
let cqCallers: CqCaller[] = [];
let cqSort: "age" | "active" | "dist" | "snr" = "active";
let cqWorkedWindowSec = 86400; // hide stations worked within this many seconds (0 = show all); default 24h
const workedAt = new Map<string, number>(); // call -> ms we last logged a QSO (DB + live WS)

// Short "ding" via Web Audio (created on a user gesture so autoplay allows it).
// Our live operating state from WSJT-X — drives the in-QSO indicator, the OUR-QSO
// heads-up panel, and the auto-hunt gate.
interface MyState { transmitting: boolean; txEnabled: boolean; dxCall: string | null; dxGrid: string | null; txMessage: string | null; band: string | null; mode: string | null }
let myState: MyState = { transmitting: false, txEnabled: false, dxCall: null, dxGrid: null, txMessage: null, band: null, mode: null };
let ourLL: { lat: number; lon: number } | null = null; // our station, from spot rx coords
let ourCall: string | null = null;
// Sticky QSO session: once engaged we stay until completion / abort / timeout,
// NOT toggling with each transmit period (WSJT-X may report Tx-enabled false on RX).
let qsoActive = false;
let myQsoCall: string | null = null;
let myQsoGrid: string | null = null;
let framedWithDx: string | null = null;
let dismissedDx: string | null = null; // just-finished call — suppress re-pop until its Tx tail ends
let preQsoView: { center: L.LatLng; zoom: number } | null = null;
let lastTransmitting = false;
let reachOutMsg: string | null = null; // the message we keep sending
let reachOutCount = 0; // how many times we've sent it (no reply yet)
let dxStolenBy: string | null = null; // our DX started working someone else
const myQsoLayer = L.layerGroup().addTo(map);

// Calling-CQ state + the pileup answering US (decodes with to_call = our call).
let cqActive = false;
let cqLastEngagedAt = 0;
let cqAuto = false;              // auto-reply to the strongest answerer
let cqAutoCooldownUntil = 0;     // don't auto-fire more than once per ~cycle
let cqCallCount = 0;             // CQ transmissions in this session with no reply yet
let cqLastTx = false;            // were we transmitting a CQ on the previous status?
let cqSuppressUntil = 0;         // after a manual cancel, don't re-open until Tx is really off
interface PileEntry { snr: number; grid: string | null; lastSeen: number; qsoTries: number; sessionTries: number }
const cqPileup = new Map<string, PileEntry>();
let nextUp: string | null = null;     // who we've queued to work after this QSO
let handoffDone = false;              // fired the handoff for the current QSO (debounce)
const PILE_TTL = 150_000;             // drop pileup callers we haven't heard in this long
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function setMyState(s: MyState) {
  const prevDx = myState.dxCall;
  myState = s;
  // WSJT-X has no "double-click" event, but double-clicking a decode sets the DX
  // Call, which rides in on Status. When it changes to a new station, surface that
  // station's detailed viewer (covers both an op double-click and our own /api/dx).
  setCurrentBandMode(s.band, s.mode); // band/mode switch arrives here as an event, before any decode
  // CQ is determined by the Tx message alone — WSJT-X often keeps a stale DX Call
  // set while you call CQ, which must NOT make us look like we're working someone.
  const isCq = /^CQ\b/i.test((s.txMessage ?? "").trim());
  if (s.dxCall && s.dxCall !== prevDx && !isCq) openStationHistory(s.dxCall);
  const tx = document.getElementById("txstate");
  if (tx) {
    if (s.transmitting) { tx.textContent = isCq ? "🔴 TX · CQ" : `🔴 TX${s.dxCall ? " → " + s.dxCall : ""}`; tx.className = "hud-tx tx-on"; tx.hidden = false; }
    else if (s.txEnabled) { tx.textContent = isCq ? "📣 calling CQ" : `🟠 in QSO${s.dxCall ? " → " + s.dxCall : ""}${autoHunt ? " · auto paused" : ""}`; tx.className = isCq ? "hud-tx tx-cq" : "hud-tx tx-enabled"; tx.hidden = false; }
    else tx.hidden = true;
  }
  updateMyQso(s); // QSO takes precedence when there's a DX call
  updateCqCall(s);
}

function exitCqCall() { cqActive = false; el("cqcall").hidden = true; }

function renderCqCall() {
  el("cqcallTitle").textContent = `📣 Calling CQ${myState.transmitting ? " · TX" : ""}`;
  const now = Date.now();
  const answerers = [...cqPileup.entries()]
    .filter(([, v]) => now - v.lastSeen < 50_000)
    .sort((a, b) => b[1].snr - a[1].snr); // strongest first (drives auto-reply too)
  el("cqcallSub").textContent = answerers.length
    ? `${answerers.length} answering — click to reply`
    : `no answers yet — called ×${cqCallCount}`;
  el("cqcallList").innerHTML = answerers.map(([call, v]) => {
    const info = stationInfo.get(call);
    const dxLL = gridToLatLon(v.grid);
    const km = dxLL && ourLL ? `${Math.round(haversineKm(ourLL, dxLL)).toLocaleString()}km` : (v.grid ?? "");
    const sec = info?.section ? ` · ${info.section}` : "";
    const worked = workedAt.has(call);
    return `<div class="cqans${worked ? " dupe" : ""}" data-call="${call}" data-grid="${v.grid ?? ""}" title="${call} · ${v.sessionTries}× call${v.sessionTries === 1 ? "" : "s"}${worked ? " · ⚠ already worked (dupe)" : ""} — click to reply">
      <b>${call}</b>${worked ? `<span class="pile-dupe">✓ dupe</span>` : ""}
      <span style="color:${snrColor(v.snr)}">${v.snr}dB</span>
      <span class="cqans-tries" title="${v.sessionTries} calls">×${v.sessionTries}</span>
      <span class="cqans-loc">${km}${sec}</span>
    </div>`;
  }).join("");
  el("cqcall").hidden = false;

  // Auto-reply: jump on the strongest non-dupe answerer, once per ~cycle.
  if (cqAuto && answerers.length && Date.now() > cqAutoCooldownUntil) {
    const top = answerers.find(([call]) => !workedAt.has(call));
    if (top) { cqAutoCooldownUntil = Date.now() + 12_000; replyToAnswerer(top[0]); }
  }
}
// Reply to a station answering our CQ — /api/call replays their decode so WSJT-X
// advances the message sequence (sends them the report), as if we double-clicked.
async function replyToAnswerer(call: string) {
  toast(`→ replying to ${call}…`);
  try {
    const r = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call }) }).then((res) => res.json());
    toast(r.ok ? `✓ replying to ${call} — sequence advanced` : `✗ ${r.hint ?? r.error}`, !!r.ok);
  } catch { toast("✗ reply failed", false); }
}

function updateCqCall(s: MyState) {
  const isCq = /^CQ\b/i.test((s.txMessage ?? "").trim());
  const engaged = (s.txEnabled || s.transmitting) && isCq; // CQ keyed on the message, not dxCall
  if (engaged) cqLastEngagedAt = Date.now();
  if (qsoActive) { if (cqActive) exitCqCall(); cqLastTx = false; return; } // a real QSO took over
  // Tx disabled (we halted, or turned off Enable Tx in WSJT-X) -> leave the CQ state.
  if (!s.txEnabled && !s.transmitting) { if (cqActive) exitCqCall(); cqLastTx = false; return; }
  if (Date.now() < cqSuppressUntil) { if (cqActive) exitCqCall(); cqLastTx = false; return; } // just cancelled
  if (!cqActive) { if (engaged) { cqActive = true; cqCallCount = 0; } else { cqLastTx = false; return; } }
  // Count each fresh CQ keyup (transmit start) — how many times we've called with no reply.
  if (isCq && s.transmitting && !cqLastTx) cqCallCount++;
  cqLastTx = isCq && s.transmitting;
  renderCqCall();
}
setInterval(() => { if (cqActive && Date.now() - cqLastEngagedAt > 45000) exitCqCall(); }, 3000); // stopped calling

el("cqcallList").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest(".cqans") as HTMLElement | null;
  if (row?.dataset.call) replyToAnswerer(row.dataset.call);
});
(document.getElementById("cqAuto") as HTMLInputElement).addEventListener("change", (e) => {
  cqAuto = (e.target as HTMLInputElement).checked;
  if (cqAuto) cqAutoCooldownUntil = 0; // allow an immediate pick
});
document.getElementById("cqcallStop")?.addEventListener("click", () => {
  cqSuppressUntil = Date.now() + 4000; // don't let a stale Tx-enabled status re-open it
  exitCqCall();
  fetch("/api/halt", { method: "POST" }).catch(() => {});
  toast("stopped calling CQ — Tx halted");
});

// "Queue" any station (CQ or not) — point WSJT-X at it via /api/dx (Configure +
// generateMessages), so the op just presses Enable Tx. Works from the station
// dialog and the exchange party tiles via the embedded queue button.
async function queueStation(call: string, grid: string | null) {
  toast(`→ queueing ${call} in WSJT-X…`);
  try {
    const r = await fetch("/api/dx", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ call, grid: grid ?? "" }),
    }).then((res) => res.json());
    toast(r.ok ? `✓ ${call} queued — press Enable Tx in WSJT-X` : `✗ ${r.hint ?? r.error}`, !!r.ok);
  } catch { toast("✗ queue failed", false); }
}
// --- "Watch next CQ": arm a hunt on one station; the moment it next calls CQ,
// ding, pulse the map, and pre-stage a reply (so the op just presses Enable Tx).
// Two ways in: a station's card (workflow 1 — a targeted station) or an exchange's
// cqer (workflow 2 — jump on the runner's next CQ). Single target, one-shot. ---
let watchTarget: string | null = null;
let watchArmedAt = 0;
function setWatch(call: string | null) {
  watchTarget = call;
  watchArmedAt = Date.now();
  if (call) toast(`👁 watching ${call} — will alert on its next CQ`, true);
  else clearAutoTarget();
  renderWatchBanner();
  refreshExchanges(); // reflect the watch badge in the exchange list
}
function toggleWatch(call: string) { setWatch(watchTarget === call ? null : call); }
function renderWatchBanner() {
  const b = el("watchBanner");
  if (!watchTarget) { b.hidden = true; b.innerHTML = ""; return; }
  b.hidden = false;
  b.innerHTML = `<span>👁 watching <b>${watchTarget}</b> — jumping on next CQ</span><button id="watchCancel" title="stop watching">×</button>`;
}
function fireWatch(call: string) {
  ding();
  openStationHistory(call); // select + highlight + open the viewer, just like a click
  if (myState.txEnabled || myState.transmitting) {
    toast(`🎯 ${call} is calling CQ — finish your QSO to jump in`, false);
    return; // stay armed: we couldn't act, catch their next CQ
  }
  toast(`🎯 ${call} calling CQ — pre-staging reply…`, true);
  fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call }) })
    .then((r) => r.json())
    .then((r) => toast(r.ok ? `✓ ${call} queued — press Enable Tx` : `✗ ${r.hint ?? r.error}`, !!r.ok))
    .catch(() => toast("✗ pre-stage failed", false));
  setWatch(null); // one-shot: "next CQ" fulfilled
}
el("watchBanner").addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).closest("#watchCancel")) setWatch(null);
});

document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const qb = t.closest("[data-queue]") as HTMLElement | null;
  if (qb) { ev.stopPropagation(); queueStation(qb.dataset.queue!, qb.dataset.grid || null); return; }
  const wb = t.closest("[data-watch]") as HTMLElement | null;
  if (wb?.dataset.watch) { ev.stopPropagation(); toggleWatch(wb.dataset.watch); return; }
  // Clicking a callsign in a card opens its station view (which closes the
  // exchange viewer and highlights the node on the map).
  const nm = t.closest("[data-station]") as HTMLElement | null;
  if (nm?.dataset.station) { ev.stopPropagation(); openStationHistory(nm.dataset.station); }
});

function exitMyQso() {
  if (!qsoActive) return;
  qsoActive = false; myQsoCall = null; myQsoGrid = null; framedWithDx = null;
  lastTransmitting = false; reachOutMsg = null; reachOutCount = 0; dxStolenBy = null;
  lastMyQsoHtml = ""; // force a fresh render next time the panel opens
  el("myqso").hidden = true; myQsoLayer.clearLayers();
  if (preQsoView) { map.flyTo(preQsoView.center, preQsoView.zoom, { duration: 0.8 }); preQsoView = null; }
}

// Our DX picked someone else mid-pursuit — halt, alert, and offer to follow.
function dxStolen(other: string) {
  if (dxStolenBy === other) return;
  dxStolenBy = other;
  noteTried(myQsoCall); // we tried them; if they circle back, offer to jump in
  fetch("/api/halt", { method: "POST" }).catch(() => {}); // stop chasing — we lost the race
  ding();
  toast(`✋ ${myQsoCall} started working ${other} — your Tx stopped`, false);
  renderMyQso();
}

// Render from the CACHED target (myQsoCall/myQsoGrid) so an empty RX-period Status
// doesn't blank the panel; only the live transmit state comes from myState.
let lastMyQsoHtml = ""; // memo: skip innerHTML rewrites that wouldn't change anything
function renderMyQso() {
  if (!myQsoCall) return;
  const dxLL = gridToLatLon(myQsoGrid);
  const info = stationInfo.get(myQsoCall);
  const caller = cqCallers.find((c) => c.call === myQsoCall);
  el("myqsoTitle").textContent = `${myState.transmitting ? "🔴 TX" : "🟠 QSO"} → ${myQsoCall}`;

  const r = (k: string, v: string) => `<div class="myqso-row"><span>${k}</span><b>${v}</b></div>`;
  let body = "";
  if (dxLL && ourLL) {
    body += r("distance", `${Math.round(haversineKm(ourLL, dxLL)).toLocaleString()} km`);
    const brg = Math.round(bearing(ourLL, dxLL));
    body += r("heading", `${brg}° ${COMPASS[Math.round(brg / 45) % 8]}`);
  }
  body += r("grid", myQsoGrid ?? "locating…");
  if (info?.fdClass || info?.section) body += r("field day", [info?.fdClass, info?.section].filter(Boolean).join(" "));
  if (info) {
    body += `<div class="myqso-row"><span>rx snr</span><b style="color:${snrColor(info.lastSnr)}">${info.lastSnr} dB</b></div>`;
    body += r("snr range", `${info.minSnr}…${info.maxSnr} dB`);
    body += r("spots", String(info.spots));
  }
  if (caller) body += r("activity", `${caller.activeness}/100${caller.qsosLastHour ? ` · ${caller.qsosLastHour} q/hr` : ""}`);
  if (info?.band) body += r("band", info.band);
  if (reachOutCount > 1) body += `<div class="myqso-reach">↻ no reply yet — attempt ${reachOutCount}</div>`;
  if (myState.txMessage) body += `<div class="myqso-tx">${myState.txMessage.trim()}</div>`;
  // Soft heads-up if the DX appears busy in a live exchange (unless already flagged stolen).
  const ex = currentExchanges.find((e) => e.cqer === myQsoCall || e.responder === myQsoCall);
  const other = ex ? (ex.cqer === myQsoCall ? ex.responder : ex.cqer) : null;
  if (!dxStolenBy && other && other !== ourCall) {
    body += `<div class="myqso-warn">⚠ ${myQsoCall} is working ${other}<button id="myqsoJump" data-other="${other}">jump to it</button></div>`;
  }
  // Hard alert: our DX picked someone else — we halted Tx, offer to follow.
  const stolen = dxStolenBy
    ? `<div class="myqso-stolen">✋ ${myQsoCall} is working ${dxStolenBy} — your Tx stopped<button id="myqsoJump" data-other="${dxStolenBy}">follow their QSO</button></div>`
    : "";
  // Only touch the DOM when the content actually changed: status updates stream
  // in while transmitting, and rebuilding innerHTML every time destroys the
  // jump/stand buttons mid-interaction (a click between mousedown/up is lost).
  const html = stolen + body;
  if (html !== lastMyQsoHtml) { el("myqsoBody").innerHTML = html; lastMyQsoHtml = html; }
  renderPileup();
  el("myqso").hidden = false;

  myQsoLayer.clearLayers();
  if (ourLL && dxLL) {
    L.polyline(greatCircle([ourLL.lat, ourLL.lon], [dxLL.lat, dxLL.lon]), { color: "#ff5a5a", weight: 3, opacity: 0.95 }).addTo(myQsoLayer);
    L.circleMarker([dxLL.lat, dxLL.lon], { radius: 8, color: "#ff5a5a", weight: 2.5, fill: false, opacity: 0.95 }).addTo(myQsoLayer);
  }
  if (ourLL && framedWithDx !== myQsoCall) {
    framedWithDx = myQsoCall;
    if (dxLL) map.flyToBounds(L.latLngBounds([[ourLL.lat, ourLL.lon], [dxLL.lat, dxLL.lon]]).pad(0.3), { duration: 0.8, maxZoom: 8 });
    else map.flyTo([ourLL.lat, ourLL.lon], map.getZoom(), { duration: 0.6 });
  }
}

// The pileup trying to break into our current QSO, ranked by interest. Lives in
// the my-QSO panel and feeds the next-up handoff.
function pileSorted(): [string, PileEntry][] {
  const now = Date.now();
  return [...cqPileup.entries()]
    .filter(([call, e]) => call !== myQsoCall && now - e.lastSeen < PILE_TTL)
    .sort((a, b) => (b[1].qsoTries - a[1].qsoTries) || (b[1].sessionTries - a[1].sessionTries) || (b[1].snr - a[1].snr));
}
function renderPileup() {
  const host = el("myqsoPile");
  if (!qsoActive) { host.innerHTML = ""; return; }
  const rows = pileSorted();
  if (!rows.length) { host.innerHTML = `<div class="pile-sub">calling you · 0</div><div class="pile-none">no one breaking in yet</div>`; return; }
  const head = `<div class="pile-sub">calling you · ${rows.length}${nextUp ? ` · next ▸ <b>${nextUp}</b>` : ""}</div>`;
  host.innerHTML = head + rows.map(([call, e]) => {
    const worked = workedAt.has(call);
    return `<div class="pile-row${call === nextUp ? " next" : ""}${worked ? " dupe" : ""}" data-pile="${call}" title="${call} · ${e.qsoTries} this QSO / ${e.sessionTries} this session${worked ? " · ⚠ already worked (dupe)" : ""} — click to queue as next">
      <b class="pile-call">${call}</b>
      ${worked ? `<span class="pile-dupe" title="you already worked them">✓ dupe</span>` : ""}
      <span class="pile-int" title="interest — ${e.qsoTries} this QSO / ${e.sessionTries} this session">${e.qsoTries}<small> · ${e.sessionTries}</small></span>
      <span class="pile-snr" style="color:${snrColor(e.snr)}">${e.snr}dB</span>
    </div>`;
  }).join("");
}
function setNextUp(call: string) {
  nextUp = nextUp === call ? null : call;
  renderPileup();
  if (nextUp) toast(`▸ next up: ${nextUp}`, true);
}
// A distinct two-note "ready" bell — not the hunt ding or the worked arpeggio.
function handoffBell() {
  if (!soundEnabled) return;
  try {
    audioCtx ??= new AudioContext();
    audioCtx.resume?.();
    const now = audioCtx.currentTime;
    [[988, 0], [1319, 0.16]].forEach(([f, dt]) => { // B5 -> E6
      const o = audioCtx!.createOscillator(), g = audioCtx!.createGain();
      o.type = "square"; o.frequency.value = f;
      const t0 = now + dt;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.24, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.connect(g); g.connect(audioCtx!.destination);
      o.start(t0); o.stop(t0 + 0.42);
    });
  } catch { /* no audio */ }
}
// QSO finished: hand off to the queued next-up (or auto-pick the highest-interest
// non-dupe). Bell + jump/select the station + pre-stage WSJT-X; op presses Enable Tx.
function finishHandoff() {
  if (handoffDone || !qsoActive) return;
  let target = nextUp;
  if (!target) {
    const now = Date.now();
    target = [...cqPileup.entries()]
      .filter(([call, e]) => call !== myQsoCall && !workedAt.has(call) && now - e.lastSeen < PILE_TTL)
      .sort((a, b) => (b[1].qsoTries - a[1].qsoTries) || (b[1].sessionTries - a[1].sessionTries))[0]?.[0] ?? null;
  }
  if (!target) return; // nothing queued and no one worth auto-picking
  handoffDone = true;
  preQsoView = null; // we're continuing to operate — don't snap the map back
  handoffBell();
  openStationHistory(target); // jump + select + viewer, like a click
  queueStation(target, stationInfo.get(target)?.grid ?? null); // pre-stage /api/dx
}

function updateMyQso(s: MyState) {
  // Count reach-outs: each time we (re)start transmitting the SAME message = a
  // repeated call with no reply; a changed message means the QSO progressed.
  if (s.transmitting && !lastTransmitting) {
    const m = s.txMessage?.trim() || null;
    if (m && m === reachOutMsg) reachOutCount++;
    else { reachOutMsg = m; reachOutCount = m ? 1 : 0; }
  }
  lastTransmitting = s.transmitting;

  // The Tx message is the source of truth: if we're sending CQ, we're NOT in a
  // QSO even if a stale DX call lingers in WSJT-X. (CQ has its own panel.)
  if (/^CQ\b/i.test((s.txMessage ?? "").trim())) { if (qsoActive) exitMyQso(); return; }

  // Who we're working: the DX call, or failing that the addressee of the Tx
  // message (`<to> <from> …`) so we still get a target when DX Call is empty.
  const target = s.dxCall || (s.txMessage ? s.txMessage.trim().split(/\s+/)[0] : null);
  if (target) { if (target !== myQsoCall) { framedWithDx = null; dxStolenBy = null; } myQsoCall = target; }
  if (s.dxGrid) myQsoGrid = s.dxGrid;

  // Once a finished QSO's transmit tail ends, allow that call to re-enter later.
  if (!s.transmitting && dismissedDx) dismissedDx = null;

  // Enter the instant we transmit anything that isn't CQ; then stay sticky —
  // only QSO-logged or a halt (Stand down / STOP TX) clears it.
  if (!qsoActive) {
    if (s.transmitting && myQsoCall && myQsoCall !== dismissedDx) {
      qsoActive = true; clearAutoTarget();
      // Fresh QSO: zero the per-QSO interest counts, drop any previous next-up, re-arm handoff.
      for (const e of cqPileup.values()) e.qsoTries = 0;
      nextUp = null; handoffDone = false;
      preQsoView ??= { center: map.getCenter(), zoom: map.getZoom() };
    } else return;
  }
  renderMyQso();
}

function jumpToTheirExchange(other: string | null) {
  const a = myQsoCall ? stations.get(myQsoCall)?.marker.getLatLng() : null;
  const b = other ? stations.get(other)?.marker.getLatLng() : null;
  const pts = [a, b].filter((p): p is L.LatLng => !!p);
  if (pts.length === 2) map.flyToBounds(L.latLngBounds(pts).pad(0.3), { duration: 0.8, maxZoom: 9 });
  else if (pts.length === 1) map.flyTo(pts[0], Math.max(map.getZoom(), 6), { duration: 0.8 });
}

function standDown() {
  dismissedDx = myQsoCall;
  noteTried(myQsoCall); // if they come back to us later, offer to jump in
  exitMyQso();
  fetch("/api/halt", { method: "POST" }).catch(() => {});
  toast("stood down — Tx halted in WSJT-X");
}

// --- "Come back" watch: a station we tried but didn't complete (they worked
// someone else, or we stood down) later directs traffic at US — offer to jump in. ---
const triedRecently = new Map<string, number>(); // call -> ts we last tried them
const TRIED_TTL = 300_000;
let comebackCall: string | null = null;
function noteTried(call: string | null) { if (call) triedRecently.set(call, Date.now()); }
function maybeComeback(spot: Spot) {
  const from = spot.fromCall;
  if (!from || spot.toCall !== ourCall) return;
  const t = triedRecently.get(from);
  if (t == null) return;
  if (Date.now() - t > TRIED_TTL) { triedRecently.delete(from); return; }
  if (myState.transmitting && myQsoCall === from) return; // already re-engaged
  if (comebackCall) return; // already prompting
  triedRecently.delete(from);
  comebackCall = from;
  ding(); // attention
  const b = el("comeback");
  b.innerHTML = `<span>🔄 <b>${from}</b> came back to you — jump back in?</span><button id="comebackYes">Jump in</button><button id="comebackNo" title="dismiss">✕</button>`;
  b.hidden = false;
}
function hideComeback() { comebackCall = null; const b = el("comeback"); b.hidden = true; b.innerHTML = ""; }
el("comeback").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#comebackYes") && comebackCall) {
    const call = comebackCall;
    hideComeback();
    handoffBell();            // the "ready — enable Tx" tone
    openStationHistory(call); // jump + select that station
    replyToAnswerer(call);    // /api/call replays their decode -> WSJT-X advances the sequence
  } else if (t.closest("#comebackNo")) {
    hideComeback();
  }
});

// pointerdown, not click: the panel re-renders on streaming status updates, so a
// click (mousedown+up on the SAME node) can be lost if a rebuild lands between
// them. pointerdown fires on press, synchronously, before any re-render.
el("myqso").addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  const p = t.closest("[data-pile]") as HTMLElement | null;
  if (p?.dataset.pile) { setNextUp(p.dataset.pile); return; }
  if (t.closest("#myqsoStand")) standDown();
  else { const j = t.closest("#myqsoJump") as HTMLElement | null; if (j) jumpToTheirExchange(j.dataset.other ?? null); }
});

// No idle timeout: a QSO stays up until it's logged or we halt Tx (Stand down /
// STOP TX). RX half-cycles report transmitting=false but must NOT end the QSO.

// QSO logged -> tasteful dopamine + return the map to where we were.
function onQsoLogged(qso: { call: string; grid: string | null; band: string | null; exchangeReceived: string | null }) {
  workedAt.set(qso.call, Date.now());
  triedRecently.delete(qso.call); // completed — no come-back prompt
  if (comebackCall === qso.call) hideComeback();
  renderCq();
  celebrate(qso);
  finishHandoff(); // confirm the handoff before we tear down the QSO state
  dismissedDx = qso.call;
  exitMyQso();
}

function successTone() {
  if (!soundEnabled) return;
  try {
    audioCtx ??= new AudioContext();
    audioCtx.resume?.();
    const now = audioCtx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => { // C5 E5 G5 C6 — a bright major arpeggio
      const o = audioCtx!.createOscillator(), g = audioCtx!.createGain();
      o.type = "triangle"; o.frequency.value = f;
      const t0 = now + i * 0.085;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
      o.connect(g); g.connect(audioCtx!.destination);
      o.start(t0); o.stop(t0 + 0.35);
    });
  } catch { /* no audio */ }
}

let workedTotal = 0;
function celebrate(qso: { call: string; grid: string | null; band: string | null; exchangeReceived: string | null }) {
  successTone();
  const dxLL = gridToLatLon(qso.grid);
  const km = dxLL && ourLL ? Math.round(haversineKm(ourLL, dxLL)) : null;
  const bits = [qso.grid, km != null ? `${km.toLocaleString()} km` : null, qso.band, qso.exchangeReceived].filter(Boolean).join(" · ");
  toast(`✅ Worked ${qso.call}${bits ? ` · ${bits}` : ""}`, true);
  workedTotal++;
  const wc = document.getElementById("workedCount");
  if (wc) { wc.textContent = String(workedTotal); wc.classList.remove("pop"); void wc.offsetWidth; wc.classList.add("pop"); }
}

let audioCtx: AudioContext | null = null;
let soundEnabled = true;
function ding() {
  if (!soundEnabled) return;
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.31);
  } catch { /* no audio */ }
}

function renderCq() {
  const now = Date.now();
  const secOf = (c: CqCaller) => c.section ?? "";
  // Two-phase: selected method primary, callsign (az) always the secondary tiebreaker.
  const cmp = (a: CqCaller, b: CqCaller) =>
    (cqSort === "snr" ? b.snr - a.snr
      : cqSort === "active" ? b.activeness - a.activeness
      : cqSort === "dist" ? (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)
      : Date.parse(b.lastSeen) - Date.parse(a.lastSeen)) // age
    || a.call.localeCompare(b.call);
  for (const c of cqCallers) if (c.workedAt) workedAt.set(c.call, c.workedAt); // sync DB worked times
  const workedWinMs = cqWorkedWindowSec * 1000;
  const visible = cqCallers.filter((c) => {
    // "already worked" filter — independent of hunt mode
    if (workedWinMs > 0) {
      const w = workedAt.get(c.call);
      if (w && Date.now() - w < workedWinMs) return false;
    }
    // Band/mode filter: hide callers we can't work from the current band/mode.
    if (bandFilterOn && curBand && c.band && c.band !== curBand) return false;
    if (bandFilterOn && curMode && c.mode && c.mode !== curMode) return false;
    // Hunt on: drop non-FD + muted sections (highlighted floated to top below).
    if (huntEnabled) {
      if (sectionState.get(secOf(c)) === "hide") return false;
      if (!c.fd && !isFieldDay(c.call)) return false; // backend OR live-stream says FD
    }
    return true;
  });
  el("cqCount").textContent = String(visible.length);
  const sorted = visible.sort((a, b) => {
    if (huntEnabled) {
      const ah = sectionState.get(secOf(a)) === "highlight" ? 0 : 1;
      const bh = sectionState.get(secOf(b)) === "highlight" ? 0 : 1;
      if (ah !== bh) return ah - bh;
    }
    return cmp(a, b);
  });
  el("cqList").innerHTML = sorted.map((c) => {
    const hi = huntEnabled && sectionState.get(secOf(c)) === "highlight";
    const age = (now - Date.parse(c.lastSeen)) / 1000;
    // Staleness fade is applied per-text-element, NOT on the chip — a faded parent
    // clamps child opacity, which was greying out the (otherwise high-contrast) badge.
    const op = hi ? "1" : Math.max(0.72, 1 - age / 120).toFixed(2);
    const dist = c.distanceKm != null ? `${c.distanceKm.toLocaleString()}km` : "—";
    const where = c.grid ?? c.section ?? "?";
    const a = c.activeness;
    const actClass = a >= 70 ? "running hard" : a >= 40 ? "active" : a >= 15 ? "poking around" : "quiet";
    const actColor = `hsl(${Math.round((a / 100) * 120)}, 70%, 48%)`; // red(idle) -> green(running)
    // Known class/section -> their pills; a CQ-FD caller whose section we haven't
    // copied yet -> a "?" pill so it's clear why it's listed.
    const fdMark = (c.fdClass || c.section) ? fdTag(c.fdClass, c.section)
      : c.fd ? ` <span class="fdsec" title="advertising Field Day — section not copied yet">?</span>` : "";
    return `<div class="cqchip${hi ? " hi" : ""}" data-call="${c.call}" title="${c.call} · ${where} · activeness ${a}/100 (${actClass}) · ${c.qsosLastHour} QSO last hr · ${c.cqCount}× CQ · ${Math.round(age)}s ago · click → call in WSJT-X">
      <b style="opacity:${op}">${c.call}</b>${fdMark}
      <span style="opacity:${op};color:${snrColor(c.snr)}">${c.snr}dB</span>
      <span style="opacity:${op};color:${distanceColor(c.distanceKm)}">${dist}</span>
      <span class="cq-act" style="opacity:${op}"><i style="width:${a}%;background:${actColor}"></i></span>
    </div>`;
  }).join("");
}

async function refreshCq() {
  try { cqCallers = await fetch("/api/cq").then((r) => r.json()); renderCq(); } catch { /* ignore */ }
}

document.getElementById("cq")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b?.dataset.cqsort) return;
  cqSort = b.dataset.cqsort as typeof cqSort;
  document.querySelectorAll("#cq .cq-sort button").forEach((x) => x.classList.toggle("active", x === b));
  renderCq();
});
document.querySelector(".cq-filters")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b?.dataset.worked) return;
  cqWorkedWindowSec = Number(b.dataset.worked);
  document.querySelectorAll(".cq-filters button").forEach((x) => x.classList.toggle("active", x === b));
  renderCq();
});
setInterval(refreshCq, 3000);
setInterval(renderCq, 5000); // keep the staleness fade moving between fetches

// Hover a CQ caller -> highlight that node on the map + info card + band marker.
let lastCqHover = "";
const cqListEl = el("cqList");
cqListEl.addEventListener("mouseover", (ev) => {
  const chip = (ev.target as HTMLElement).closest(".cqchip") as HTMLElement | null;
  if (!chip?.dataset.call) return;
  const call = chip.dataset.call;
  if (call !== lastCqHover) {
    lastCqHover = call;
    focusCalls([{ call, role: "CQ", color: "#f4b41a" }]);
  }
  showCard(call, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
  bandHighlight(stationInfo.get(call)?.lastDf ?? null);
  wsjtxHighlight(call);
});
cqListEl.addEventListener("mousemove", (ev) => {
  const chip = (ev.target as HTMLElement).closest(".cqchip") as HTMLElement | null;
  if (chip?.dataset.call) showCard(chip.dataset.call, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
});
cqListEl.addEventListener("mouseleave", () => { lastCqHover = ""; clearFocus(); hideCard(); bandHighlight(null); wsjtxHighlight(null); });

// Click a CQ caller -> ask WSJT-X to set up the QSO (operator still clicks Enable Tx).
const toastEl = document.getElementById("toast") as HTMLDivElement;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, ok = true) {
  toastEl.textContent = msg;
  toastEl.className = ok ? "ok" : "err";
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}
cqListEl.addEventListener("click", async (ev) => {
  const chip = (ev.target as HTMLElement).closest(".cqchip") as HTMLElement | null;
  if (!chip?.dataset.call) return;
  const call = chip.dataset.call;
  openStationHistory(call); // also surface their card + history widget
  toast(`→ WSJT-X: calling ${call}…`);
  try {
    const r = await fetch("/api/call", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call }),
    }).then((res) => res.json());
    toast(r.ok ? `✓ ${call} queued in WSJT-X — click Enable Tx` : `✗ ${r.hint ?? r.error}`, !!r.ok);
  } catch {
    toast("✗ call failed", false);
  }
});

// --- Inline per-panel help: each ⓘ toggles its panel's blurb; HUD "?" toggles all ---
const HINT_PANELS = ["hud", "exchanges", "bandpanel", "cq", "hunt"];
const openHints = new Set<string>();
function applyHints() {
  for (const id of HINT_PANELS) {
    const h = document.getElementById(`hint-${id}`);
    if (h) (h as HTMLElement).hidden = !openHints.has(id);
    document.querySelector(`.hint-btn[data-hint="${id}"]`)?.classList.toggle("active", openHints.has(id));
  }
  document.getElementById("tourBtn")?.classList.toggle("active", openHints.size > 0);
}
document.getElementById("tourBtn")?.addEventListener("click", () => {
  if (openHints.size) openHints.clear(); // any open -> close all; otherwise open all
  else HINT_PANELS.forEach((id) => openHints.add(id));
  applyHints();
});
document.querySelectorAll<HTMLElement>(".hint-btn[data-hint]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't trip panel sort/filter handlers
    const id = btn.dataset.hint!;
    if (openHints.has(id)) openHints.delete(id); else openHints.add(id);
    applyHints();
  });
});

// Abort-TX button -> HaltTx. Halting Tx ends the QSO/CQ session too.
document.getElementById("abort")?.addEventListener("click", async () => {
  if (qsoActive) { dismissedDx = myQsoCall; exitMyQso(); }
  if (cqActive) exitCqCall();
  try {
    const r = await fetch("/api/halt", { method: "POST" }).then((res) => res.json());
    toast(r.ok ? "■ TX halted" : `✗ ${r.hint ?? r.error}`, !!r.ok);
  } catch {
    toast("✗ halt failed", false);
  }
});

// --- Hunt: ARRL section list with hide/highlight filtering + FD-only ---
type SecState = "hide" | "highlight";
const sectionState = new Map<string, SecState>();
let huntSort: "state" | "count" = "state";
let huntEnabled = false; // master toggle: lists sections + filters whole UI to Field Day
interface SectionStat {
  section: string; name: string; state: string | null;
  stationsHeard: number; bestSnr: number | null; closestKm: number | null; worked: boolean;
}
let sectionStats: SectionStat[] = [];

// A station is "Field Day" only if it *advertised* it — CQ FD, a class, or a
// class+section exchange (tracked sticky in noteStation). A section pulled from a
// callbook doesn't make a station a Field Day participant.
function isFieldDay(call: string): boolean {
  return !!stationInfo.get(call)?.fd;
}

// Band/mode filter — by default follow WSJT-X: only show stations on the band+mode
// we're currently on (you can't work the rest; they're noise). curBand/curMode
// track the latest decode; bandFilterOn toggles it.
let curBand: string | null = null;
let curMode: string | null = null;
let bandFilterOn = true;
// Set the current band/mode (from a Status switch event OR a decode) and refresh
// everything the band/mode filter touches — so a band switch retargets instantly.
function setCurrentBandMode(band: string | null, mode: string | null) {
  if (!band || (band === curBand && mode === curMode)) return;
  curBand = band; curMode = mode;
  el("band").textContent = `${band}${mode ? " " + mode : ""}`;
  el("bandNow").textContent = band;
  renderCq();
  refreshExchanges();
  if (huntEnabled || bandFilterOn) applySectionFilter();
}
function stationPassesBand(call: string): boolean {
  if (!bandFilterOn) return true;
  const i = stationInfo.get(call);
  if (!i) return true; // unknown (e.g. a recipient we never copied) — don't hide
  if (curBand && i.band && i.band !== curBand) return false;
  if (curMode && i.mode && i.mode !== curMode) return false;
  return true;
}
(document.getElementById("bandLock") as HTMLInputElement).addEventListener("change", (e) => {
  bandFilterOn = (e.target as HTMLInputElement).checked;
  applySectionFilter();
  renderCq();
  refreshExchanges();
});

// Station-marker visibility under the active filters (band/mode + Field Day).
function applySectionFilter() {
  if (focusActive) return; // hover focus owns marker styles while active
  if (!huntEnabled && !bandFilterOn) { stations.forEach((s) => s.marker.setStyle({ opacity: 1, fillOpacity: 0.8 })); return; }
  const anyHi = huntEnabled && [...sectionState.values()].includes("highlight");
  stations.forEach((s, call) => {
    if (call === ourCall) { s.marker.setStyle({ opacity: 1, fillOpacity: 0.9 }); return; } // always show ourselves
    const sec = stationInfo.get(call)?.section ?? null;
    const st = huntEnabled && sec ? sectionState.get(sec) : undefined;
    let hide = !stationPassesBand(call); // wrong band/mode -> gone
    if (huntEnabled) {
      if (st === "hide") hide = true;
      else if (!isFieldDay(call)) hide = true; // non-FD filtered out
    }
    if (hide) { s.marker.setStyle({ opacity: 0, fillOpacity: 0 }); return; }
    if (huntEnabled && st === "highlight") s.marker.setStyle({ opacity: 1, fillOpacity: 1 });
    else if (huntEnabled && sec && anyHi) s.marker.setStyle({ opacity: 0.15, fillOpacity: 0.06 });
    else s.marker.setStyle({ opacity: 1, fillOpacity: 0.8 });
  });
}

function renderHunt() {
  if (!huntEnabled) {
    el("huntCount").textContent = "—";
    el("huntList").innerHTML = `<div class="hunt-off">turn on Field Day mode (top) to list sections &amp; filter the UI</div>`;
    return;
  }
  el("huntCount").textContent = String(sectionStats.length);
  // Group by state (so split states like FL = NFL/SFL/WCF are neighbors), then code.
  // "~" sorts state-less sections (Canada/PR/VI) to the end.
  const byState = (a: SectionStat, b: SectionStat) =>
    (a.state ?? "~").localeCompare(b.state ?? "~") || a.section.localeCompare(b.section);
  const sorted = [...sectionStats].sort((a, b) =>
    huntSort === "count" ? (a.stationsHeard - b.stationsHeard) || byState(a, b) : byState(a, b));
  let prevState: string | null | undefined;
  el("huntList").innerHTML = sorted.map((s, idx) => {
    const st = sectionState.get(s.section);
    const brk = huntSort === "state" && idx > 0 && s.state !== prevState; // divider at each new state
    prevState = s.state;
    const meta = [`${s.stationsHeard} st`, s.bestSnr != null ? `${s.bestSnr}dB` : null, s.closestKm != null ? `${s.closestKm.toLocaleString()}km` : null].filter(Boolean).join(" · ");
    return `<div class="hunt-row ${st ? "s-" + st : ""}${s.stationsHeard === 0 ? " s-none" : ""}${brk ? " s-break" : ""}" data-sec="${s.section}">
      <button class="hb-hi ${st === "highlight" ? "on" : ""}" data-mode="highlight" title="highlight (filter in)">+</button>
      <button class="hb-hide ${st === "hide" ? "on" : ""}" data-mode="hide" title="hide (filter out)">−</button>
      <span class="hunt-sec ${s.worked ? "worked" : ""}" title="${s.name}${s.worked ? " · worked" : ""}">${s.section}</span>
      <span class="hunt-meta">${meta}</span>
    </div>`;
  }).join("");
}
function applyHuntEverywhere() {
  renderHunt();
  applySectionFilter();
  renderCq(); // hide/highlight also drives the CQ list
}
function cycleSection(sec: string, mode: SecState) {
  if (sectionState.get(sec) === mode) sectionState.delete(sec); else sectionState.set(sec, mode);
  applyHuntEverywhere();
}
el("huntList").addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  const row = (ev.target as HTMLElement).closest(".hunt-row") as HTMLElement | null;
  if (btn && row?.dataset.sec) cycleSection(row.dataset.sec, btn.dataset.mode as SecState);
});
document.querySelector(".hunt-actions")?.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b?.dataset.bulk) {
    sectionState.clear();
    if (b.dataset.bulk !== "clear") for (const s of sectionStats) sectionState.set(s.section, b.dataset.bulk as SecState);
    applyHuntEverywhere();
  } else if (b?.dataset.hsort) {
    huntSort = b.dataset.hsort as typeof huntSort;
    document.querySelectorAll(".hunt-actions [data-hsort]").forEach((x) => x.classList.toggle("active", x === b));
    renderHunt();
  }
});
(document.getElementById("huntEnable") as HTMLInputElement).addEventListener("change", (ev) => {
  huntEnabled = (ev.target as HTMLInputElement).checked;
  document.body.classList.toggle("fd-mode", huntEnabled); // global accent: whole UI is filtered
  renderHunt();
  applySectionFilter();
  renderCq();
  refreshExchanges();
});
async function refreshHunt() {
  try { sectionStats = await fetch("/api/sections").then((r) => r.json()); renderHunt(); } catch { /* ignore */ }
}
setInterval(refreshHunt, 8000);

// --- Auto-hunt: when a highlighted section calls CQ, debounce the decode storm,
// pick the best-SNR un-worked station, queue it in WSJT-X, and ding. ---
let autoHunt = false;
const autoBuf = new Map<string, number>(); // candidate call -> snr (this storm)
let autoTimer: ReturnType<typeof setTimeout> | undefined;
let autoCooldownUntil = 0;
let autoTargetClear: ReturnType<typeof setTimeout> | undefined;

// Mark the auto-called station on the map: pan to it (keep zoom) + a pulsing ring + label.
function markAutoTarget(call: string) {
  clearAutoTarget();
  const s = stations.get(call);
  if (!s) return;
  const ll = s.marker.getLatLng();
  map.panTo(ll, { animate: true, duration: 0.6 }); // keep zoom, just pan
  L.marker(ll, { icon: L.divIcon({ className: "", html: `<div class="auto-target-pulse"></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false }).addTo(autoTargetLayer);
  L.tooltip({ permanent: true, direction: "top", offset: [0, -16], className: "auto-target-label" }).setLatLng(ll).setContent(`🎯 ${call}`).addTo(autoTargetLayer);
  autoTargetClear = setTimeout(clearAutoTarget, 35_000); // drop the marker if the QSO never starts
}
function clearAutoTarget() { clearTimeout(autoTargetClear); autoTargetLayer.clearLayers(); }

function autoConsider(spot: Spot) {
  if (!autoHunt || !huntEnabled) return;
  if (myState.txEnabled || myState.transmitting) return; // never chase a new CQ mid-QSO
  if (spot.msgType !== "cq" || !spot.fromCall) return;
  if (Date.now() < autoCooldownUntil) return;
  if (!isFieldDay(spot.fromCall)) return; // only stations advertising Field Day
  const sec = stationInfo.get(spot.fromCall)?.section ?? null;
  if (!sec || sectionState.get(sec) !== "highlight") return; // only highlighted sections
  if (workedAt.has(spot.fromCall)) return; // already worked
  autoBuf.set(spot.fromCall, spot.snr);
  clearTimeout(autoTimer);
  autoTimer = setTimeout(fireAutoHunt, 1000); // ~half the FT8 dead time after the storm
}
async function fireAutoHunt() {
  // Re-check: the operator may have committed to a QSO during the debounce.
  if (myState.txEnabled || myState.transmitting) { autoBuf.clear(); return; }
  let best: string | null = null, bestSnr = -999;
  for (const [call, snr] of autoBuf) if (snr > bestSnr) { bestSnr = snr; best = call; }
  autoBuf.clear();
  if (!best) return;
  autoCooldownUntil = Date.now() + 20_000; // give the op time to work it
  markAutoTarget(best); // make the chosen station obvious on the map
  ding();
  const sec = stationInfo.get(best)?.section;
  toast(`🎯 AUTO-HUNT → ${best}${sec ? ` (${sec})` : ""}  ${bestSnr >= 0 ? "+" : ""}${bestSnr} dB  — queued in WSJT-X, hit Enable Tx`);
  try {
    const r = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call: best }) }).then((res) => res.json());
    if (!r.ok) toast(`✗ ${r.hint ?? r.error}`, false);
  } catch { toast("✗ auto-call failed", false); }
}
(document.getElementById("huntAuto") as HTMLInputElement).addEventListener("change", (ev) => {
  autoHunt = (ev.target as HTMLInputElement).checked;
  if (autoHunt) { audioCtx ??= new AudioContext(); audioCtx.resume?.(); } // prime audio on the gesture
  else clearAutoTarget(); // drop the on-map target marker when auto is switched off
});
const soundBtn = document.getElementById("soundToggle") as HTMLButtonElement;
soundBtn?.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundBtn.textContent = soundEnabled ? "🔊" : "🔇";
  soundBtn.classList.toggle("muted", !soundEnabled);
  if (soundEnabled) { audioCtx ??= new AudioContext(); audioCtx.resume?.(); ding(); } // prime + confirm
});

async function init() {
  // Backfill stations from history so the map isn't empty on load.
  try {
    const spots: Spot[] = await fetch("/api/spots").then((r) => r.json());
    for (const s of spots.slice(-300)) {
      if (s.fromCall && s.txLat != null && s.txLon != null) upsertStation(s.fromCall, s.txLat, s.txLon, { ourSnr: s.snr });
      if (s.toCall && s.toLat != null && s.toLon != null) upsertStation(s.toCall, s.toLat, s.toLon, {});
      if (s.rxCall && s.rxLat != null && s.rxLon != null) upsertStation(s.rxCall, s.rxLat, s.rxLon, { isRx: true });
      noteStation(s);
      addFreq(s.audioDf);
      recordRate(Date.parse(s.receivedAt), s.decodeTimeMs);
    }
    renderRates();
  } catch { /* first run: no data yet */ }

  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "spot") addSpot(m.spot);
    else if (m.type === "qso") onQsoLogged(m.qso); // live "worked" + celebration
    else if (m.type === "status") setMyState(m.status); // our TX / in-QSO state
  };
  ws.onclose = () => setTimeout(init, 2000); // naive reconnect

  refreshExchanges();
  refreshCq();
  refreshHunt();
}

init();
