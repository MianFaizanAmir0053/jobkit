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
// A phone that redeems in the code's last seconds still reaches the server;
// polling goes on this long after the countdown so the laptop sees it.
const LATE_REDEEM_MS = 15_000;

/**
 * The laptop's side of QR pairing: make a code, show it with its countdown,
 * then type the code each waiting phone shows. It polls for waiting phones
 * only while one could be waiting, and not while the page is hidden.
 */
export function PairPanel({ initialWaiting }: { initialWaiting: WaitingPhoneView[] }) {
  const router = useRouter();
  const [qr, setQr] = useState<Qr | null>(null);
  const [now, setNow] = useState(0);
  const [waiting, setWaiting] = useState(initialWaiting);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showing = qr !== null && now < qr.deadline;
  const watching = (qr !== null && now < qr.deadline + LATE_REDEEM_MS) || waiting.length > 0;

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

  async function approve(pairingId: string, code: string) {
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
      } else if (response.status === 410) {
        forget(pairingId);
        setNotice("That phone's request has ended. Make a new code to try again.");
      } else {
        setNotice(
          signedOutOr(response.status, "Could not approve. Reload the page and try again."),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function reject(pairingId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await post("/api/pair/reject", { pairingId });
      if (response.status === 204) {
        forget(pairingId);
        setNotice("Rejected. That phone is not paired.");
      } else if (response.status === 410) {
        forget(pairingId);
        setNotice("That phone's request had already ended. It is not paired.");
      } else {
        // The phone is still waiting: say so, rather than let the owner believe it is gone.
        setNotice(signedOutOr(response.status, "Could not reject that phone. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }

  function forget(pairingId: string) {
    setWaiting((phones) => phones.filter((p) => p.pairingId !== pairingId));
  }

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
      ) : waiting.length > 0 ? (
        <div className="mt-3 space-y-4">
          {waiting.length > 1 && (
            <p role="alert" className="text-sm">
              {waiting.length} phones are waiting. If you scanned the code with only one phone,
              reject the others.
            </p>
          )}
          {waiting.map((phone) => (
            <PhoneApproval
              key={phone.pairingId}
              phone={phone}
              busy={busy}
              onApprove={(code) => void approve(phone.pairingId, code)}
              onReject={() => void reject(phone.pairingId)}
            />
          ))}
        </div>
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

function PhoneApproval({
  phone,
  busy,
  onApprove,
  onReject,
}: {
  phone: WaitingPhoneView;
  busy: boolean;
  onApprove: (code: string) => void;
  onReject: () => void;
}) {
  const [code, setCode] = useState("");
  const inputId = `pair-code-${phone.pairingId}`;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onApprove(code);
      }}
    >
      <p>A phone is waiting ({phone.label}). Type the code it shows.</p>
      <label htmlFor={inputId} className="mt-3 block text-sm text-muted-foreground">
        Code from the phone
      </label>
      <input
        id={inputId}
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
        <Button type="button" variant="outline" disabled={busy} onClick={onReject}>
          Reject
        </Button>
      </div>
    </form>
  );
}

function signedOutOr(status: number, otherwise: string): string {
  return status === 401 ? "Your session has ended. Sign in again." : otherwise;
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
