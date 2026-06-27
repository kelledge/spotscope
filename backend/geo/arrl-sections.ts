// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Kevin Elledge

// ARRL/RAC section metadata: full name + the US state polygon it falls in (for
// the map outline overlay). Split states (CA/NY/PA/FL/MA/TX/NJ/WA) share their
// state polygon across multiple sections — outlines are state-level, but station
// filtering is per-section (precise). Canada/PR/VI have no US-states polygon.
export interface SectionMeta { name: string; state?: string }

export const SECTION_META: Record<string, SectionMeta> = {
  // New England
  CT: { name: "Connecticut", state: "Connecticut" },
  EMA: { name: "Eastern Massachusetts", state: "Massachusetts" },
  ME: { name: "Maine", state: "Maine" },
  NH: { name: "New Hampshire", state: "New Hampshire" },
  RI: { name: "Rhode Island", state: "Rhode Island" },
  VT: { name: "Vermont", state: "Vermont" },
  WMA: { name: "Western Massachusetts", state: "Massachusetts" },
  // Hudson + NJ
  ENY: { name: "Eastern New York", state: "New York" },
  NLI: { name: "NYC / Long Island", state: "New York" },
  NNY: { name: "Northern New York", state: "New York" },
  NNJ: { name: "Northern New Jersey", state: "New Jersey" },
  SNJ: { name: "Southern New Jersey", state: "New Jersey" },
  WNY: { name: "Western New York", state: "New York" },
  // Atlantic
  DE: { name: "Delaware", state: "Delaware" },
  EPA: { name: "Eastern Pennsylvania", state: "Pennsylvania" },
  MDC: { name: "Maryland-DC", state: "Maryland" },
  WPA: { name: "Western Pennsylvania", state: "Pennsylvania" },
  // Roanoke + Southeastern
  NC: { name: "North Carolina", state: "North Carolina" },
  SC: { name: "South Carolina", state: "South Carolina" },
  VA: { name: "Virginia", state: "Virginia" },
  WV: { name: "West Virginia", state: "West Virginia" },
  AL: { name: "Alabama", state: "Alabama" },
  GA: { name: "Georgia", state: "Georgia" },
  NFL: { name: "Northern Florida", state: "Florida" },
  SFL: { name: "Southern Florida", state: "Florida" },
  WCF: { name: "West Central Florida", state: "Florida" },
  PR: { name: "Puerto Rico" },
  VI: { name: "Virgin Islands" },
  // Great Lakes
  KY: { name: "Kentucky", state: "Kentucky" },
  MI: { name: "Michigan", state: "Michigan" },
  OH: { name: "Ohio", state: "Ohio" },
  // Central
  IL: { name: "Illinois", state: "Illinois" },
  IN: { name: "Indiana", state: "Indiana" },
  WI: { name: "Wisconsin", state: "Wisconsin" },
  // Delta
  AR: { name: "Arkansas", state: "Arkansas" },
  LA: { name: "Louisiana", state: "Louisiana" },
  MS: { name: "Mississippi", state: "Mississippi" },
  TN: { name: "Tennessee", state: "Tennessee" },
  // Dakota + Midwest
  MN: { name: "Minnesota", state: "Minnesota" },
  ND: { name: "North Dakota", state: "North Dakota" },
  SD: { name: "South Dakota", state: "South Dakota" },
  IA: { name: "Iowa", state: "Iowa" },
  KS: { name: "Kansas", state: "Kansas" },
  MO: { name: "Missouri", state: "Missouri" },
  NE: { name: "Nebraska", state: "Nebraska" },
  // West Gulf
  NTX: { name: "North Texas", state: "Texas" },
  STX: { name: "South Texas", state: "Texas" },
  WTX: { name: "West Texas", state: "Texas" },
  OK: { name: "Oklahoma", state: "Oklahoma" },
  NM: { name: "New Mexico", state: "New Mexico" },
  // Rocky Mountain
  CO: { name: "Colorado", state: "Colorado" },
  UT: { name: "Utah", state: "Utah" },
  WY: { name: "Wyoming", state: "Wyoming" },
  // Pacific + Southwestern
  AZ: { name: "Arizona", state: "Arizona" },
  EB: { name: "East Bay", state: "California" },
  LAX: { name: "Los Angeles", state: "California" },
  ORG: { name: "Orange", state: "California" },
  PAC: { name: "Pacific", state: "Hawaii" },
  SB: { name: "Santa Barbara", state: "California" },
  SCV: { name: "Santa Clara Valley", state: "California" },
  SDG: { name: "San Diego", state: "California" },
  SF: { name: "San Francisco", state: "California" },
  SJV: { name: "San Joaquin Valley", state: "California" },
  SV: { name: "Sacramento Valley", state: "California" },
  NV: { name: "Nevada", state: "Nevada" },
  // Northwestern
  AK: { name: "Alaska", state: "Alaska" },
  ID: { name: "Idaho", state: "Idaho" },
  MT: { name: "Montana", state: "Montana" },
  OR: { name: "Oregon", state: "Oregon" },
  EWA: { name: "Eastern Washington", state: "Washington" },
  WWA: { name: "Western Washington", state: "Washington" },
  // RAC (Canada) — no US-states polygon
  MAR: { name: "Maritime" }, NL: { name: "Newfoundland/Labrador" }, QC: { name: "Quebec" },
  ONE: { name: "Ontario East" }, ONN: { name: "Ontario North" }, ONS: { name: "Ontario South" },
  GTA: { name: "Greater Toronto" }, MB: { name: "Manitoba" }, SK: { name: "Saskatchewan" },
  AB: { name: "Alberta" }, BC: { name: "British Columbia" }, NT: { name: "Northern Territories" },
};
