import { redirect } from "next/navigation";
import { requireSession, destroySession } from "@/lib/auth/session";

export default async function DashboardPage() {
  const user = await requireSession();

  async function signOutAction() {
    "use server";
    await destroySession();
    redirect("/signin");
  }

  return (
    <main>
      <p>Signed in as {user.name}.</p>
      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
