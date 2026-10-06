import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { requireSession } from "@/server/dal";

// Each later task adds its page here: New job, Stats, Spend, Profile, Devices.
const NAV = [{ href: "/jobs", label: "Jobs" }] as const;

/**
 * The app shell. It checks the session for its own sake only; every page
 * under it calls requireSession itself (platform spec B2).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4">
      <header className="flex items-center justify-between gap-4 py-4">
        <Link href="/jobs" className="text-lg font-semibold tracking-tight">
          jobkit
        </Link>
        <form method="post" action="/api/auth/signout">
          <button type="submit" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sign out
          </button>
        </form>
      </header>
      <nav aria-label="Main">
        <ul className="flex gap-1 border-b border-border pb-2">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 py-6">{children}</main>
    </div>
  );
}
