export interface IntegrityBand {
  min: number;
  label: string;
  badgeClass: string;
}

// integrity_score is 0-100 where 100 = clean, mirroring the fit-score convention already
// used for resume screening — same "plain label + number, not a bare number" pattern.
export const INTEGRITY_SCORE_BANDS: IntegrityBand[] = [
  { min: 90, label: "No concerns", badgeClass: "badge-approved" },
  { min: 75, label: "Minor concerns", badgeClass: "badge-approved" },
  { min: 50, label: "Moderate concerns — review recommended", badgeClass: "badge-review" },
  { min: 0, label: "Significant concerns — review required", badgeClass: "badge-declined" },
];

export function getIntegrityScoreBand(score: number): IntegrityBand {
  return (
    INTEGRITY_SCORE_BANDS.find((band) => score >= band.min) ??
    INTEGRITY_SCORE_BANDS[INTEGRITY_SCORE_BANDS.length - 1]
  );
}

export interface SeverityBand {
  min: number;
  label: string;
  badgeClass: string;
}

// Flag severity is an open-ended positive number (weight-driven, compounds when signals
// cluster) — not meaningful to HR as a raw float. These bands are calibrated against what
// the fusion engine actually produces: a single moderate signal lands ~2-3, a clustered
// pair ~4-6, a serious standalone signal (e.g. stopped screen-sharing) ~5+.
export const SEVERITY_BANDS: SeverityBand[] = [
  { min: 6, label: "High", badgeClass: "badge-declined" },
  { min: 3, label: "Moderate", badgeClass: "badge-review" },
  { min: 0, label: "Low", badgeClass: "badge-approved" },
];

export function getSeverityBand(severity: number): SeverityBand {
  return SEVERITY_BANDS.find((band) => severity >= band.min) ?? SEVERITY_BANDS[SEVERITY_BANDS.length - 1];
}
