"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deleteJson, getJson, patchJson, postForm, postJson } from "@/lib/api";
import JobForm, { type JobPayload } from "@/components/JobForm";
import CampusBulkUploader from "@/components/CampusBulkUploader";
import { useDialog } from "@/components/Dialog";
import type { Bucket, Candidate, Job } from "@/lib/types";

const BUCKET_LABELS: Record<Bucket, string> = {
  approved: "Approved",
  review: "Review",
  declined: "Declined",
};

const BUCKET_COLORS: Record<Bucket, string> = {
  approved: "bucket-approved",
  review: "bucket-review",
  declined: "bucket-declined",
};

// Mirrors the backend's comparison_max_candidates default (core/config.py). The backend is the
// hard enforcer; this only drives the UI's "deselect some" feedback before a request is made.
const COMPARE_MAX = 10;

export default function JobDetailPage() {
  const { prompt } = useDialog();
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadSource, setUploadSource] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [isCampusBulkOpen, setIsCampusBulkOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function startComparison() {
    const ids = Array.from(selected);
    if (ids.length < 2 || ids.length > COMPARE_MAX) return;
    router.push(`/jobs/${jobId}/compare?ids=${ids.join(",")}`);
  }

  const refresh = useCallback(() => {
    getJson<Job>(`/jobs/${jobId}`)
      .then(setJob)
      .catch(() => setNotFound(true));
    getJson<Candidate[]>(`/jobs/${jobId}/candidates`)
      .then(setCandidates)
      .catch(() => {});
  }, [jobId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleUpload() {
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) return;

    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    if (uploadSource.trim()) form.append("source", uploadSource.trim());

    setUploading(true);
    try {
      await postForm(`/jobs/${jobId}/resumes`, form);
      if (fileInputRef.current) fileInputRef.current.value = "";
      refresh();
    } finally {
      setUploading(false);
    }
  }

  async function handleUnarchive(candidateId: string) {
    await postJson(`/candidates/${candidateId}/unarchive`, {});
    refresh();
  }

  async function handleHardDelete(candidateId: string, name: string) {
    const reason = await prompt({
      title: "Delete permanently",
      description:
        `Permanently delete ${name}? This cannot be undone — the resume, AI score, and ` +
        `history will be gone for good. Enter a reason for the audit log to proceed:`,
      placeholder: "Reason for deletion",
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!reason) return;

    await deleteJson(`/candidates/${candidateId}`, { reason });
    refresh();
  }

  async function handleUpdateJob(payload: JobPayload) {
    const updated = await patchJson<Job>(`/jobs/${jobId}`, payload);
    setJob(updated);
    setEditing(false);
  }

  if (notFound) {
    return (
      <div className="max-w-lg mx-auto w-full px-6 py-8 text-center space-y-3">
        <p className="text-zinc-700">This job no longer exists.</p>
        <Link href="/jobs" className="btn-outline inline-flex">
          Back to jobs
        </Link>
      </div>
    );
  }
  if (!job) return <p className="p-6 text-zinc-500">Loading…</p>;

  const buckets: Bucket[] = ["approved", "review", "declined"];

  return (
    <div className="max-w-6xl mx-auto w-full px-6 py-8 space-y-8">
      {editing ? (
        <div className="border border-zinc-200 rounded-md p-4">
          <h2 className="font-medium mb-1">Edit job</h2>
          <p className="text-xs text-zinc-500 mb-4">
            Changes only apply to future scoring — candidates already uploaded keep their
            existing scores and won&apos;t be automatically re-evaluated.
          </p>
          <JobForm
            defaultValues={job}
            onSubmit={handleUpdateJob}
            onCancel={() => setEditing(false)}
            submitLabel="Save changes"
          />
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">{job.title}</h1>
            <p className="text-sm text-zinc-500">
              {job.level} · {job.work_mode} · required: {job.required_skills.join(", ") || "—"}
            </p>
          </div>
          <button onClick={() => setEditing(true)} className="btn-outline">
            Edit job
          </button>
        </div>
      )}

      <div className="border border-zinc-200 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap bg-zinc-50/50">
        <div className="flex items-center gap-3 flex-wrap">
          <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx" />
          <input
            value={uploadSource}
            onChange={(e) => setUploadSource(e.target.value)}
            placeholder="Source (optional): referral, LinkedIn…"
            className="input w-56 bg-surface"
          />
          <button onClick={handleUpload} disabled={uploading} className="btn-primary">
            {uploading ? "Processing…" : "Upload resumes"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {!selectMode ? (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="btn-outline text-xs font-semibold px-3 py-2"
            >
              ⚖️ Compare candidates
            </button>
          ) : (
            <button
              type="button"
              onClick={exitSelectMode}
              className="btn-outline text-xs font-semibold px-3 py-2"
            >
              Cancel compare
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsCampusBulkOpen(true)}
            className="btn-outline border-indigo-300 text-indigo-800 bg-indigo-50/60 hover:bg-indigo-100 flex items-center gap-1.5 text-xs font-semibold px-3 py-2"
          >
            🎓 Campus Bulk Drive Screening
          </button>
        </div>
      </div>

      {selectMode && (
        <div className="sticky top-0 z-10 border border-blue-300 bg-blue-50 rounded-md p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-blue-900">
            <span className="font-semibold">{selected.size}</span> selected
            {selected.size > COMPARE_MAX && (
              <span className="text-red-700 ml-2">
                — too many. Compare up to {COMPARE_MAX} at once; deselect {selected.size - COMPARE_MAX}.
              </span>
            )}
            {selected.size < 2 && (
              <span className="text-blue-700 ml-2">— pick at least 2 candidates to compare.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="btn-outline text-xs px-2 py-1">
                Clear
              </button>
            )}
            <button
              onClick={startComparison}
              disabled={selected.size < 2 || selected.size > COMPARE_MAX}
              className="btn-primary text-xs px-3 py-1.5"
            >
              Compare {selected.size >= 2 && selected.size <= COMPARE_MAX ? `(${selected.size})` : ""}
            </button>
          </div>
        </div>
      )}

      <CampusBulkUploader
        jobId={jobId}
        isOpen={isCampusBulkOpen}
        onClose={() => setIsCampusBulkOpen(false)}
        onBatchComplete={refresh}
      />

      {candidates.some((c) => c.processing_failed) && (
        <div className="border border-amber-300 bg-amber-50 rounded-md p-3">
          <h2 className="font-medium text-sm text-amber-900 mb-2">
            Needs attention — failed to process ({candidates.filter((c) => c.processing_failed).length})
          </h2>
          <ul className="space-y-1 text-sm text-amber-900">
            {candidates
              .filter((c) => c.processing_failed)
              .map((c) => (
                <li key={c.id}>
                  {c.full_name ?? c.email ?? c.id}
                  {c.processing_error && (
                    <span className="text-xs text-amber-700"> — {c.processing_error}</span>
                  )}
                </li>
              ))}
          </ul>
          <p className="text-xs text-amber-700 mt-2">
            These resumes were never scored — fix the underlying issue (e.g. a missing API key)
            and re-upload them.
          </p>
        </div>
      )}

      {/* flex + overflow-x-auto with a min-width per column, not a rigid 3-col grid — keeps
          each column comfortably wide instead of squeezing three into too little space. */}
      <div className="flex gap-4 overflow-x-auto pb-2">
        {buckets.map((bucket) => {
          const inBucket = candidates.filter(
            (c) => (c.override_bucket ?? c.bucket) === bucket && !c.is_duplicate_of && !c.archived
          );
          return (
            <div
              key={bucket}
              className={`border rounded-md p-3 min-w-[300px] flex-1 ${BUCKET_COLORS[bucket]}`}
            >
              <h2 className="font-medium mb-2">
                {BUCKET_LABELS[bucket]} ({inBucket.length})
              </h2>
              <div className="space-y-2">
                {inBucket.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    selectMode={selectMode}
                    selected={selected.has(c.id)}
                    onToggle={toggleSelected}
                  />
                ))}
                {inBucket.length === 0 && (
                  <p className="text-xs opacity-60">No candidates here yet.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {candidates.some((c) => c.is_duplicate_of) && (
        <div>
          <h2 className="font-medium text-sm text-zinc-600 mb-2">
            Duplicates (excluded from buckets)
          </h2>
          <ul className="text-sm text-zinc-500 space-y-1">
            {candidates
              .filter((c) => c.is_duplicate_of)
              .map((c) => (
                <li key={c.id}>{c.full_name ?? c.email ?? c.id} — duplicate resume</li>
              ))}
          </ul>
        </div>
      )}

      {candidates.some((c) => c.archived) && (
        <div>
          <h2 className="font-medium text-sm text-zinc-600 mb-2">
            Archived ({candidates.filter((c) => c.archived).length})
          </h2>
          <ul className="space-y-1 text-sm text-zinc-500">
            {candidates
              .filter((c) => c.archived)
              .map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <Link href={`/candidates/${c.id}`} className="hover:underline">
                    {c.full_name ?? c.email ?? c.id}
                    {c.archived_reason && ` — ${c.archived_reason}`}
                  </Link>
                  <span className="flex gap-2 shrink-0">
                    <button onClick={() => handleUnarchive(c.id)} className="btn-outline text-xs px-2 py-1">
                      Unarchive
                    </button>
                    <button
                      onClick={() => handleHardDelete(c.id, c.full_name ?? c.email ?? "this candidate")}
                      className="btn-danger-outline text-xs px-2 py-1"
                    >
                      Delete permanently
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  selectMode,
  selected,
  onToggle,
}: {
  candidate: Candidate;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const effectiveBucket = candidate.override_bucket ?? candidate.bucket;

  const cardBody = (
    <>
      <div className="flex justify-between items-start">
        <span className="font-medium text-zinc-900 leading-tight">
          {candidate.full_name ?? candidate.email ?? "Unnamed candidate"}
        </span>
        <span className="text-xs font-semibold text-zinc-700 bg-zinc-100 px-1.5 py-0.5 rounded shrink-0 ml-2">
          {candidate.fit_score !== null ? `${candidate.fit_score.toFixed(0)}/100` : "—"}
        </span>
      </div>

      {(candidate.technical_score !== null || candidate.communication_score !== null) && (
        <div className="flex items-center gap-1.5 text-[11px]">
          {candidate.technical_score !== null && (
            <span className="bg-blue-50 text-blue-800 border border-blue-200 px-1.5 py-0.5 rounded font-medium">
              Tech: {candidate.technical_score.toFixed(0)}
            </span>
          )}
          {candidate.communication_score !== null && (
            <span className="bg-purple-50 text-purple-800 border border-purple-200 px-1.5 py-0.5 rounded font-medium">
              Comm: {candidate.communication_score.toFixed(0)}
            </span>
          )}
        </div>
      )}

      {candidate.skills_breakdown && candidate.skills_breakdown.relevant_skills.length > 0 && (
        <div className="text-[11px] text-emerald-700 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span>{candidate.skills_breakdown.relevant_skills.length} matched skills</span>
          {candidate.skills_breakdown.missing_critical_skills.length > 0 && (
            <span className="text-amber-700 ml-1">
              · {candidate.skills_breakdown.missing_critical_skills.length} missing
            </span>
          )}
        </div>
      )}

      {candidate.profession_fit && candidate.profession_fit.verdict && (
        <div className="text-[10px] text-zinc-500 capitalize">
          Role: <span className="font-medium text-zinc-700">{candidate.profession_fit.verdict}</span>
          {candidate.profession_fit.seniority_match && ` · ${candidate.profession_fit.seniority_match}`}
        </div>
      )}

      {candidate.override_bucket && (
        <p className="text-xs text-zinc-500">Overridden to {effectiveBucket}</p>
      )}
    </>
  );

  // In compare mode the whole card is a selection toggle, not a navigation link — so a
  // recruiter building a comparison set never accidentally leaves the pipeline.
  if (selectMode) {
    return (
      <button
        type="button"
        onClick={() => onToggle(candidate.id)}
        aria-pressed={selected}
        className={`w-full text-left bg-surface border rounded-md p-2.5 text-sm transition space-y-1.5 flex gap-2 ${
          selected ? "border-blue-500 ring-1 ring-blue-400" : "border-zinc-200 hover:border-zinc-300"
        }`}
      >
        <input
          type="checkbox"
          checked={selected}
          readOnly
          tabIndex={-1}
          className="mt-0.5 shrink-0 pointer-events-none"
        />
        <div className="flex-1 space-y-1.5">{cardBody}</div>
      </button>
    );
  }

  return (
    <Link
      href={`/candidates/${candidate.id}`}
      className="block bg-surface border border-zinc-200 rounded-md p-2.5 text-sm hover:border-zinc-300 hover:shadow-sm transition space-y-1.5"
    >
      {cardBody}
    </Link>
  );
}
