const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

/**
 * A failed HTTP response. `message` is the human-readable reason (the backend's
 * `{"detail": ...}` when present, otherwise the raw body or a status fallback) so it can be
 * shown straight to the user — e.g. in an error toast. `status` is kept for callers that
 * need to branch on the code (e.g. ignoring a 409) without string-matching the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(status: number, statusText: string, detail: string, body: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

function extractDetail(status: number, statusText: string, body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) return detail;
      if (detail != null) return JSON.stringify(detail);
    }
  } catch {
    // Body wasn't JSON (HTML error page, plain text, empty) — fall through to the raw text.
  }
  return body.trim() || `${status} ${statusText}`.trim() || "Request failed";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { credentials: "include", ...init });
  if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    // HR session missing/expired — the backend is the real authorization boundary; this
    // just avoids leaving an HR page stuck silently failing its data fetches.
    window.location.href = "/login";
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, res.statusText, extractDetail(res.status, res.statusText, body), body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function getJson<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
  return request<T>(path, extraHeaders ? { headers: extraHeaders } : undefined);
}

export function postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

export function postForm<T>(path: string, form: FormData, extraHeaders?: Record<string, string>): Promise<T> {
  return request<T>(path, { method: "POST", body: form, headers: extraHeaders });
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const MEDIA_BASE_URL = BASE_URL.replace(/\/api\/v1\/?$/, "");

export { BASE_URL };
