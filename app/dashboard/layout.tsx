import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth/session";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // The gate. Every render of anything under /dashboard passes through
  // here first; requireSession() redirects to /signin before children
  // ever render if there is no valid session.
  await requireSession();

  return <>{children}</>;
}
