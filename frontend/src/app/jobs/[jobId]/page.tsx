"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deleteJson, getJson, patchJson, postForm, postJson } from "@/lib/api";
import { getScoreLabel } from "@/lib/scoreLabel";
import JobForm, { type JobPayload } from "@/components/JobForm";
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

export default function JobDetailPage() {
  const { prompt } = useDialog();
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadSource, setUploadSource] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

      <div className="border border-zinc-200 rounded-md p-4 flex items-center gap-3 flex-wrap">
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx" />
        <input
          value={uploadSource}
          onChange={(e) => setUploadSource(e.target.value)}
          placeholder="Source (optional): referral, LinkedIn…"
          className="input w-56"
        />
        <button onClick={handleUpload} disabled={uploading} className="btn-primary">
          {uploading ? "Processing…" : "Upload resumes"}
        </button>
        <span className="text-xs text-zinc-500">
          Each resume is parsed, deduped, checked against eligibility requirements, and
          scored automatically.
        </span>
      </div>

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
                  <CandidateCard key={c.id} candidate={c} />
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

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const effectiveBucket = candidate.override_bucket ?? candidate.bucket;

  return (
    <Link
      href={`/candidates/${candidate.id}`}
      className="block bg-white border border-zinc-200 rounded-md p-2 text-sm hover:border-zinc-300 hover:shadow-sm"
    >
      <div className="flex justify-between items-center">
        <span className="font-medium text-zinc-900">
          {candidate.full_name ?? candidate.email ?? "Unnamed candidate"}
        </span>
        <span className="text-xs text-zinc-500">
          {candidate.fit_score !== null
            ? `${getScoreLabel(candidate.fit_score)} (${candidate.fit_score.toFixed(0)})`
            : "—"}
        </span>
      </div>
      {candidate.override_bucket && (
        <p className="text-xs text-zinc-500 mt-1">Overridden to {effectiveBucket}</p>
      )}
    </Link>
  );
}
