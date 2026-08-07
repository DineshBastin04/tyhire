"use client";

import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/api";
import type { Job, JobLevel, WorkMode } from "@/lib/types";
import {
  getScoreLabel,
  STRICTNESS_PRESETS,
  WEIGHT_PRESETS,
  type StrictnessKey,
  type WeightPresetKey,
} from "@/lib/scoreLabel";

export interface JobPayload {
  title: string;
  jd_text: string;
  required_skills: string[];
  level: JobLevel;
  work_mode: WorkMode;
  min_years_experience: number | null;
  allowed_locations: string[];
  max_notice_period_days: number | null;
  salary_band_min: number | null;
  salary_band_max: number | null;
  approve_threshold: number;
  decline_threshold: number;
  weight_skills: number;
  weight_experience: number;
  weight_education: number;
  weight_certifications: number;
  require_desktop_probe: boolean;
}

interface SuggestResponse {
  jd_text: string;
  required_skills: string[];
}

function matchingStrictness(approve: number, decline: number): StrictnessKey {
  const match = Object.entries(STRICTNESS_PRESETS).find(
    ([, preset]) => preset.approve === approve && preset.decline === decline
  );
  return (match?.[0] as StrictnessKey) ?? "custom";
}

function matchingWeightPreset(
  skills: number,
  experience: number,
  education: number,
  certifications: number
): WeightPresetKey {
  const match = Object.entries(WEIGHT_PRESETS).find(
    ([, preset]) =>
      Math.abs(preset.skills - skills) < 0.001 &&
      Math.abs(preset.experience - experience) < 0.001 &&
      Math.abs(preset.education - education) < 0.001 &&
      Math.abs(preset.certifications - certifications) < 0.001
  );
  return (match?.[0] as WeightPresetKey) ?? "custom";
}

/** Relative sliders, not percentages HR has to hand-balance — always scaled to sum to 1.0
 * before being sent to the API, so it's never possible to submit an invalid combination. */
function normalizeWeights(skills: number, experience: number, education: number, certifications: number) {
  const total = skills + experience + education + certifications;
  if (total <= 0) {
    return { weight_skills: 0.25, weight_experience: 0.25, weight_education: 0.25, weight_certifications: 0.25 };
  }
  return {
    weight_skills: skills / total,
    weight_experience: experience / total,
    weight_education: education / total,
    weight_certifications: certifications / total,
  };
}

function formatNormalizedWeights(
  skills: number,
  experience: number,
  education: number,
  certifications: number
): string {
  const w = normalizeWeights(skills, experience, education, certifications);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    `Skills ${pct(w.weight_skills)} · Experience ${pct(w.weight_experience)} · ` +
    `Education ${pct(w.weight_education)} · Certifications ${pct(w.weight_certifications)}`
  );
}

