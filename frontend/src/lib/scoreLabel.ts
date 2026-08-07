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

// Named profiles instead of asking HR to hand-balance four raw numbers to sum to 1.00 —
// picking "Prioritize skills" requires no arithmetic. Custom mode still exists for power
// users, but even there the values get auto-normalized rather than rejected if they don't
// add up (see normalizeWeights in JobForm.tsx).
export const WEIGHT_PRESETS = {
  balanced: {
    label: "Balanced (recommended)",
    skills: 0.25,
    experience: 0.25,
    education: 0.25,
    certifications: 0.25,
  },
  skills_first: {
    label: "Prioritize skills",
    skills: 0.4,
    experience: 0.2,
    education: 0.2,
    certifications: 0.2,
  },
  experience_first: {
    label: "Prioritize work experience",
    skills: 0.2,
    experience: 0.4,
    education: 0.2,
    certifications: 0.2,
  },
  education_first: {
    label: "Prioritize education & certifications",
    skills: 0.2,
    experience: 0.2,
    education: 0.3,
    certifications: 0.3,
  },
} as const;

export type WeightPresetKey = keyof typeof WEIGHT_PRESETS | "custom";
