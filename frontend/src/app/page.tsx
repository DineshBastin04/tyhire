import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      <div className="relative z-10 max-w-lg text-center space-y-6">
        <Image
          src="/logo.png"
          alt="TyHire"
          width={1643}
          height={627}
          priority
          className="mx-auto h-16 w-auto"
        />
        <p className="text-zinc-500">
          Resume screening (Section 1) and interview integrity (Section 2).
        </p>
        <div className="flex justify-center gap-4">
          <Link href="/jobs" className="btn-primary">
            HR: Jobs & Candidates
          </Link>
          <Link href="/review" className="btn-outline">
            HR: Review Queue
          </Link>
        </div>
      </div>
    </div>
  );
}
