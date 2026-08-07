"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { deleteJson, getJson, postJson } from "@/lib/api";
import type { HrUser } from "@/lib/types";

export default function HrUsersPage() {
  const [users, setUsers] = useState<HrUser[]>([]);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(() => {
    getJson<HrUser[]>("/auth/users").then(setUsers).catch(() => {});
    getJson<{ email: string; is_admin: boolean }>("/auth/me")
      .then((me) => {
        setCurrentEmail(me.email);
        setIsAdmin(me.is_admin);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await postJson("/auth/users", {
        email,
        password,
        display_name: displayName || null,
      });
      setEmail("");
      setPassword("");
      setDisplayName("");
      refresh();
    } catch {
      setError("Could not create that user — the email may already be in use.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(user: HrUser) {
    if (!window.confirm(`Remove ${user.display_name ?? user.email} from HR users?`)) return;
    try {
      await deleteJson(`/auth/users/${user.id}`, {});
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not delete this user.");
    }
  }

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-8 space-y-8">
      <div>
        <h1 className="text-xl font-semibold mb-1">HR users</h1>
        <p className="text-sm text-zinc-500">
          Every action an HR user takes (overrides, archives, flag reviews) is attributed to
          their account in the audit log.
        </p>
      </div>

      <ul className="space-y-1 text-sm">
        {users.map((u) => (
          <li key={u.id} className="border border-zinc-200 rounded-md px-3 py-2 flex items-center justify-between">
            <span>
              {u.display_name ? `${u.display_name} — ${u.email}` : u.email}
              {u.is_admin && <span className="ml-2 text-xs text-blue-700">admin</span>}
              {!u.is_active && <span className="ml-2 text-xs text-zinc-400">inactive</span>}
            </span>
            {isAdmin && u.email !== currentEmail && (
              <button
                onClick={() => handleDelete(u)}
                className="btn-danger-outline text-xs px-2 py-1"
              >
                Delete
              </button>
            )}
          </li>
        ))}
        {users.length === 0 && <li className="text-zinc-500">No users yet.</li>}
      </ul>

      {isAdmin ? (
        <form onSubmit={handleSubmit} className="space-y-3 border-t border-zinc-200 pt-6">
          <h2 className="font-medium text-sm">Add a new HR user</h2>
          <label className="block">
            <span className="block text-sm font-medium mb-1">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1">Display name (optional)</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1">Temporary password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? "Creating…" : "Create user"}
          </button>
        </form>
      ) : (
        <p className="text-xs text-zinc-400 border-t border-zinc-200 pt-6">
          Only admins can add or remove HR users.
        </p>
      )}
    </div>
  );
}
