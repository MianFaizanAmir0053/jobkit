import { describe, expect, it } from "vitest";

import { OPENING, type OpeningDeps, openPage } from "./opening";
import type { Share } from "./pendingUploads";
import { MESSAGES, type Submitted } from "./submit";

/* What New job does as it opens (intake spec, "Inputs" and "Upload path", step 3), with the browser's pieces faked. */

const SHARE_ID = "11111111-1111-4111-8111-111111111111";

function share(overrides: Partial<Share> = {}): Share {
  return {
    id: SHARE_ID,
    images: [new File(["shot"], "shot-0.png")],
    text: "Northwind is hiring",
    url: "https://lnkd.in/x",
    arrivedAt: 1_000,
    openings: 1,
    ...overrides,
  };
}

/** A fake page: what is in the address and the store, and what each step answers. */
function page(
  setup: {
    shareId?: string | null;
    kept?: Share | null | Error;
    held?: Share | null;
    navigation?: string;
    before?: Submitted | "elsewhere" | null;
    started?: Submitted;
  } = {},
) {
  const events: string[] = [];
  const deps: OpeningDeps = {
    shareId: () => setup.shareId ?? null,
    dropShareId: () => events.push("drop id"),
    navigation: () => setup.navigation ?? "navigate",
    takeShare: async (id) => {
      events.push(`take ${id}`);
      if (setup.kept instanceof Error) throw setup.kept;
      return setup.kept ?? null;
    },
    holdShare: async (held, reason) => {
      events.push(`keep ${held.id}: ${reason}`);
    },
    heldShare: async () => setup.held ?? null,
    sweepShares: async () => {
      events.push("sweep");
    },
    finishKept: async (onStatus) => {
      events.push("finish kept");
      if (setup.before && setup.before !== "elsewhere") {
        onStatus("Finishing the upload of a job started before…");
      }
      return setup.before ?? null;
    },
    start: async (taken, onStatus) => {
      events.push(`start ${taken.id}`);
      onStatus("Uploading screenshot 1 of 1…");
      return setup.started ?? { ok: true, jobId: "job-2" };
    },
  };
  const ui = {
    status: (status: string) => events.push(`status ${status}`),
    hold: (held: Share, shown: { shown: boolean; stored: boolean }) =>
      events.push(`hold ${held.id}${shown.shown ? " shown" : ""}${shown.stored ? " stored" : ""}`),
  };
  return { deps, ui, events };
}

const auto = { autoStart: true, capped: false };

