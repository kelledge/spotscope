// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Maidenhead grid locator -> lat/lon at the *center* of the square.
// Supports 4-char (e.g. EM18) and 6-char (e.g. EM18ab) locators.
import type { LatLon } from "../types.ts";

const A = "A".charCodeAt(0);

export function gridToLatLon(grid: string | null | undefined): LatLon | null {
  if (!grid) return null;
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;

  // Field (20° lon x 10° lat), then square (2° x 1°).
  let lon = (g.charCodeAt(0) - A) * 20 - 180;
  let lat = (g.charCodeAt(1) - A) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]) * 1;

  if (g.length === 6) {
    // Subsquare: 5' lon x 2.5' lat.
    lon += (g.charCodeAt(4) - A) * (2 / 24);
    lat += (g.charCodeAt(5) - A) * (1 / 24);
    lon += 2 / 24 / 2;
    lat += 1 / 24 / 2;
  } else {
    lon += 1; // center of the 2° square
    lat += 0.5; // center of the 1° square
  }
  return { lat, lon };
}
