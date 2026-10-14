import type { Metadata } from "next";

import { buttonVariants } from "@/components/ui/button";
import { lastSeen } from "@/lib/time";
import {
  devicesForViewer,
  gmailForViewer,
  requestTime,
  requireSession,
  waitingPhonesForViewer,
} from "@/server/dal";

import { DisconnectGmail } from "./DisconnectGmail";
import { PairPanel } from "./PairPanel";
import { RevokeButton } from "./RevokeButton";

export const metadata: Metadata = { title: "Devices · jobkit" };

/** What connecting Gmail came back with, in the owner's words. */
const GMAIL_OUTCOMES: Readonly<Record<string, string>> = {
  connected: "Gmail is connected: Approve & send now sends from it.",
  disconnected: "Gmail is disconnected: Google no longer lets jobkit send from it.",
  unrevoked:
    "jobkit forgot the connection, but Google did not confirm that jobkit's access ended. Remove jobkit's access in your Google Account's security settings, among the apps connected to it.",
  cancelled: "You cancelled on Google's screen, so Gmail was not connected.",
  denied: "That Google account is not the owner's, so it was not connected.",
  "no-send-permission":
    "Gmail was not connected: tick the permission to send email on Google's screen.",
  failed: "Gmail could not be connected. Try again.",
};

/**
 * Devices (platform spec B2, B3): google sessions only; a paired phone is
 * sent to its jobs. Also the Gmail connection one-click send uses
 * (decisions A20).
 */
export default async function DevicesPage({ searchParams }: PageProps<"/devices">) {
  await requireSession({ kind: "google" });
  const [devices, waiting, now, gmail, { gmail: outcome }] = await Promise.all([
    devicesForViewer(),
    waitingPhonesForViewer(),
    requestTime(),
    gmailForViewer(),
    searchParams,
  ]);
  const said =
    typeof outcome === "string" && Object.hasOwn(GMAIL_OUTCOMES, outcome)
      ? GMAIL_OUTCOMES[outcome]
      : undefined;

  return (
    <section aria-labelledby="devices-heading">
      <h1 id="devices-heading" className="text-2xl font-semibold tracking-tight">
        Devices
      </h1>
      <PairPanel
        initialWaiting={waiting.map(({ pairingId, label, redeemedAt }) => ({
          pairingId,
          label,
          redeemedAt: redeemedAt.toISOString(),
        }))}
      />
      <h2 className="mt-8 font-medium">Gmail</h2>
      {said && (
        <p role="status" className="mt-2 text-sm">
          {said}
        </p>
      )}
      {gmail ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm">
              Sending as <span className="font-medium">{gmail.email}</span>, connected{" "}
              {lastSeen(gmail.connectedAt, now)}.
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/auth/google/gmail"
                className={`${buttonVariants({ variant: gmail.refusedAt ? "default" : "outline" })} min-h-11`}
              >
                Connect again
              </a>
              <DisconnectGmail email={gmail.email} />
            </div>
          </div>
          {gmail.refusedAt && (
            <p className="text-sm text-destructive">
              jobkit can no longer send from this account: Google refused its access, or the key
              that keeps its token changed. Connect again to go on sending.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Connect Gmail to approve and send an email in one click. jobkit asks Google only for
            permission to send, never to read your mail.
          </p>
          <a href="/api/auth/google/gmail" className={`${buttonVariants()} min-h-11`}>
            Connect Gmail
          </a>
        </div>
      )}
      <h2 className="mt-8 font-medium">Signed in</h2>
      <ul className="mt-2 divide-y divide-border">
        {devices.map((device) => (
          <li key={device.id} className="flex items-center justify-between gap-4 py-3">
            <div>
              <p>
                {device.label}
                {device.current && <span className="ml-2 text-sm text-primary">This device</span>}
              </p>
              <p className="text-sm text-muted-foreground">
                {device.kind === "google" ? "Signed in with Google" : "Paired phone"} · seen{" "}
                {lastSeen(device.lastSeenAt, now)}
              </p>
            </div>
            {!device.current && <RevokeButton sessionId={device.id} label={device.label} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
