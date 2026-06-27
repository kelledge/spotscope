# AGENTS.md

Guidance for AI agents working in this repo. Keep changes small and in-style.

## Stack & layout
- **Runtime:** Bun + TypeScript. No build step for the backend (Bun runs TS).
- `backend/` — WSJT-X UDP ingest → SQLite (`bun:sqlite`) → WebSocket + REST + static UI.
  - `wsjtx/` — `NetworkMessage` protocol read/write (Qt `QDataStream`, big-endian).
  - `geo/` — Maidenhead grid + ARRL section → lat/lon, haversine.
- `frontend/` — Leaflet + vanilla TS (`main.ts`), no framework. Bun bundles `index.html`.

## Commands
- `bun dev` — hot-reloading server on :8787.
- `bun test` — unit tests (must pass before commit).
- `bun build frontend/index.html --outdir /tmp/x` — verify the UI bundles.
- `docker compose up --build` — release image (host networking; graceful SIGTERM).

## Conventions / gotchas
- **Commit messages:** never add `Co-Authored-By`, "Generated with…", or any AI
  attribution trailer. A local `commit-msg` hook hard-blocks them.
- **No lat/lon in storage.** Persist grid/section symbols; derive coordinates via
  `geo/locate.ts` at read time.
- **Two SNR meanings:** `snr` = our reception of a station; `reportDb` = the report
  embedded in the message text. Don't conflate them.
- **Regulatory line:** there is no "enable TX" command — we can queue/point/halt,
  but the operator presses **Enable Tx** in WSJT-X. Don't try to automate keying.
- **WSJT-X ignores commands** unless "Accept UDP requests" is on; backend warns.
- **TS strip-only quirks:** avoid constructor parameter-properties; don't rely on
  class-field initializer order (use inline `db.query()`, which caches).
- **SPDX headers:** `//` for `.ts`, `/* */` for `.css`, `<!-- -->` for `.html`.
- Licensed **AGPL-3.0-only**; keep new files headed accordingly.

## Style
Match surrounding code: terse comments that explain *why*, same naming/idiom.
The UI is intentionally framework-free — keep it that way.
