"use client";

import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api";
import JobForm, { type JobPayload } from "@/components/JobForm";
import type { Job } from "@/lib/types";

export default function NewJobPage() {
  const router = useRouter();

  async function handleSubmit(payload: JobPayload) {
    const job = await postJson<Job>("/jobs", payload);
    router.push(`/jobs/${job.id}`);
  }

  return (
    <div className="max-w-2xl mx-auto w-full px-6 py-8">
      <h1 className="text-xl font-semibold mb-6">New job</h1>
      <JobForm onSubmit={handleSubmit} submitLabel="Create job" />
    </div>
  );
}
