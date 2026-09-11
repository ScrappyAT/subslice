import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, destroySession } from "@/lib/auth/session";

/**
 * The signed-in shell (step 12). Every page under app/(app) — dashboard,
 * plans, billing, cancel — reaches this gate first: requireSession()
 * redirects to /signin before any child ever renders if there is no valid
 * session, the same pattern app/dashboard/layout.tsx used on its own
 * before this step (see AGENTS.md's route-protection rule). Nothing else
 * lives here — no styling framework, no client-side state — "minimal" is
 * the brief's own word for this.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession();

  async function signOutAction() {
    "use server";
    await destroySession();
    redirect("/signin");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <nav className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
        <div className="flex gap-4 text-sm font-medium">
          <Link href="/dashboard" className="hover:underline">
            Dashboard
          </Link>
          <Link href="/plans" className="hover:underline">
            Plans
          </Link>
          <Link href="/billing" className="hover:underline">
            Billing
          </Link>
        </div>
        <form action={signOutAction}>
          <button type="submit" className="text-sm underline">
            Sign out
          </button>
        </form>
      </nav>
      <main className="flex-1">{children}</main>
    </div>
  );
}
