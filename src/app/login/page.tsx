import type { Metadata } from "next";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Sign in · jobkit" };

const MESSAGES: Record<string, string> = {
  denied: "This Google account cannot use jobkit.",
  failed: "Sign-in did not finish. Try again.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? MESSAGES[error] : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">jobkit</h1>
      <p className="mt-2 text-muted-foreground">Turns a job post into an honest application kit.</p>
      {message && (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {message}
        </p>
      )}
      {/* A plain link: the sign-in route answers with a redirect to Google, not a page. */}
      <a
        href="/api/auth/google/start"
        className={cn(buttonVariants({ size: "lg" }), "mt-8 w-full")}
      >
        Sign in with Google
      </a>
    </main>
  );
}
