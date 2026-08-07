const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { credentials: "include", ...init });
  if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    // HR session missing/expired — the backend is the real authorization boundary; this
    // just avoids leaving an HR page stuck silently failing its data fetches.
    window.location.href = "/login";
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
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
