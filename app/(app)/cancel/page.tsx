import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { previewCancellation } from "@/lib/cancellation";
import CancelFlow from "@/components/CancelFlow";

/**
 * The rendered cancellation confirmation page owed from step 11. This is
 * a GET (a Next.js page render always is) and writes nothing: it calls
 * previewCancellation directly — the same function GET /api/cancel/preview
 * calls — not appendPaymentEvent. Every date on the page comes from that
 * derivation, never read off Subscription. The one write in this whole
 * flow (POST /api/cancel/confirm) only happens from an explicit button
 * click inside CancelFlow, a client component.
 */
export default async function CancelPage() {
  const user = await requireSession();
  const result = await previewCancellation({ userId: user.id, now: new Date() });

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Cancel subscription</h1>

      {result.outcome === "inconsistent" ? (
        <p className="mt-4 text-red-700">We cannot determine your plan right now.</p>
      ) : result.outcome === "no_active_paid_plan" ? (
        <>
          <p className="mt-4 text-gray-700">There is no active paid plan to cancel.</p>
          <Link href="/billing" className="mt-2 inline-block text-sm underline">
            Back to billing
          </Link>
        </>
      ) : (
        <CancelFlow planCode={result.planCode} periodEnd={result.periodEnd.toISOString()} />
      )}
    </div>
  );
}
