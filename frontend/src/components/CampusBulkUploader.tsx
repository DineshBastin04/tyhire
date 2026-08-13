"use client";

import { useEffect, useRef, useState } from "react";
import { getJson, postForm } from "@/lib/api";
import type { BulkUploadBatch } from "@/lib/types";

interface CampusBulkUploaderProps {
  jobId: string;
  isOpen: boolean;
  onClose: () => void;
  onBatchComplete: () => void;
}

export default function CampusBulkUploader({
  jobId,
  isOpen,
  onClose,
  onBatchComplete,
}: CampusBulkUploaderProps) {
  const [activeTab, setActiveTab] = useState<"zip" | "csv">("zip");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvZipFile, setCsvZipFile] = useState<File | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BulkUploadBatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const zipInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvZipInputRef = useRef<HTMLInputElement>(null);

  // Polling for active background batch progress
  useEffect(() => {
    if (!activeBatchId) return;

    const interval = setInterval(async () => {
      try {
        const status = await getJson<BulkUploadBatch>(
          `/jobs/${jobId}/bulk-batches/${activeBatchId}`
        );
        setBatchStatus(status);

        if (status.status === "completed" || status.status === "failed") {
          clearInterval(interval);
          setSubmitting(false);
          onBatchComplete();
        }
      } catch (err) {
        console.error("Batch status poll failed:", err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeBatchId, jobId, onBatchComplete]);

  if (!isOpen) return null;

  async function handleZipSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!zipFile) {
      setError("Please select a ZIP archive of resumes.");
      return;
    }

    setError(null);
    setSubmitting(true);
    const form = new FormData();
    form.append("file", zipFile);

    try {
      const res = await postForm<{ batch_id: string }>(
        `/jobs/${jobId}/campus-bulk-zip`,
        form
      );
      setActiveBatchId(res.batch_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload ZIP archive.");
      setSubmitting(false);
    }
  }

  async function handleCsvSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!csvFile || !csvZipFile) {
      setError("Please select both a CSV roster and matching resumes ZIP file.");
      return;
    }

    setError(null);
    setSubmitting(true);
    const form = new FormData();
    form.append("csv_file", csvFile);
    form.append("resumes_zip", csvZipFile);

    try {
      const res = await postForm<{ batch_id: string }>(
        `/jobs/${jobId}/campus-csv-import`,
        form
      );
      setActiveBatchId(res.batch_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import CSV roster.");
      setSubmitting(false);
    }
  }

  function handleReset() {
    setZipFile(null);
    setCsvFile(null);
    setCsvZipFile(null);
    setActiveBatchId(null);
    setBatchStatus(null);
    setError(null);
    setSubmitting(false);
  }

  const progressPct =
    batchStatus && batchStatus.total_count > 0
      ? Math.min(
          100,
          Math.round(
            ((batchStatus.processed_count + batchStatus.failed_count) /
              batchStatus.total_count) *
              100
          )
        )
      : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full border border-zinc-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-4 border-b border-zinc-100 flex items-center justify-between bg-zinc-50/70">
          <div>
            <h3 className="font-semibold text-zinc-900 text-base flex items-center gap-2">
              🎓 Campus Interview Bulk Screening
            </h3>
            <p className="text-xs text-zinc-500">
              Bulk parse, filter by college cutoffs, and score hundreds of campus resumes.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700 text-lg p-1 rounded font-bold"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* Active Processing Progress Bar */}
          {activeBatchId && batchStatus ? (
            <div className="space-y-4 py-2">
              <div className="text-center space-y-1">
                <span
                  className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${
                    batchStatus.status === "completed"
                      ? "bg-emerald-100 text-emerald-800"
                      : batchStatus.status === "failed"
                      ? "bg-red-100 text-red-800"
                      : "bg-blue-100 text-blue-800 animate-pulse"
                  }`}
                >
                  {batchStatus.status === "completed"
                    ? "✓ Campus Screening Completed"
                    : batchStatus.status === "failed"
                    ? "Batch Failed"
                    : "⚡ Ingesting & Scoring Resumes in Background…"}
                </span>
                <p className="text-xs text-zinc-600">
                  Processed {batchStatus.processed_count + batchStatus.failed_count} of{" "}
                  {batchStatus.total_count} candidates
                </p>
              </div>

              {/* Animated Progress Bar */}
              <div className="w-full bg-zinc-100 rounded-full h-3.5 overflow-hidden border border-zinc-200 shadow-inner">
                <div
                  className={`h-full transition-all duration-300 rounded-full ${
                    batchStatus.status === "completed"
                      ? "bg-emerald-500"
                      : "bg-gradient-to-r from-blue-500 to-indigo-600"
                  }`}
                  style={{ width: `${progressPct}%` }}
                ></div>
              </div>

              <div className="flex justify-between text-xs text-zinc-500 px-1 font-medium">
                <span className="text-emerald-700">✓ Successful: {batchStatus.processed_count}</span>
                {batchStatus.failed_count > 0 && (
                  <span className="text-red-700">✗ Issues / Unmatched: {batchStatus.failed_count}</span>
                )}
                <span>{progressPct}% complete</span>
              </div>

              {/* Error Log Accordion if errors exist */}
              {batchStatus.error_log && batchStatus.error_log.length > 0 && (
                <div className="border border-red-200 bg-red-50/50 rounded-md p-3 text-xs space-y-1.5 max-h-40 overflow-y-auto">
                  <p className="font-semibold text-red-900">
                    Errors & Unmatched Files ({batchStatus.error_log.length}):
                  </p>
                  <ul className="space-y-1 text-red-800 text-[11px]">
                    {batchStatus.error_log.map((err, i) => (
                      <li key={i}>
                        {err.identifier && <strong className="mr-1">{err.identifier}:</strong>}
                        {err.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {batchStatus.status === "completed" && (
                <div className="pt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="btn-outline text-xs px-3 py-1.5"
                  >
                    Upload Another Batch
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="btn-primary text-xs px-4 py-1.5"
                  >
                    View Results on Board
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Tab Selector */}
              <div className="flex border-b border-zinc-200 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("zip");
                    setError(null);
                  }}
                  className={`px-4 py-2 font-medium border-b-2 transition ${
                    activeTab === "zip"
                      ? "border-blue-600 text-blue-700 font-semibold"
                      : "border-transparent text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  📁 Option 1: Direct Resumes ZIP
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("csv");
                    setError(null);
                  }}
                  className={`px-4 py-2 font-medium border-b-2 transition ${
                    activeTab === "csv"
                      ? "border-blue-600 text-blue-700 font-semibold"
                      : "border-transparent text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  📊 Option 2: College CSV Roster + ZIP
                </button>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-2.5 rounded">
                  {error}
                </div>
              )}

              {activeTab === "zip" ? (
                <form onSubmit={handleZipSubmit} className="space-y-4">
                  <div
                    onClick={() => zipInputRef.current?.click()}
                    className="border-2 border-dashed border-zinc-300 hover:border-blue-500 rounded-lg p-6 text-center cursor-pointer bg-zinc-50/50 hover:bg-blue-50/20 transition space-y-2"
                  >
                    <input
                      ref={zipInputRef}
                      type="file"
                      accept=".zip"
                      className="hidden"
                      onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                    />
                    <div className="text-3xl">🗜️</div>
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">
                        {zipFile ? zipFile.name : "Select ZIP file of Resumes"}
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {zipFile
                          ? `${(zipFile.size / (1024 * 1024)).toFixed(1)} MB`
                          : "Supports ZIP archives containing .pdf and .docx files"}
                      </p>
                    </div>
                  </div>

                  <p className="text-xs text-zinc-500">
                    💡 Resumes will be unpacked, checked against job knockout &amp; campus rules,
                    and scored asynchronously with a live progress bar.
                  </p>

                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={onClose} className="btn-outline text-xs px-3 py-1.5">
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!zipFile || submitting}
                      className="btn-primary text-xs px-4 py-1.5 disabled:opacity-50"
                    >
                      {submitting ? "Uploading ZIP…" : "Start Bulk Campus Screening"}
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleCsvSubmit} className="space-y-4">
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 mb-1">
                        1. College Placement CSV Roster
                      </label>
                      <input
                        ref={csvInputRef}
                        type="file"
                        accept=".csv"
                        onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                        className="input text-xs"
                      />
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        Columns supported: Roll No, Name, Email, Phone, CGPA, Branch, Batch Year, Backlogs, Resume Filename.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 mb-1">
                        2. Matching Resumes ZIP Archive
                      </label>
                      <input
                        ref={csvZipInputRef}
                        type="file"
                        accept=".zip"
                        onChange={(e) => setCsvZipFile(e.target.files?.[0] ?? null)}
                        className="input text-xs"
                      />
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        ZIP file containing the resumes matching the CSV roll numbers or filenames.
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={onClose} className="btn-outline text-xs px-3 py-1.5">
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!csvFile || !csvZipFile || submitting}
                      className="btn-primary text-xs px-4 py-1.5 disabled:opacity-50"
                    >
                      {submitting ? "Starting Ingestion…" : "Match & Screen Roster"}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
