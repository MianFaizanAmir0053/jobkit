import type { Metadata } from "next";

import { lastSeen } from "@/lib/time";
import {
  devicesForViewer,
  requestTime,
  requireSession,
  waitingPhonesForViewer,
} from "@/server/dal";

import { PairPanel } from "./PairPanel";
import { RevokeButton } from "./RevokeButton";

export const metadata: Metadata = { title: "Devices · jobkit" };

/** Devices (platform spec B2, B3): google sessions only; a paired phone is sent to its jobs. */
export default async function DevicesPage() {
  await requireSession({ kind: "google" });
  const [devices, waiting, now] = await Promise.all([
    devicesForViewer(),
    waitingPhonesForViewer(),
    requestTime(),
  ]);

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
