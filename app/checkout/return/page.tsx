import { requireSession } from "@/lib/auth/session";
import { fulfilCheckout } from "@/lib/fulfilCheckout";

/**
 * Where Flutterwave sends the browser back to after the hosted checkout.
 * This page's only job is to hand tx_ref and transaction_id to
 * lib/fulfilCheckout.ts and render whatever it decides — it makes no
 * decision of its own. Reaching this page with an invented or replayed
 * transaction_id is exactly the scenario defence question 1 asks about;
 * see fulfilCheckout for where that is actually stopped.
 */
export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A page, not an API route — requireSession()'s redirect-on-failure is
  // the right behaviour here (unlike /api/checkout, nothing is fetch()ing
  // this). The cookie survives Flutterwave's cross-site redirect because
  // it is SameSite=Lax, not Strict.
  const user = await requireSession();
  const params = await searchParams;

  // status is a claim in the query string - anyone can type
  // ?status=successful into this URL by hand, or Flutterwave itself can
  // send it for a payment that did not actually succeed. It is never read
  // for anything on this page or in fulfilCheckout: the only thing that
  // can grant access is the authenticated server-to-server verify call.
  void params.status;

  const txRef = typeof params.tx_ref === "string" ? params.tx_ref : undefined;
  const transactionId = typeof params.transaction_id === "string" ? params.transaction_id : undefined;

  if (!txRef || !transactionId) {
    return (
      <main>
        <p>We couldn&apos;t find enough information to confirm this payment.</p>
      </main>
    );
  }

  const result = await fulfilCheckout({ userId: user.id, txRef, transactionId, now: new Date() });

  switch (result.outcome) {
    case "granted":
      return (
        <main>
          <p>Payment confirmed. Your plan is now active.</p>
        </main>
      );
    case "duplicate":
      return (
        <main>
          <p>This payment was already confirmed. Your plan is active.</p>
        </main>
      );
    case "pending":
      return (
        <main>
          <p>Your payment is still processing. Check back shortly.</p>
        </main>
      );
    case "rejected":
      return (
        <main>
          <p>We couldn&apos;t confirm this payment. If you were charged, contact support.</p>
        </main>
      );
  }
}
