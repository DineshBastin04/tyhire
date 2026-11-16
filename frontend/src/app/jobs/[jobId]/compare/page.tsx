"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { postJson } from "@/lib/api";
import type {
  CandidateComparisonResponse,
  ComparisonCandidateAnalysis,
  ComparisonTableRow,
} from "@/lib/types";

export default function ComparePage() {
  // useSearchParams needs a Suspense boundary during prerender in the App Router.
  return (
    <Suspense fallback={<p className="p-6 text-zinc-500">Loading…</p>}>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const { jobId } = useParams<{ jobId: string }>();
  const searchParams = useSearchParams();
  const ids = (searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const idsKey = ids.join(",");

  const [data, setData] = useState<CandidateComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id — a response from a superseded request is ignored, so a quick
  // retry can never render stale results, and overlapping requests can't clobber each other.
  const reqSeq = useRef(0);

  const runCompare = useCallback(() => {
    if (ids.length < 2) {
      setError("Select at least two candidates to compare.");
      return;
    }
    const myReq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    postJson<CandidateComparisonResponse>(`/jobs/${jobId}/candidates/compare`, {
      candidate_ids: ids,
    })
      .then((res) => {
        if (myReq !== reqSeq.current) return; // superseded
        setData(res);
      })
      .catch((e: unknown) => {
        if (myReq !== reqSeq.current) return;
        setError(e instanceof Error ? e.message : "Comparison failed.");
      })
      .finally(() => {
        if (myReq !== reqSeq.current) return;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, idsKey]);

  useEffect(() => {
    // Intentional fetch-on-mount (and on ids change): runCompare flips loading/error as the
    // request starts. The superseded-request guard above makes the cascade safe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runCompare();
  }, [runCompare]);

  return (
    <div className="max-w-full mx-auto w-full px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href={`/jobs/${jobId}`} className="text-sm text-zinc-500 hover:text-blue-900">
            ← Back to pipeline
          </Link>
          <h1 className="text-xl font-semibold mt-1">
            Candidate comparison{data ? ` — ${data.job.title}` : ""}
          </h1>
          <p className="text-sm text-zinc-500">
            {ids.length} candidate{ids.length === 1 ? "" : "s"} · AI analysis is advisory and
            never changes any score or decision.
          </p>
        </div>
        <button onClick={runCompare} disabled={loading} className="btn-outline text-sm">
          {loading ? "Comparing…" : "Regenerate"}
        </button>
      </div>

      {loading && !data && (
        <div className="border border-zinc-200 rounded-md p-8 text-center text-zinc-500">
          Comparing candidates and generating analysis…
        </div>
      )}

      {error && !loading && (
        <div className="border border-red-300 bg-red-50 rounded-md p-4 space-y-2">
          <p className="text-sm text-red-800">{error}</p>
          <button onClick={runCompare} className="btn-outline text-xs">
            Retry
          </button>
        </div>
      )}

      {ids.length < 2 && !loading && (
        <div className="border border-amber-300 bg-amber-50 rounded-md p-4 text-sm text-amber-900">
          Pick at least two candidates from the pipeline to compare.
        </div>
      )}

      {data && (
        <>
          {!data.ai_available && data.ai_error && (
            <div className="border border-amber-300 bg-amber-50 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm text-amber-900">{data.ai_error}</p>
              <button onClick={runCompare} disabled={loading} className="btn-outline text-xs">
                Retry AI analysis
              </button>
            </div>
          )}

          {data.ai_available && <AnalysisSection data={data} />}

          <ComparisonTable rows={data.table} />
        </>
      )}
    </div>
  );
}

function AnalysisSection({ data }: { data: CandidateComparisonResponse }) {
  const { analysis, table } = data;
  const nameFor = (row: ComparisonTableRow) => row.full_name ?? row.ref;
  const analysisByRef = new Map<string, ComparisonCandidateAnalysis>(
    analysis.per_candidate.map((a) => [a.ref, a])
  );

  return (
    <div className="space-y-5">
      {analysis.overall_summary && (
        <section className="border border-zinc-200 rounded-md p-4 bg-surface">
          <h2 className="font-medium mb-1">AI summary</h2>
          <p className="text-sm text-zinc-700 whitespace-pre-wrap">{analysis.overall_summary}</p>
        </section>
      )}

      {analysis.differentiators.length > 0 && (
        <section className="border border-zinc-200 rounded-md p-4 bg-surface">
          <h2 className="font-medium mb-2">Where they differ</h2>
          <ul className="space-y-1.5 text-sm text-zinc-700">
            {analysis.differentiators.map((d, i) => (
              <li key={i}>
                <span className="font-medium text-zinc-900">{d.criterion}:</span> {d.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {table.map((row) => {
          const a = analysisByRef.get(row.ref);
          const fit = row.scores.effective_fit_score ?? row.scores.fit_score;
          const tone = scoreTone(row);
          return (
            <div key={row.ref} className="border border-zinc-200 rounded-md p-4 bg-surface space-y-3">
              <h3 className="font-semibold text-zinc-900 flex items-center justify-between gap-2">
                <span>{nameFor(row)}</span>
                <span className={`text-sm font-bold shrink-0 ${tone.text}`}>
                  {fit != null ? `${fit.toFixed(0)}/100` : "—"}
                </span>
              </h3>
              <AnalysisList label="Strengths" items={a?.strengths} tone="emerald" />
              <AnalysisList label="Gaps" items={a?.gaps} tone="amber" />
              <AnalysisList label="Evidence" items={a?.evidence} tone="zinc" />
              <AnalysisList label="Insufficient data" items={a?.insufficient_data} tone="zinc" muted />
            </div>
          );
        })}
      </section>

      {analysis.follow_up_questions.length > 0 && (
        <section className="border border-zinc-200 rounded-md p-4 bg-surface">
          <h2 className="font-medium mb-2">Suggested follow-up questions</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm text-zinc-700">
            {analysis.follow_up_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      )}

      {analysis.conclusion && (
        <section className="border border-zinc-200 rounded-md p-4 bg-surface">
          <h2 className="font-medium mb-1">Conclusion</h2>
          <p className="text-sm text-zinc-700 whitespace-pre-wrap">{analysis.conclusion}</p>
          <p className="text-xs text-zinc-400 mt-2">
            Advisory only — the hiring decision stays with you.
          </p>
        </section>
      )}
    </div>
  );
}

function AnalysisList({
  label,
  items,
  tone,
  muted,
}: {
  label: string;
  items?: string[];
  tone: "emerald" | "amber" | "zinc";
  muted?: boolean;
}) {
  if (!items || items.length === 0) return null;
  const dot =
    tone === "emerald" ? "bg-emerald-500" : tone === "amber" ? "bg-amber-500" : "bg-zinc-400";
  return (
    <div>
      <p className={`text-xs font-medium mb-1 ${muted ? "text-zinc-400" : "text-zinc-600"}`}>{label}</p>
      <ul className="space-y-1 text-sm text-zinc-700">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Color the headline score by the candidate's effective stage (same meaning as the board), with
// a score-band fallback when there's no bucket yet.
function scoreTone(row: ComparisonTableRow): { text: string; bar: string } {
  const bucket = row.override_bucket ?? row.bucket;
  if (bucket === "approved") return { text: "text-emerald-700", bar: "bg-emerald-500" };
  if (bucket === "declined") return { text: "text-red-700", bar: "bg-red-500" };
  if (bucket === "review") return { text: "text-amber-700", bar: "bg-amber-500" };
  const s = row.scores.effective_fit_score ?? row.scores.fit_score ?? 0;
  if (s >= 70) return { text: "text-emerald-700", bar: "bg-emerald-500" };
  if (s >= 45) return { text: "text-amber-700", bar: "bg-amber-500" };
  return { text: "text-red-700", bar: "bg-red-500" };
}

function ScoreBlock({ row }: { row: ComparisonTableRow }) {
  const score = row.scores.effective_fit_score ?? row.scores.fit_score;
  const tone = scoreTone(row);
  const pct = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-bold ${tone.text}`}>{score != null ? score.toFixed(0) : "—"}</span>
        <span className="text-xs text-zinc-400">/100 fit</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-200 overflow-hidden">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap gap-1 pt-0.5">
        {row.scores.technical_score != null && (
          <span className="text-[11px] bg-blue-50 text-blue-800 border border-blue-200 px-1.5 py-0.5 rounded font-medium">
            Tech {row.scores.technical_score.toFixed(0)}
          </span>
        )}
        {row.scores.communication_score != null && (
          <span className="text-[11px] bg-purple-50 text-purple-800 border border-purple-200 px-1.5 py-0.5 rounded font-medium">
            Comm {row.scores.communication_score.toFixed(0)}
          </span>
        )}
        {row.scores.manual_score_adjustment != null && row.scores.manual_score_adjustment !== 0 && (
          <span className="text-[11px] bg-zinc-100 text-zinc-600 border border-zinc-200 px-1.5 py-0.5 rounded font-medium">
            Adj {row.scores.manual_score_adjustment > 0 ? "+" : ""}
            {row.scores.manual_score_adjustment}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- factual comparison table (persisted data; no AI) -----------------------------------
function ComparisonTable({ rows }: { rows: ComparisonTableRow[] }) {
  if (rows.length === 0) return null;

  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toFixed(0));
  const list = (items: string[]) => (items.length ? items.join(", ") : "—");

  const criteria: { label: string; render: (r: ComparisonTableRow) => ReactNode }[] = [
    { label: "Stage", render: (r) => r.override_bucket ?? r.bucket ?? "—" },
    {
      label: "Manual adjustment",
      render: (r) =>
        r.scores.manual_score_adjustment !== null
          ? `${r.scores.manual_score_adjustment > 0 ? "+" : ""}${r.scores.manual_score_adjustment}`
          : "—",
    },
    { label: "Matched skills", render: (r) => list(r.relevant_skills) },
    {
      label: "Missing critical skills",
      render: (r) =>
        r.missing_critical_skills.length ? (
          <span className="text-amber-700">{r.missing_critical_skills.join(", ")}</span>
        ) : (
          "—"
        ),
    },
    { label: "Experience", render: (r) => (r.years_experience != null ? String(r.years_experience) : "—") },
    { label: "Education", render: (r) => list(r.education) },
    { label: "Certifications", render: (r) => list(r.certifications) },
    {
      label: "Knockout",
      render: (r) =>
        r.knockout_failed ? (
          <span className="text-red-700">Failed: {list(r.knockout_reasons)}</span>
        ) : (
          "Passed"
        ),
    },
    {
      label: "L1 phone screen",
      render: (r) =>
        r.l1 ? (
          <span>
            {r.l1.verdict ?? "—"}
            {r.l1.overall_l1_score != null && ` · ${fmt(r.l1.overall_l1_score)}/100`}
          </span>
        ) : (
          <span className="text-zinc-400">Not available</span>
        ),
    },
    {
      label: "Interview",
      render: (r) =>
        r.interview ? (
          <span>
            {r.interview.status ?? "—"}
            {r.interview.interviewer_decision && ` · ${r.interview.interviewer_decision}`}
            {r.interview.qa_total_count != null &&
              ` · Q&A on-topic ${r.interview.qa_relevant_count}/${r.interview.qa_total_count}`}
          </span>
        ) : (
          <span className="text-zinc-400">Not available</span>
        ),
    },
    {
      label: "Integrity (review context)",
      render: (r) =>
        r.interview?.integrity_needs_review ? (
          <span className="text-amber-700">Needs review</span>
        ) : (
          <span className="text-zinc-400">—</span>
        ),
    },
    {
      label: "Missing data",
      render: (r) =>
        r.data_completeness.length ? (
          <span className="text-zinc-400">{r.data_completeness.join(", ")}</span>
        ) : (
          "Complete"
        ),
    },
  ];

  return (
    <div className="border border-zinc-200 rounded-md overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className="sticky left-0 z-10 bg-surface text-left font-medium text-zinc-500 px-3 py-2 w-48 min-w-[12rem]">
              Criteria
            </th>
            {rows.map((r) => (
              <th key={r.ref} className="text-left px-3 py-2 min-w-[14rem] align-bottom">
                <div className="font-semibold text-zinc-900 leading-tight">{r.full_name ?? r.ref}</div>
                <ScoreBlock row={r} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {criteria.map((c, i) => (
            <tr key={c.label} className={i % 2 ? "bg-zinc-50/50" : ""}>
              <td className="sticky left-0 z-10 bg-surface font-medium text-zinc-600 px-3 py-2 align-top w-48 min-w-[12rem]">
                {c.label}
              </td>
              {rows.map((r) => (
                <td key={r.ref} className="px-3 py-2 align-top text-zinc-700 min-w-[14rem]">
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
