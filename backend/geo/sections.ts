// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// ARRL/RAC contest section -> approximate region centroid (lat, lon).
// Used as a *fallback* location for stations heard only in contest exchanges
// (Field Day etc.) that never send a Maidenhead grid. Coords are deliberately
// approximate — enough to drop a marker in the right region.
import type { LatLon } from "../types.ts";

export const SECTIONS: Record<string, LatLon> = {
  // New England
  CT: { lat: 41.6, lon: -72.7 }, EMA: { lat: 42.3, lon: -71.1 }, ME: { lat: 45.3, lon: -69.0 },
  NH: { lat: 43.7, lon: -71.5 }, RI: { lat: 41.7, lon: -71.5 }, VT: { lat: 44.0, lon: -72.7 },
  WMA: { lat: 42.4, lon: -72.6 },
  // Hudson + NNJ/SNJ
  ENY: { lat: 42.7, lon: -73.9 }, NLI: { lat: 40.7, lon: -73.6 }, NNY: { lat: 44.3, lon: -74.9 },
  NNJ: { lat: 40.8, lon: -74.2 }, SNJ: { lat: 39.5, lon: -74.7 }, WNY: { lat: 42.9, lon: -78.0 },
  // Atlantic
  DE: { lat: 39.0, lon: -75.5 }, EPA: { lat: 40.6, lon: -76.0 }, MDC: { lat: 39.0, lon: -76.7 },
  WPA: { lat: 40.8, lon: -79.5 },
  // Roanoke + Southeastern
  NC: { lat: 35.5, lon: -79.4 }, SC: { lat: 33.9, lon: -80.9 }, VA: { lat: 37.5, lon: -78.9 },
  WV: { lat: 38.6, lon: -80.6 }, AL: { lat: 32.8, lon: -86.8 }, GA: { lat: 32.7, lon: -83.5 },
  NFL: { lat: 30.2, lon: -82.5 }, SFL: { lat: 26.5, lon: -80.6 }, WCF: { lat: 28.0, lon: -82.2 },
  PR: { lat: 18.2, lon: -66.4 }, VI: { lat: 18.3, lon: -64.9 },
  // Great Lakes
  KY: { lat: 37.5, lon: -85.3 }, MI: { lat: 43.3, lon: -84.5 }, OH: { lat: 40.3, lon: -82.8 },
  // Central
  IL: { lat: 40.0, lon: -89.0 }, IN: { lat: 39.9, lon: -86.3 }, WI: { lat: 44.5, lon: -89.5 },
  // Delta
  AR: { lat: 34.8, lon: -92.4 }, LA: { lat: 31.0, lon: -92.0 }, MS: { lat: 32.7, lon: -89.7 },
  TN: { lat: 35.9, lon: -86.4 },
  // Dakota + Midwest
  MN: { lat: 46.0, lon: -94.3 }, ND: { lat: 47.5, lon: -100.5 }, SD: { lat: 44.4, lon: -100.2 },
  IA: { lat: 42.0, lon: -93.5 }, KS: { lat: 38.5, lon: -98.4 }, MO: { lat: 38.4, lon: -92.5 },
  NE: { lat: 41.5, lon: -99.8 },
  // West Gulf
  NTX: { lat: 33.0, lon: -97.0 }, STX: { lat: 29.5, lon: -98.5 }, WTX: { lat: 31.8, lon: -102.0 },
  OK: { lat: 35.5, lon: -97.5 }, NM: { lat: 34.5, lon: -106.0 },
  // Rocky Mountain
  CO: { lat: 39.0, lon: -105.5 }, UT: { lat: 39.3, lon: -111.7 }, WY: { lat: 43.0, lon: -107.5 },
  // Pacific + Southwestern
  AZ: { lat: 34.2, lon: -111.7 }, EB: { lat: 37.8, lon: -122.1 }, LAX: { lat: 34.0, lon: -118.2 },
  ORG: { lat: 33.7, lon: -117.8 }, PAC: { lat: 21.3, lon: -157.8 }, SB: { lat: 34.7, lon: -120.0 },
  SCV: { lat: 37.3, lon: -121.9 }, SDG: { lat: 32.8, lon: -117.1 }, SF: { lat: 37.8, lon: -122.4 },
  SJV: { lat: 36.7, lon: -119.8 }, SV: { lat: 38.9, lon: -121.5 }, NV: { lat: 39.5, lon: -117.0 },
  // Northwestern
  AK: { lat: 64.2, lon: -149.5 }, ID: { lat: 44.1, lon: -114.7 }, MT: { lat: 46.9, lon: -110.4 },
  OR: { lat: 44.0, lon: -120.5 }, EWA: { lat: 47.4, lon: -118.3 }, WWA: { lat: 47.4, lon: -122.3 },
  // RAC (Canada)
  NB: { lat: 46.5, lon: -66.0 }, NS: { lat: 45.0, lon: -63.0 }, PE: { lat: 46.4, lon: -63.2 },
  NL: { lat: 53.0, lon: -60.0 }, QC: { lat: 52.0, lon: -72.0 },
  ONE: { lat: 45.4, lon: -75.7 }, ONN: { lat: 49.0, lon: -84.0 }, ONS: { lat: 43.5, lon: -80.0 },
  GH: { lat: 43.4, lon: -79.8 }, MB: { lat: 53.0, lon: -97.0 }, SK: { lat: 54.0, lon: -106.0 },
  AB: { lat: 54.0, lon: -114.0 }, BC: { lat: 53.7, lon: -124.0 }, TER: { lat: 65.0, lon: -120.0 },
};

export function isSection(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(SECTIONS, token.toUpperCase());
}

export function sectionToLatLon(token: string | null | undefined): LatLon | null {
  if (!token) return null;
  return SECTIONS[token.toUpperCase()] ?? null;
}
