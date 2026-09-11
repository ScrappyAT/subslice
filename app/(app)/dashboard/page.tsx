import { requireSession } from "@/lib/auth/session";

export default async function DashboardPage() {
  const user = await requireSession();

  return (
    <div className="p-6">
      <p>Signed in as {user.name}.</p>
    </div>
  );
}