describe("openPage", () => {
  it("finishes an upload kept from before when the page opens with no share", async () => {
    const fake = page({ before: { ok: true, jobId: "job-1" } });

    expect(await openPage(fake.deps, auto, fake.ui)).toEqual({
      kind: "finished",
      outcome: { ok: true, jobId: "job-1" },
    });
    expect(fake.events).toContain("sweep");
  });

  it("does nothing with no share, no upload kept, or one another tab is finishing", async () => {
    for (const before of [null, "elsewhere" as const]) {
      const fake = page({ before });

      expect(await openPage(fake.deps, auto, fake.ui)).toEqual({ kind: "nothing" });
    }
  });

  it("starts a share untapped when the owner sent it, on its first opening, busy before the form fills", async () => {
    const fake = page({ shareId: SHARE_ID, kept: share() });

    expect(await openPage(fake.deps, auto, fake.ui)).toEqual({
      kind: "started",
      outcome: { ok: true, jobId: "job-2" },
    });
    expect(fake.events.filter((event) => event !== "sweep")).toEqual([
      `take ${SHARE_ID}`,
      "drop id",
      "finish kept",
      `status ${OPENING.starting}`,
      `hold ${SHARE_ID}`,
      `start ${SHARE_ID}`,
      "status Uploading screenshot 1 of 1…",
    ]);
  });

  it("keeps a share whose untapped start failed, for Start, unless the upload is kept to finish", async () => {
    const failed = page({
      shareId: SHARE_ID,
      kept: share(),
      started: { ok: false, message: MESSAGES.notArrived },
    });
    await openPage(failed.deps, auto, failed.ui);
    expect(failed.events).toContain(`keep ${SHARE_ID}: ${OPENING.startFailed}`);

    const kept = page({
      shareId: SHARE_ID,
      kept: share(),
      started: { ok: false, message: MESSAGES.notResumed },
    });
    await openPage(kept.deps, auto, kept.ui);
    expect(kept.events.some((event) => event.startsWith("keep"))).toBe(false);
  });

  it("holds a share another site may have sent, for the owner's tap, keeping it should the owner leave", async () => {
    const fake = page({ shareId: SHARE_ID, kept: share() });

    expect(await openPage(fake.deps, { autoStart: false, capped: false }, fake.ui)).toEqual({
      kind: "held",
      reason: OPENING.fromAnotherSite,
      before: null,
    });
    expect(fake.events).toContain(`keep ${SHARE_ID}: ${OPENING.fromAnotherSite}`);
    expect(fake.events).toContain(`hold ${SHARE_ID} shown stored`);
    expect(fake.events).not.toContain(`start ${SHARE_ID}`);
  });

  it("says first that a share may have come from another site, even after an upload from before", async () => {
    const before = { ok: false as const, message: MESSAGES.notResumed };
    const fake = page({ shareId: SHARE_ID, kept: share(), before });

    expect(await openPage(fake.deps, { autoStart: false, capped: false }, fake.ui)).toEqual({
      kind: "held",
      reason: OPENING.fromAnotherSite,
      before,
    });
  });

  it("holds a share opened before, or reached by a reload or Back, or counted by no worker", async () => {
    const cases: [Partial<Share>, string][] = [
      [{ openings: 2 }, "navigate"],
      [{ openings: 1 }, "reload"],
      [{ openings: 1 }, "back_forward"],
      [{ openings: 1 }, ""],
      [{ openings: undefined }, "navigate"],
    ];
    for (const [overrides, navigation] of cases) {
      const fake = page({ shareId: SHARE_ID, kept: share(overrides), navigation });

      expect(await openPage(fake.deps, auto, fake.ui)).toEqual({
        kind: "held",
        reason: OPENING.openedBefore,
        before: null,
      });
      expect(fake.events).not.toContain(`start ${SHARE_ID}`);
    }
  });

  it("finishes an upload kept from before first, then holds the share, which may be the same post", async () => {
    const before = { ok: false as const, message: MESSAGES.notResumed };
    const fake = page({ shareId: SHARE_ID, kept: share(), before });

    expect(await openPage(fake.deps, auto, fake.ui)).toEqual({
      kind: "held",
      reason: OPENING.afterUpload,
      before,
    });
    expect(fake.events.indexOf("finish kept")).toBeLessThan(
      fake.events.indexOf(`hold ${SHARE_ID} shown stored`),
    );
    expect(fake.events).not.toContain(`start ${SHARE_ID}`);
  });

  it("holds a share while another tab finishes an upload from before, which may be the same post", async () => {
    const fake = page({ shareId: SHARE_ID, kept: share(), before: "elsewhere" });

    expect(await openPage(fake.deps, auto, fake.ui)).toEqual({
      kind: "held",
      reason: OPENING.elsewhere,
      before: null,
    });
    expect(fake.events).not.toContain(`start ${SHARE_ID}`);
  });

  it("shows again a share held for the tap when the page opens with none in the address", async () => {
    const held = { ...share(), held: OPENING.fromAnotherSite };
    const fake = page({ held, before: { ok: true, jobId: "job-1" } });

    expect(await openPage(fake.deps, auto, fake.ui)).toEqual({
      kind: "held",
      reason: OPENING.fromAnotherSite,
      before: { ok: true, jobId: "job-1" },
    });
    expect(fake.events).toContain(`hold ${SHARE_ID} shown stored`);
    expect(fake.events).not.toContain(`start ${SHARE_ID}`);
  });

  it("says a share is gone, and finishes an upload kept from before without opening its job", async () => {
    const before = { ok: true as const, jobId: "job-1" };
    for (const kept of [null, new Error("IndexedDB failed")]) {
      const fake = page({ shareId: SHARE_ID, kept, before });

      expect(await openPage(fake.deps, auto, fake.ui)).toEqual({ kind: "gone", before });
      expect(fake.events).toContain("drop id");
    }
  });

  it("drops a share at the spend cap, starting nothing, and still finishes an upload kept from before", async () => {
    const fake = page({
      shareId: SHARE_ID,
      kept: share(),
      held: { ...share(), held: OPENING.fromAnotherSite },
      before: { ok: true, jobId: "job-1" },
    });

    expect(await openPage(fake.deps, { autoStart: true, capped: true }, fake.ui)).toEqual({
      kind: "finished",
      outcome: { ok: true, jobId: "job-1" },
    });
    expect(fake.events).toContain(`take ${SHARE_ID}`);
    expect(fake.events).toContain("drop id");
    expect(fake.events.some((event) => event.startsWith("hold"))).toBe(false);
    expect(fake.events).not.toContain(`start ${SHARE_ID}`);
  });
});