export default function JobForm({
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  defaultValues?: Job;
  onSubmit: (payload: JobPayload) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const [title, setTitle] = useState(defaultValues?.title ?? "");
  const [jdText, setJdText] = useState(defaultValues?.jd_text ?? "");
  const [requiredSkills, setRequiredSkills] = useState(
    (defaultValues?.required_skills ?? []).join(", ")
  );
  const [level, setLevel] = useState<JobLevel>(defaultValues?.level ?? "experienced");
  const [workMode, setWorkMode] = useState<WorkMode>(defaultValues?.work_mode ?? "onsite");
  const [minYears, setMinYears] = useState(
    defaultValues?.min_years_experience != null ? String(defaultValues.min_years_experience) : ""
  );
  const [allowedLocations, setAllowedLocations] = useState(
    (defaultValues?.allowed_locations ?? []).join(", ")
  );
  const [maxNoticeDays, setMaxNoticeDays] = useState(
    defaultValues?.max_notice_period_days != null ? String(defaultValues.max_notice_period_days) : ""
  );
  const [salaryMin, setSalaryMin] = useState(
    defaultValues?.salary_band_min != null ? String(defaultValues.salary_band_min) : ""
  );
  const [salaryMax, setSalaryMax] = useState(
    defaultValues?.salary_band_max != null ? String(defaultValues.salary_band_max) : ""
  );
  const [weightSkills, setWeightSkills] = useState(defaultValues?.weight_skills ?? 0.25);
  const [weightExperience, setWeightExperience] = useState(defaultValues?.weight_experience ?? 0.25);
  const [weightEducation, setWeightEducation] = useState(defaultValues?.weight_education ?? 0.25);
  const [weightCertifications, setWeightCertifications] = useState(
    defaultValues?.weight_certifications ?? 0.25
  );
  const [weightPreset, setWeightPreset] = useState<WeightPresetKey>(
    defaultValues
      ? matchingWeightPreset(
          defaultValues.weight_skills,
          defaultValues.weight_experience,
          defaultValues.weight_education,
          defaultValues.weight_certifications
        )
      : "balanced"
  );
  const [requireDesktopProbe, setRequireDesktopProbe] = useState(
    defaultValues?.require_desktop_probe ?? false
  );
  const [strictness, setStrictness] = useState<StrictnessKey>(
    defaultValues
      ? matchingStrictness(defaultValues.approve_threshold, defaultValues.decline_threshold)
      : "balanced"
  );
  const [approveThreshold, setApproveThreshold] = useState<number>(
    defaultValues?.approve_threshold ?? STRICTNESS_PRESETS.balanced.approve
  );
  const [declineThreshold, setDeclineThreshold] = useState<number>(
    defaultValues?.decline_threshold ?? STRICTNESS_PRESETS.balanced.decline
  );

  function handleStrictnessChange(key: StrictnessKey) {
    setStrictness(key);
    if (key !== "custom") {
      setApproveThreshold(STRICTNESS_PRESETS[key].approve);
      setDeclineThreshold(STRICTNESS_PRESETS[key].decline);
    }
  }

  function handleWeightPresetChange(key: WeightPresetKey) {
    setWeightPreset(key);
    if (key !== "custom") {
      const preset = WEIGHT_PRESETS[key];
      setWeightSkills(preset.skills);
      setWeightExperience(preset.experience);
      setWeightEducation(preset.education);
      setWeightCertifications(preset.certifications);
    }
  }

  async function handleSuggest() {
    if (!title.trim()) {
      setError("Enter a job title first — the suggestion is built from it.");
      return;
    }
    setError(null);
    setSuggesting(true);
    try {
      const result = await postJson<SuggestResponse>("/jobs/suggest", {
        title,
        draft_jd_text: jdText.trim() || null,
      });
      setJdText(result.jd_text);
      setRequiredSkills(result.required_skills.join(", "));
    } catch {
      setError("Could not generate a suggestion right now — try again in a moment.");
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        title,
        jd_text: jdText,
        required_skills: splitList(requiredSkills),
        level,
        work_mode: workMode,
        min_years_experience: minYears ? Number(minYears) : null,
        allowed_locations: splitList(allowedLocations),
        max_notice_period_days: maxNoticeDays ? Number(maxNoticeDays) : null,
        salary_band_min: salaryMin ? Number(salaryMin) : null,
        salary_band_max: salaryMax ? Number(salaryMax) : null,
        approve_threshold: approveThreshold,
        decline_threshold: declineThreshold,
        ...normalizeWeights(weightSkills, weightExperience, weightEducation, weightCertifications),
        require_desktop_probe: requireDesktopProbe,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save job");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field label="Title">
        <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
      </Field>

      <Field label="Job description">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-zinc-500">
            Paste your own JD, or leave blank and let AI draft one from the title.
          </span>
          <button
            type="button"
            onClick={handleSuggest}
            disabled={suggesting}
            className="btn-outline text-xs px-2 py-1 disabled:opacity-40"
          >
            {suggesting ? "Thinking…" : jdText.trim() ? "Improve with AI" : "Suggest with AI"}
          </button>
        </div>
        <textarea
          required
          rows={6}
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          className="input"
          placeholder="Paste the JD here — this is what candidates are scored against."
        />
      </Field>

      <Field label="Required skills (comma-separated)">
        <input
          value={requiredSkills}
          onChange={(e) => setRequiredSkills(e.target.value)}
          className="input"
          placeholder="Python, AWS, PostgreSQL"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Level">
          <select value={level} onChange={(e) => setLevel(e.target.value as JobLevel)} className="input">
            <option value="experienced">Experienced</option>
            <option value="fresher">Fresher / entry-level</option>
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            Freshers are scored on education, projects and internships instead of work history.
          </p>
        </Field>
        <Field label="Work mode">
          <select
            value={workMode}
            onChange={(e) => setWorkMode(e.target.value as WorkMode)}
            className="input"
          >
            <option value="onsite">On-site</option>
            <option value="hybrid">Hybrid</option>
            <option value="remote">Remote</option>
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            Remote roles skip the location eligibility check below entirely.
          </p>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Min years experience (eligibility requirement)">
          <input
            type="number"
            min={0}
            value={minYears}
            onChange={(e) => setMinYears(e.target.value)}
            className="input"
            placeholder="Leave blank to skip"
          />
        </Field>
        <Field label="Allowed locations (eligibility requirement)">
          <input
            value={allowedLocations}
            onChange={(e) => setAllowedLocations(e.target.value)}
            className="input"
            placeholder="Bangalore, Chennai"
          />
        </Field>
        <Field label="Max notice period, days (eligibility requirement)">
          <input
            type="number"
            min={0}
            value={maxNoticeDays}
            onChange={(e) => setMaxNoticeDays(e.target.value)}
            className="input"
            placeholder="Leave blank to skip"
          />
        </Field>
        <Field label="Salary band (eligibility requirement on max)">
          <div className="flex gap-2">
            <input
              type="number"
              min={0}
              value={salaryMin}
              onChange={(e) => setSalaryMin(e.target.value)}
              className="input"
              placeholder="Min"
            />
            <input
              type="number"
              min={0}
              value={salaryMax}
              onChange={(e) => setSalaryMax(e.target.value)}
              className="input"
              placeholder="Max"
            />
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Candidates whose expected salary is above the max are knocked out. Notice
            period/salary rarely appear on a resume itself — HR usually fills these in from a
            screening call.
          </p>
        </Field>
      </div>

      <Field label="Fit-score priorities">
        <select
          value={weightPreset}
          onChange={(e) => handleWeightPresetChange(e.target.value as WeightPresetKey)}
          className="input"
        >
          {Object.entries(WEIGHT_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom (advanced)</option>
        </select>

        {weightPreset === "custom" ? (
          <div className="mt-3 space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3">
            <div className="grid grid-cols-2 gap-3">
              <WeightField label="Skills" value={weightSkills} onChange={setWeightSkills} />
              <WeightField label="Experience" value={weightExperience} onChange={setWeightExperience} />
              <WeightField label="Education" value={weightEducation} onChange={setWeightEducation} />
              <WeightField
                label="Certifications"
                value={weightCertifications}
                onChange={setWeightCertifications}
              />
            </div>
            <p className="text-xs text-zinc-600">
              These are relative — no need to make them add up to anything. They&apos;re scaled
              automatically when you save. Right now that works out to:{" "}
              {formatNormalizedWeights(weightSkills, weightExperience, weightEducation, weightCertifications)}.
            </p>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 mt-1">
            The AI scores skills, experience, education, and certifications separately, then
            combines them using this priority to produce the one overall fit score shown on each
            candidate.
          </p>
        )}
      </Field>

      <Field label="Desktop integrity monitor">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireDesktopProbe}
            onChange={(e) => setRequireDesktopProbe(e.target.checked)}
          />
          Require the desktop probe (background-app/external-display monitor) before the
          candidate can start this role&apos;s interview
        </label>
        <p className="text-xs text-zinc-500 mt-1">
          Only enable this where candidates can realistically install/run it — it will block
          candidates on locked-down corporate laptops with no admin rights.
        </p>
      </Field>

      <Field label="Screening strictness">
        <select
          value={strictness}
          onChange={(e) => handleStrictnessChange(e.target.value as StrictnessKey)}
          className="input"
        >
          {Object.entries(STRICTNESS_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>

        {strictness === "custom" ? (
          <div className="mt-3 space-y-4 rounded-md border border-blue-200 bg-blue-50 p-3">
            <SliderField
              label="Auto-approve candidates who are at least a…"
              value={approveThreshold}
              onChange={setApproveThreshold}
            />
            <SliderField
              label="Auto-decline candidates who are below a…"
              value={declineThreshold}
              onChange={setDeclineThreshold}
            />
            <p className="text-xs text-zinc-600">
              Everyone in between lands in Review for a human to look at.
            </p>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 mt-1">
            Candidates rated <strong>{getScoreLabel(approveThreshold)}</strong> or better go
            straight to Approved. Below <strong>{getScoreLabel(declineThreshold)}</strong> go to
            Declined. Everyone else lands in Review for a human to look at.
          </p>
        )}
      </Field>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-outline">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
    </label>
  );
}

function WeightField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-medium mb-1">
        <span>{label}</span>
        <span className="text-blue-800">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  );
}

function SliderField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-medium mb-1">
        <span>{label}</span>
        <span className="text-blue-800">
          {getScoreLabel(value)} ({value})
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  );
}
