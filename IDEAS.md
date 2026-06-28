# SpotScope — idea box

Unevaluated ideas / roadmap candidates. Capture freely; prune when built or rejected.
`+` = added during brainstorming, not yet discussed.

## Hunting & alerting
1. **Callsign hunt** — give it a callsign; fire the auto-target/cue when *that* station
   calls CQ. Generalizes to a watchlist of calls.
2. **Geo hunt** — draw a region on the map (freehand polygon) or pick a preset
   (Europe, Africa, Oceania, …); filter the map + hunt to stations inside it.
   Composes with the existing ARRL-section hunt.
+ **Needed-section / new-multiplier hunt** — for Field Day, only alert on sections
  not yet worked (we already have `workedMap()` + section stats); badge CQ callers
  NEW vs DUPE per band.
+ **Watchlist & notes** — persistent per-callsign "wanted" flags + freeform notes;
  feeds the callsign hunt (#1).
+ **Quick filters** — fast toggles on the CQ list and map: FT8 vs FT4, band,
  distance (< N km), continent.

## Map interaction
3. **Click a station → activity drill-down** — its history/timeline: who it's worked,
   rate, SNR trend. `db.stationHistory()` exists; surface it richer.
5. **Hover a great-circle arc → make that exchange active** — hovering the arc
   focuses/targets the exchange, same as hovering its row.
+ **Timeline scrubber / replay** — scrub the last N minutes. `messages` is the
  append-only source of truth (db.ts already calls this "graph replay"); watch a
  pileup unfold.
+ **Marker clustering / density at low zoom** — the README flags map busyness;
  cluster or heatmap when zoomed out.
+ **Propagation context** — grey-line overlay / band-openness hint by region.

## Exchange intelligence
4. **Per-contest exchange heuristics** — classify the decoded content and apply the
   right parser (FD = "FD" + class/section; also POTA, SOTA, ARRL VHF grids,
   WW-DX zones, state QSO parties). `Ft8Parsed.cqModifier` already extracts
   DX/FD/POTA — branch the heuristic on it.
+ **Multi-instance / multi-band** — `Spot.instance` is already threaded through;
  track several WSJT-X rigs/bands at once and answer "best band to work X."
+ **Ingest LoggedADIF (type 12) + ADIF import** — richer logged-QSO data than
  QSOLogged, and seed worked/dupe state from your real log, not just this session.

## Operating & output
+ **Run-rate meter + FD score estimate** — your q/hr, session totals, rough points;
  export ADIF/Cabrillo from the `qsos` table.
+ **Keyboard-driven operating** — hotkeys to work the top CQ / halt / next, for
  mouse-free Field Day runs.
+ **"How am I getting out"** — reverse view from the embedded `reportDb` where
  others report *us*: a map of who's hearing you, and how well.
+ **Per-event sounds** — distinct cues for new section vs target CQ vs QSO logged
  (extends the current ding).
+ **Band trend (growing / closing)** — on the band-activity widget, classify whether
  spots are increasing or decreasing over time (band opening vs closing). Stock-ticker
  style: a sparkline of the recent spot rate with a green up / red down arrow. The
  rate buffers (`rateBuf`, per-min/hour) already exist to derive the slope.
