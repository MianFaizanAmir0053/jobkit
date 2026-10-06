"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const FAILURE = "This code has expired. Make a new one on your laptop.";
// Keeps the code on screen if the phone reloads while it waits.
const CODE_KEY = "jobkit_pair_code";

type View = { step: "pairing" } | { step: "code"; code: string } | { step: "failed" };

export function PairPhone() {
  const router = useRouter();
  const [view, setView] = useState<View>({ step: "pairing" });
  // React runs effects twice in development; the token must be read and redeemed once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
    // The token leaves the address bar at once, so it stays out of history and screenshots.
    if (window.location.hash) window.history.replaceState(null, "", "/pair");
    // Without a token, this is a reload while waiting: show the code kept for it, if any.
    const code = token
      ? redeem(token).then((redeemed) => {
          if (redeemed) sessionStorage.setItem(CODE_KEY, redeemed);
          return redeemed;
        })
      : Promise.resolve(sessionStorage.getItem(CODE_KEY));
    void code.then((shown) => setView(shown ? { step: "code", code: shown } : { step: "failed" }));
  }, []);

  useEffect(() => {
    if (view.step !== "code") return;
    const check = async () => {
      if (document.hidden) return;
      const state = await pairingState();
      if (state === "approved") {
        sessionStorage.removeItem(CODE_KEY);
        router.replace("/jobs");
      } else if (state === "gone") {
        sessionStorage.removeItem(CODE_KEY);
        setView({ step: "failed" });
      }
    };
    const timer = window.setInterval(check, 2000);
    void check();
    return () => window.clearInterval(timer);
  }, [view.step, router]);

  if (view.step === "pairing") return <p className="mt-6 text-muted-foreground">Pairing…</p>;
  if (view.step === "failed") {
    return (
      <p role="alert" className="mt-6">
        {FAILURE}
      </p>
    );
  }
  return (
    <div className="mt-8">
      <p className="text-muted-foreground">Type this code on your laptop.</p>
      <p
        aria-label={`Code ${view.code.split("").join(" ")}`}
        className="mt-4 font-mono text-5xl font-semibold tracking-[0.15em] text-primary"
      >
        {view.code.slice(0, 3)} {view.code.slice(3)}
      </p>
      <p className="mt-6 text-sm text-muted-foreground" aria-live="polite">
        Waiting for your laptop…
      </p>
    </div>
  );
}

async function redeem(token: string): Promise<string | null> {
  try {
    const response = await fetch("/api/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json()) as { code?: unknown };
    return response.ok && typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

async function pairingState(): Promise<string | null> {
  try {
    const response = await fetch("/api/pair/status", { cache: "no-store" });
    return ((await response.json()) as { state?: string }).state ?? null;
  } catch {
    return null;
  }
}
