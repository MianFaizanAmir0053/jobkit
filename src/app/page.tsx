import { redirect } from "next/navigation";

// The proxy has already sent a browser without a session to /login.
export default function Home() {
  redirect("/jobs");
}
