"use client";

import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/api";
import type { InterviewSession } from "@/lib/types";

export default function NewInterviewPage() {
  const [candidateName, setCandidateName] = useState("");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const created = await postJson<InterviewSession>("/interviews", {
        candidate_name: candidateName,
      });
      setSession(created);
    } finally {
      setSubmitting(false);
    }
  }

  const joinUrl =
    session && typeof window !== "undefined"
      ? `${window.location.origin}/interview/${session.join_token}`
      : null;
  const interviewerUrl =
    session && typeof window !== "undefined"
      ? `${window.location.origin}/interview/interviewer/${session.interviewer_join_token}`
      : null;

  return (
    <div className="max-w-md mx-auto w-full px-6 py-8 space-y-5">
      <h1 className="text-xl font-semibold">Schedule an interview</h1>

      {!session && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="block text-sm font-medium mb-1">Candidate name</span>
            <input
              required
              value={candidateName}
              onChange={(e) => setCandidateName(e.target.value)}
              className="input"
            />
          </label>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? "Creating…" : "Create join link"}
          </button>
        </form>
      )}

      {session && joinUrl && (
        <div className="border border-zinc-200 rounded-md p-4 space-y-2">
          <p className="text-sm text-zinc-600">
            Share this link with {session.candidate_name}. No account required.
          </p>
          <input readOnly value={joinUrl} className="input text-xs" onFocus={(e) => e.target.select()} />
        </div>
      )}

      {session && interviewerUrl && (
        <div className="border border-purple-200 bg-purple-50 rounded-md p-4 space-y-2">
          <p className="text-sm text-zinc-600">
            Send this second link to whoever is <strong>conducting</strong> the interview.
            Opening it and clicking Start records their side of the conversation, so
            questions and answers can be cross-checked afterward.
          </p>
          <input
            readOnly
            value={interviewerUrl}
            className="input text-xs"
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}
    </div>
  );
}
