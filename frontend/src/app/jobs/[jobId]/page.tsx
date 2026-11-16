"use client";

import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import Link from "next/link";
import { deleteJson, getJson, patchJson, postForm, postJson } from "@/lib/api";
import { getScoreLabel } from "@/lib/scoreLabel";
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

// What the backend can actually read (services/text_extract.py reads .pdf and .docx, and
// nothing else). The file picker enforces this through its `accept` attribute, but a drop
// bypasses `accept` entirely — so dropped files are filtered against the same list here.
// Without it a .doc or a screenshot reaches the server and comes back as a card in the
// "failed to process" panel, far from the moment the mistake was made.
const ACCEPTED_RESUME_EXTENSIONS = [".pdf", ".docx"];

function isAcceptedResume(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_RESUME_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Identity for de-duping a selection. Dropping the same batch twice is an easy slip, and
 * each copy would otherwise upload and score separately — then show up as a duplicate the
 * reviewer has to deal with. */
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export default function JobDetailPage() {
  const { confirm, prompt, notify } = useDialog();
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadSource, setUploadSource] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [isCampusBulkOpen, setIsCampusBulkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [rejectedCount, setRejectedCount] = useState(0);
  // dragenter/dragleave also fire as the pointer crosses child elements, so a plain
  // boolean makes the highlight flicker whenever the cursor passes over the text inside
  // the zone. Counting enters against leaves is what actually tracks "still inside".
  const dragDepth = useRef(0);

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

  // A file dropped anywhere other than the zone would otherwise be opened by the browser,
  // navigating away from a page that may have a batch staged on it. Swallowing the default
  // outside the zone makes a near miss do nothing instead.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const picked = Array.from(incoming);
    const accepted = picked.filter(isAcceptedResume);
    setRejectedCount(picked.length - accepted.length);
    setSelectedFiles((current) => {
      const seen = new Set(current.map(fileKey));
      return [...current, ...accepted.filter((f) => !seen.has(fileKey(f)))];
    });
  }, []);

  function clearSelection() {
    setSelectedFiles([]);
    setRejectedCount(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDragEnter(e: ReactDragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function handleDragLeave(e: ReactDragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }

  function handleDrop(e: ReactDragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return;

    const form = new FormData();
    selectedFiles.forEach((f) => form.append("files", f));
    if (uploadSource.trim()) form.append("source", uploadSource.trim());

    setUploading(true);
    try {
      const uploaded = await postForm<Candidate[]>(`/jobs/${jobId}/resumes`, form);
      clearSelection();
      refresh();

      // Duplicates are skipped rather than scored, and they land in a collapsed list
      // further down the page — easy to miss when you've just uploaded a batch and are
      // looking at the buckets. Say so directly instead.
      const duplicates = uploaded.filter((c) => c.is_duplicate_of);
      if (duplicates.length > 0) {
        const names = duplicates
          .map((c) => c.full_name || c.email || "Unnamed candidate")
          .join(", ");
        await notify({
          title:
            duplicates.length === 1
              ? "Duplicate resume skipped"
              : `${duplicates.length} duplicate resumes skipped`,
          description:
            `${names} ${duplicates.length === 1 ? "is" : "are"} already on this job — ` +
            `matched on email address, mobile number or name. ` +
            `${duplicates.length === 1 ? "This resume was" : "These resumes were"} not ` +
            `scored again, and can be found under "Duplicates" below the candidate buckets.`,
        });
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteJob() {
    if (!job) return;
    const ok = await confirm({
      title: "Delete job",
      description:
        `Permanently delete "${job.title}"? This also permanently deletes every candidate ` +
        `attached to this job — their resumes, AI scores, and interview history all go ` +
        `with it. This cannot be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteJson(`/jobs/${jobId}`, { reason: "Deleted from the job page" });
      router.push("/jobs");
    } catch (err) {
      await notify({
        title: "Could not delete job",
        description: err instanceof Error ? err.message : "Could not delete this job.",
      });
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
          <span className="flex gap-2 shrink-0">
            <button onClick={() => setEditing(true)} className="btn-outline">
              Edit job
            </button>
            <button
              onClick={handleDeleteJob}
              className="btn-danger-outline"
              title="Permanently delete this job and all of its candidates"
            >
              Delete job
            </button>
          </span>
        </div>
      )}

      <div className="border border-zinc-200 rounded-md p-4 space-y-3 bg-zinc-50/50">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 flex-wrap">
            {/* The real input still does the picking; the zone below is its trigger and
              * its drop target. tabIndex -1 keeps this out of the tab order, since an
              * invisible focus stop reads as the focus ring vanishing — the button is the
              * keyboard path to the same dialog. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx"
              tabIndex={-1}
              className="sr-only"
              onChange={(e) => {
                addFiles(e.target.files);
                // Clearing it lets the same file be picked again after being removed from
                // the list: left as-is the input still holds it, and choosing it a second
                // time fires no change event at all.
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={(e) => {
                // Without preventDefault here the element is not a valid drop target and
                // the drop never fires at all.
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              className={`flex min-w-[19rem] flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-2.5 text-center transition-colors ${
                isDragging
                  ? "border-blue-500 bg-blue-50 text-blue-900"
                  : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50"
              }`}
            >
              <span className="text-sm font-medium">
                {isDragging ? "Drop to add them" : "Drag & drop resumes here"}
              </span>
              <span className="mt-0.5 text-xs text-zinc-500">
                or click to browse — PDF or DOCX
              </span>
            </button>
            <input
              value={uploadSource}
              onChange={(e) => setUploadSource(e.target.value)}
              placeholder="Source (optional): referral, LinkedIn…"
              className="input w-56 bg-white"
            />
            <button
              onClick={handleUpload}
              disabled={uploading || selectedFiles.length === 0}
              className="btn-primary disabled:opacity-40"
            >
              {uploading
                ? "Processing…"
                : selectedFiles.length > 0
                  ? `Upload ${selectedFiles.length} resume${selectedFiles.length === 1 ? "" : "s"}`
                  : "Upload resumes"}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsCampusBulkOpen(true)}
            className="btn-outline border-indigo-300 text-indigo-800 bg-indigo-50/60 hover:bg-indigo-100 flex items-center gap-1.5 text-xs font-semibold px-3 py-2"
          >
            🎓 Campus Bulk Drive Screening
          </button>
        </div>

        {rejectedCount > 0 && (
          <p className="text-xs text-amber-700">
            {rejectedCount} file{rejectedCount === 1 ? " was" : "s were"} left out — only
            PDF and DOCX can be read.
          </p>
        )}

        {selectedFiles.length > 0 && (
          <div className="rounded-md border border-zinc-200 bg-white p-2">
            <div className="flex items-center justify-between px-1 pb-1.5">
              <span className="text-xs font-semibold text-zinc-700">
                {selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} ready to
                upload
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-zinc-500 underline hover:text-red-600"
              >
                Clear all
              </button>
            </div>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto">
              {selectedFiles.map((file) => (
                <li
                  key={fileKey(file)}
                  className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs hover:bg-zinc-50"
                >
                  <span className="truncate text-zinc-700">{file.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedFiles((current) =>
                        current.filter((f) => fileKey(f) !== fileKey(file))
                      )
                    }
                    className="shrink-0 text-zinc-400 hover:text-red-600"
                    aria-label={`Remove ${file.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

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
      className="block bg-white border border-zinc-200 rounded-md p-2.5 text-sm hover:border-zinc-300 hover:shadow-sm transition space-y-1.5"
    >
      <div className="flex justify-between items-start">
        <span className="font-medium text-zinc-900 leading-tight">
          {candidate.full_name ?? candidate.email ?? "Unnamed candidate"}
        </span>
        <span className="text-xs font-semibold text-zinc-700 bg-zinc-100 px-1.5 py-0.5 rounded shrink-0 ml-2">
          {candidate.fit_score !== null
            ? `${candidate.fit_score.toFixed(0)}/100`
            : "—"}
        </span>
      </div>

      {/* Dual Score Badges */}
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

      {/* Skill & Profession chips summary */}
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
    </Link>
  );
}
