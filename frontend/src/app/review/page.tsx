"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { deleteJson, getJson } from "@/lib/api";
import { getIntegrityScoreBand } from "@/lib/integrityLabel";
import { useDialog } from "@/components/Dialog";
import type { InterviewSession } from "@/lib/types";

export default function ReviewQueuePage() {
  const { confirm, notify } = useDialog();
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const refresh = useCallback(() => {
    getJson<InterviewSession[]>("/interviews/review/queue")
      .then(setSessions)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    getJson<{ is_admin: boolean }>("/auth/me")
      .then((me) => setIsAdmin(me.is_admin))
      .catch(() => {});
  }, [refresh]);

  async function handleDelete(session: InterviewSession) {
    const ok = await confirm({
      title: "Delete interview session",
      description:
        `Permanently delete ${session.candidate_name}'s interview session? This removes the ` +
        `recording, transcript, and every flagged moment for good. This cannot be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteJson(`/interviews/${session.id}`, {});
      refresh();
    } catch (err) {
      await notify({
        title: "Could not delete session",
        description: err instanceof Error ? err.message : "Could not delete this session.",
      });
    }
  }

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-8 space-y-6">
      <h1 className="text-xl font-semibold">Review queue</h1>
      <p className="text-sm text-zinc-500">
        Sessions flagged by the integrity score. Nothing here has been auto-rejected — every
        session needs a human decision.
      </p>

      {loading && <p className="text-zinc-500 text-sm">Loading…</p>}
      {!loading && sessions.length === 0 && (
        <p className="text-zinc-500 text-sm">Nothing needs review right now.</p>
      )}

      <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-md">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50">
            <Link href={`/review/${s.id}`} className="flex-1 min-w-0">
              <p className="font-medium">{s.candidate_name}</p>
              <p className="text-xs text-zinc-500">Status: {s.status}</p>
            </Link>
            <span className="flex items-center gap-3 shrink-0">
              {s.integrity_score !== null ? (
                <span
                  className={`text-xs ${getIntegrityScoreBand(s.integrity_score).badgeClass}`}
                >
                  {getIntegrityScoreBand(s.integrity_score).label}
                </span>
              ) : (
                <span className="text-sm text-zinc-400">—</span>
              )}
              {isAdmin && (
                <button
                  onClick={() => handleDelete(s)}
                  className="btn-danger-outline text-xs px-2 py-1"
                >
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
