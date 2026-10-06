"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WaitingPhoneView {
  pairingId: string;
  label: string;
}

type Qr = { dataUri: string; deadline: number };

// Pairing needs a Google sign-in from the last five minutes (platform spec B3).
const SIGN_IN_AGAIN = "/api/auth/google/start?next=/devices";

/**
 * The laptop's side of QR pairing: make a code, show it with its countdown,
 * then type the code the phone shows. It polls for a waiting phone only while
 * one could be waiting, and not while the page is hidden.
 */
export function PairPanel({ initialWaiting }: { initialWaiting: WaitingPhoneView[] }) {
  const router = useRouter();
  const [qr, setQr] = useState<Qr | null>(null);
  const [now, setNow] = useState(0);
  const [waiting, setWaiting] = useState(initialWaiting);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  const showing = qr !== null && now < qr.deadline;
  const watching = showing || waiting.length > 0;

  useEffect(() => {
    if (!qr) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [qr]);

  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(async () => {
      if (document.hidden) return;
      const response = await fetch("/api/pair/waiting", { cache: "no-store" });
      if (!response.ok) return;
      const { phones } = (await response.json()) as { phones: WaitingPhoneView[] };
      setWaiting(phones);
      // A waiting phone has used the code, so it is no longer worth showing.
      if (phones.length > 0) setQr(null);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [watching]);

  async function makeCode() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/pair/tokens", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        svg?: string;
        expiresInSeconds?: number;
      };
      if (body.error === "stale-google-auth") return setNeedsSignIn(true);
      if (!response.ok || !body.svg || !body.expiresInSeconds) {
        return setNotice("Could not make a code. Reload the page and try again.");
      }
      const started = Date.now();
      setQr({
        dataUri: `data:image/svg+xml;utf8,${encodeURIComponent(body.svg)}`,
        deadline: started + body.expiresInSeconds * 1000,
      });
      setNow(started);
    } finally {
      setBusy(false);
    }
  }

  async function approve(pairingId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await post("/api/pair/approve", { pairingId, code });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        attemptsLeft?: number;
      };
      if (response.ok) {
        forget(pairingId);
        setNotice("Paired. The phone opens its jobs now.");
        router.refresh();
      } else if (body.error === "wrong-code") {
        setNotice(
          body.attemptsLeft === 1
            ? "That code does not match. One try left."
            : `That code does not match. ${body.attemptsLeft} tries left.`,
        );
      } else if (body.error === "stale-google-auth") {
        setNeedsSignIn(true);
      } else {
        forget(pairingId);
        setNotice("That phone's request has ended. Make a new code to try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function reject(pairingId: string) {
    setBusy(true);
    try {
      await post("/api/pair/reject", { pairingId });
      forget(pairingId);
      setNotice("Rejected. That phone is not paired.");
    } finally {
      setBusy(false);
    }
  }

  function forget(pairingId: string) {
    setWaiting((phones) => phones.filter((p) => p.pairingId !== pairingId));
    setCode("");
  }

  const phone = waiting[0];
  return (
    <section aria-labelledby="pair-heading" className="mt-6 rounded-lg border border-border p-4">
      <h2 id="pair-heading" className="font-medium">
        Pair a phone
      </h2>
      {needsSignIn ? (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">
            Pairing needs a Google sign-in from the last five minutes. Google will ask you to choose
            your account.
          </p>
          <a href={SIGN_IN_AGAIN} className={cn(buttonVariants(), "mt-3")}>
            Sign in with Google again
          </a>
        </div>
      ) : phone ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void approve(phone.pairingId);
          }}
        >
          <p>A phone is waiting ({phone.label}). Type the code it shows.</p>
          <label htmlFor="pair-code" className="mt-3 block text-sm text-muted-foreground">
            Code from the phone
          </label>
          <input
            id="pair-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="mt-1 w-40 rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-2xl tracking-widest outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <div className="mt-3 flex gap-2">
            <Button type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void reject(phone.pairingId)}
            >
              Reject
            </Button>
          </div>
        </form>
      ) : showing ? (
        <div className="mt-3">
          <Image
            src={qr.dataUri}
            alt="QR code that pairs a phone"
            width={224}
            height={224}
            unoptimized
            className="rounded-lg bg-white p-2"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Scan it with the phone&apos;s camera. It works once, for {countdown(qr.deadline - now)}{" "}
            more.
          </p>
        </div>
      ) : (
        <div className="mt-3">
          {qr && <p className="text-sm">This code has expired.</p>}
          <Button className="mt-3" disabled={busy} onClick={() => void makeCode()}>
            {qr ? "Make a new code" : "Pair a phone"}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}

function post(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
