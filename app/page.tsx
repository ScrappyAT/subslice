import { redirect } from "next/navigation";

// The brief's "do not build" list rules out a landing page. There is nothing
// for an unauthenticated visitor to see at "/" — send them straight to
// sign-in.
export default function Home() {
  redirect("/sign-in");
}
