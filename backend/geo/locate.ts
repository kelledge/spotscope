// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// Single place that casts a station's *canonical* location (a Maidenhead grid,
// or an ARRL section as fallback) into lat/lon. Grid -> center of the square.
// lat/lon is derived here at the point of use (API serialization, distance
// metrics) — it is never the stored datum.
import type { LatLon } from "../types.ts";
import { gridToLatLon } from "./maidenhead.ts";
import { sectionToLatLon } from "./sections.ts";

export function locate(grid: string | null | undefined, section: string | null | undefined): LatLon | null {
  return gridToLatLon(grid) ?? sectionToLatLon(section);
}
