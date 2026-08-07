"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api";

export default function SiteHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  // Candidates never see the HR shell — they only ever land on /interview/[token] via a
  // link, and /login is its own minimal screen.
  const hideShell = pathname.startsWith("/interview/") || pathname === "/login";

  useEffect(() => {
    if (hideShell) return;
    getJson<{ authenticated: boolean; email: string }>("/auth/me")
      .then((res) => setEmail(res.email))
      .catch(() => {});
  }, [hideShell]);

  if (hideShell) {
    return null;
  }

  async function handleLogout() {
    await postJson("/auth/logout", {}).catch(() => {});
    router.push("/login");
  }

  return (
    // White, not the old solid dark-blue bar — the logo's wordmark is dark navy on a
    // white background, so a dark header would make it unreadable. A bottom border does
    // the separation job the solid fill used to.
    <header className="bg-white border-b border-zinc-200 px-6 py-2 flex items-center gap-6">
      <Link href="/" className="shrink-0">
        <Image src="/logo.png" alt="TyHire" width={160} height={61} priority className="h-9 w-auto" />
      </Link>
      <Link href="/jobs" className="text-sm text-zinc-600 hover:text-blue-900">
        Jobs
      </Link>
      <Link href="/interviews/new" className="text-sm text-zinc-600 hover:text-blue-900">
        Schedule Interview
      </Link>
      <Link href="/review" className="text-sm text-zinc-600 hover:text-blue-900">
        Review Queue
      </Link>
      <Link href="/settings/users" className="text-sm text-zinc-600 hover:text-blue-900">
        HR Users
      </Link>
      <span className="ml-auto flex items-center gap-3">
        {email && <span className="text-xs text-zinc-400">{email}</span>}
        <button onClick={handleLogout} className="text-sm text-zinc-600 hover:text-blue-900">
          Log out
        </button>
      </span>
    </header>
  );
}
