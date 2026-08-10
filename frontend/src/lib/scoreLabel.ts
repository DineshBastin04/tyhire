export interface ScoreBand {
  min: number;
  label: string;
}

export const SCORE_BANDS: ScoreBand[] = [
  { min: 85, label: "Excellent fit" },
  { min: 70, label: "Strong fit" },
  { min: 55, label: "Good fit" },
  { min: 40, label: "Fair fit" },
  { min: 0, label: "Weak fit" },
];

export function getScoreLabel(score: number): string {
  return SCORE_BANDS.find((band) => score >= band.min)?.label ?? "Weak fit";
}

export const STRICTNESS_PRESETS = {
  strict: { label: "Strict — only strong matches auto-approve", approve: 85, decline: 50 },
  balanced: { label: "Balanced (recommended)", approve: 75, decline: 40 },
  lenient: { label: "Lenient — cast a wider net", approve: 60, decline: 30 },
} as const;

export type StrictnessKey = keyof typeof STRICTNESS_PRESETS | "custom";
