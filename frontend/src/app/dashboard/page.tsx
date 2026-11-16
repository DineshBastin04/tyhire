"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getJson } from "@/lib/api";
import type { Bucket, DashboardSummary } from "@/lib/types";

// Short, dependency-free relative time ("2h ago") — the app ships no date library, and a
// dashboard only needs a coarse, human-readable recency, not precise formatting.
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function humanize(action: string): string {
  return action.replace(/_/g, " ");
}

function actorLabel(actor: string): string {
  return actor.startsWith("hr:") ? actor.slice(3) : actor;
}

const BUCKET_CLASS: Record<Bucket, string> = {
  approved: "badge-approved",
  review: "badge-review",
  declined: "badge-declined",
};

function StatCard({
  label,
  value,
  sub,
  href,
  attention = false,
}: {
  label: string;
  value: number;
  sub?: string;
  href?: string;
  attention?: boolean;
}) {
  const highlight = attention && value > 0;
  const body = (
    <div
      className={`rounded-md p-3 text-center h-full ${
        highlight ? "border border-blue-200 bg-blue-50/50" : "border border-zinc-200 bg-zinc-50/70"
      } ${href ? "hover:border-zinc-300 hover:shadow-sm transition" : ""}`}
    >
      <p className={`text-xs font-medium ${highlight ? "text-blue-700" : "text-zinc-500"}`}>{label}</p>
      <p className={`text-2xl font-bold mt-0.5 ${highlight ? "text-blue-950" : "text-zinc-900"}`}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

function PipelineBar({ label, count, max }: { label: string; count: number; max: number }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-xs text-zinc-600 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 bg-blue-50 rounded-full overflow-hidden">
        <div className="h-full bg-blue-600 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-xs text-zinc-700 text-right shrink-0">{count}</span>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    getJson<DashboardSummary>("/dashboard/summary")
      .then((res) => {
        setData(res);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto w-full px-6 py-8">
        <p className="text-zinc-500 text-sm">Loading…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-6xl mx-auto w-full px-6 py-8">
        <h1 className="text-xl font-semibold mb-2">Dashboard</h1>
        <p className="text-red-600 text-sm">
          Could not load the dashboard right now. Refresh to try again.
        </p>
      </div>
    );
  }

  const { jobs, candidates, interviews, recent_candidates, recent_activity } = data;

  // Build the "needs attention" items from whatever is actually non-zero, so an all-clear
  // inbox shows a genuine empty state rather than a list of zeros.
  const attention: { key: string; label: string; href: string }[] = [];
  if (candidates.needs_review > 0)
    attention.push({
      key: "review",
      label: `${candidates.needs_review} candidate${candidates.needs_review === 1 ? "" : "s"} awaiting your decision`,
      href: "/jobs",
    });
  if (interviews.awaiting_review > 0)
    attention.push({
      key: "interviews",
      label: `${interviews.awaiting_review} interview${interviews.awaiting_review === 1 ? "" : "s"} flagged for review`,
      href: "/review",
    });
  if (candidates.processing_failed > 0)
    attention.push({
      key: "failed",
      label: `${candidates.processing_failed} resume${candidates.processing_failed === 1 ? "" : "s"} failed processing`,
      href: "/jobs",
    });
  if (candidates.duplicates > 0)
    attention.push({
      key: "dupes",
      label: `${candidates.duplicates} possible duplicate${candidates.duplicates === 1 ? "" : "s"}`,
      href: "/jobs",
    });

  const pipelineMax = Math.max(candidates.approved, candidates.review, candidates.declined, 1);

  return (
    <div className="max-w-6xl mx-auto w-full px-6 py-8 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <span className="flex gap-2">
          <Link href="/jobs/new" className="btn-primary text-sm">
            + Create job
          </Link>
          <Link href="/interviews/new" className="btn-outline text-sm">
            Schedule interview
          </Link>
        </span>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active jobs" value={jobs.active} sub={`${jobs.archived} archived`} href="/jobs" />
        <StatCard label="Candidates" value={candidates.total_active} sub="on the active board" />
        <StatCard
          label="Needs your decision"
          value={candidates.needs_review}
          sub="in review bucket"
          href="/jobs"
          attention
        />
        <StatCard
          label="Interviews to review"
          value={interviews.awaiting_review}
          sub="flagged sessions"
          href="/review"
          attention
        />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Left column: attention + activity */}
        <div className="space-y-6">
          <section>
            <h2 className="font-medium mb-2">Needs your attention</h2>
            {attention.length === 0 ? (
              <p className="text-zinc-500 text-sm border border-zinc-200 rounded-md px-4 py-3">
                You&apos;re all caught up — nothing needs review right now.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-md">
                {attention.map((item) => (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50"
                    >
                      <span className="text-sm text-zinc-800">{item.label}</span>
                      <span className="text-xs text-blue-900 shrink-0 ml-3">Open →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="font-medium mb-2">Recent activity</h2>
            {recent_activity.length === 0 ? (
              <p className="text-zinc-500 text-sm">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-md">
                {recent_activity.map((a, i) => (
                  <li key={i} className="px-4 py-2.5 flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-700 min-w-0 truncate">
                      <span className="font-medium">{actorLabel(a.actor)}</span> · {humanize(a.action)}
                    </span>
                    <span className="text-xs text-zinc-400 shrink-0">{timeAgo(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right column: pipeline + interviews */}
        <div className="space-y-6">
          <section>
            <h2 className="font-medium mb-2">Pipeline (all jobs)</h2>
            <div className="border border-zinc-200 rounded-md p-4 space-y-2.5">
              <PipelineBar label="Approved" count={candidates.approved} max={pipelineMax} />
              <PipelineBar label="Review" count={candidates.review} max={pipelineMax} />
              <PipelineBar label="Declined" count={candidates.declined} max={pipelineMax} />
            </div>
          </section>

          <section>
            <h2 className="font-medium mb-2">Interviews</h2>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Pending" value={interviews.pending} />
              <StatCard label="Completed" value={interviews.completed} />
              <StatCard label="To review" value={interviews.awaiting_review} href="/review" attention />
            </div>
          </section>
        </div>
      </div>

      {/* Recent candidates */}
      <section>
        <h2 className="font-medium mb-2">Recent candidates</h2>
        {recent_candidates.length === 0 ? (
          <p className="text-zinc-500 text-sm">No candidates yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-md">
            {recent_candidates.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/candidates/${c.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50 gap-3"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-sm">{c.full_name || "Unnamed candidate"}</span>
                    <span className="block text-xs text-zinc-500 truncate">
                      {c.job_title || "Unknown job"} · {timeAgo(c.created_at)}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    {c.fit_score !== null && (
                      <span className="text-xs text-zinc-600">{c.fit_score.toFixed(0)}/100</span>
                    )}
                    {c.bucket && <span className={`text-xs ${BUCKET_CLASS[c.bucket]}`}>{c.bucket}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
