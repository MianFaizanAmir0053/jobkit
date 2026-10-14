import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { fakeGmail, type FakeGmail } from "@/adapters/fakeGmail";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { emailBody } from "@/core/drafting/kit";
import type { GmailSender } from "@/core/ports";
import { createTestDb } from "@/server/db/testDb";

import { NO_DECISIONS } from "./decisions";
import { type JobView, jobView } from "./jobView";
import { recordReview } from "./kitReview";
import { markSent, takeBackSent } from "./markSent";
import { deliverSend, LATE_MS, scheduleSend, STUCK_MS, UNDO_MS, undoSend } from "./send";
import { readyKit as kitFor, resetKitBed, SYNTHETIC } from "./testKit";

/* "Approve & send" from the owner's Gmail, with ten seconds to undo: decisions A20. */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let gmail: FakeGmail;
let connected: boolean;

const POST = "Northwind Analytics is hiring. Apply to jobs@example.com.";

const readyKit = (text: string) => kitFor({ db, clock, storage }, text);

const view = async (id: string): Promise<JobView> => (await jobView({ db, clock }, id))!;

const sendDeps = () => ({
  db,
  clock,
  storage,
  gmail: async (): Promise<GmailSender | null> => (connected ? gmail : null),
});

/** What the page showed as the owner pressed Send: the kit and the address. */
const pressed = (shown: JobView) => ({
  kit: shown.kitKey!,
  to: shown.handoff!.to,
  sessionId: null,
});

const kinds = (shown: JobView) => shown.review!.gate.map((reason) => reason.kind);

/** Presses Approve & send on the kit as it stands. */
async function press(id: string) {
  const scheduled = await scheduleSend({ db, clock }, id, pressed(await view(id)));
  if (!scheduled.ok) throw new Error(`not scheduled: ${scheduled.reason}`);
  return scheduled.send;
}

/** A MIME message's parts: its headers, its text decoded, and its attachment's headers and bytes. */
function partsOf(message: string) {
  const boundary = /boundary="([^"]+)"/.exec(message)![1]!;
  const [head, text, attachment] = message.split(`--${boundary}`);
  const decoded = (part: string) => {
    const at = part.indexOf("\r\n\r\n");
    return {
      headers: part.slice(0, at),
      bytes: Buffer.from(part.slice(at + 4).replace(/\r\n/g, ""), "base64"),
    };
  };
  const subject = /^Subject: ((?:.*)(?:\r\n .*)*)/m
    .exec(head!)![1]!
    .split("\r\n ")
    .map((word) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(word)![1]!, "base64").toString("utf8"))
    .join("");
  return {
    head: head!,
    subject,
    text: decoded(text!).bytes.toString("utf8").replace(/\r\n/g, "\n"),
    attachment: decoded(attachment!),
  };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  clock = fakeClock();
  root = mkdtempSync(join(tmpdir(), "jobkit-send-"));
  storage = createLocalStorage({ root, origin: "http://localhost:3000" });
  gmail = fakeGmail();
  connected = true;
  await resetKitBed({ db, clock, storage });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scheduleSend", () => {
  it("approves every flagged sentence and flag shown, and sends ten seconds later", async () => {
    const id = await readyKit(POST);
    expect(kinds(await view(id))).toEqual(["judge"]);

    const send = await press(id);

    expect(send).toMatchObject({
      status: "scheduled",
      to: "jobs@example.com",
      sendAt: new Date(clock.now().getTime() + UNDO_MS),
    });
    const after = await view(id);
    expect(after.review!.decisions.checked).toEqual(["S1"]);
    // Open in Gmail, the copy buttons and Mark sent wait while it counts down.
    expect(kinds(after)).toEqual(["sending"]);
    expect(after.send).toMatchObject({ id: send.id, status: "scheduled" });
    expect(await markSent({ db, clock }, id, null, { changedInGmail: false })).toEqual({
      ok: false,
      reason: "held",
    });
  });

  it("keeps the hard stops: refused, with nothing approved, while one holds the kit", async () => {
    const first = await readyKit(POST);
    await recordReview({ db, clock, dns: offlineDns() }, first, { kind: "check", blockId: "S1" });
    await markSent({ db, clock }, first, null, { changedInGmail: false });
    // The same post again, after the first was sent: a possible repeat, which only "Apply again"
    // clears.
    const again = await readyKit(POST);
    expect(new Set(kinds(await view(again)))).toEqual(new Set(["duplicate", "judge"]));

    expect(await scheduleSend({ db, clock }, again, pressed(await view(again)))).toEqual({
      ok: false,
      reason: "held",
    });
    const after = await view(again);
    expect(after.review!.decisions).toEqual(NO_DECISIONS);
    expect(after.send).toBeNull();
  });

  it("refuses a press from a page drawn on another kit, or showing another address", async () => {
    const id = await readyKit(POST);
    const shown = pressed(await view(id));

    expect(await scheduleSend({ db, clock }, id, { ...shown, kit: "another kit" })).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(await scheduleSend({ db, clock }, id, { ...shown, to: "hr@example.com" })).toEqual({
      ok: false,
      reason: "changed",
    });
    expect((await view(id)).send).toBeNull();
  });

  it("refuses a second press while the first counts down, and once the email went", async () => {
    const id = await readyKit(POST);
    const first = await press(id);

    expect(await scheduleSend({ db, clock }, id, pressed(await view(id)))).toEqual({
      ok: false,
      reason: "sending",
    });
    clock.advance(UNDO_MS);
    await deliverSend(sendDeps(), id, first.id);
    expect(await scheduleSend({ db, clock }, id, pressed(await view(id)))).toEqual({
      ok: false,
      reason: "sent",
    });
    expect(gmail.sent).toHaveLength(1);
  });

  it("frees a send jobkit lost track of, so the owner can press again", async () => {
    const id = await readyKit(POST);
    const lost = await press(id);
    // The server stopped while Gmail was sending it.
    await db.query(
      "update {{schema}}.kit_sends set status = 'sending', updated_at = $2 where id = $1",
      [lost.id, clock.now()],
    );
    expect(kinds(await view(id))).toEqual(["sending"]);
    clock.advance(STUCK_MS + 1);
    expect(kinds(await view(id))).toEqual([]);

    const again = await press(id);

    expect(again.status).toBe("scheduled");
    const { rows } = await db.query<{ status: string; error: string }>(
      "select status, error from {{schema}}.kit_sends where id = $1",
      [lost.id],
    );
    expect(rows[0]).toEqual({ status: "failed", error: expect.stringMatching(/Sent folder/) });
  });
});

describe("undoSend", () => {
  it("stops the send before it goes; the kit opens again, its checks kept", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(5_000);

    expect(await undoSend({ db, clock }, id, send.id)).toEqual({ ok: true });
    expect(await undoSend({ db, clock }, id, send.id)).toEqual({ ok: true });

    clock.advance(UNDO_MS);
    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      ok: true,
      send: { status: "cancelled" },
    });
    expect(gmail.sent).toEqual([]);
    const after = await view(id);
    expect(kinds(after)).toEqual([]);
    expect(after.review!.decisions.checked).toEqual(["S1"]);
  });

  it("is too late once the email went", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS);
    await deliverSend(sendDeps(), id, send.id);

    expect(await undoSend({ db, clock }, id, send.id)).toEqual({ ok: false, reason: "too-late" });
    expect(await undoSend({ db, clock }, id, "00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("deliverSend", () => {
  it("sends the email with the signature and the CV, and marks it sent with Gmail's IDs", async () => {
    const id = await readyKit(POST);
    const kit = (await view(id)).draft!.kit;
    const send = await press(id);
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      ok: true,
      send: { status: "sent", messageId: "m1" },
    });

    expect(gmail.sent).toHaveLength(1);
    const message = partsOf(gmail.sent[0]!);
    expect(message.head).toMatch(/^To: jobs@example\.com\r$/m);
    expect(message.subject).toBe(kit.subject);
    expect(message.text).toBe(
      `${emailBody(kit)}\nSam Rivera\nPortfolio: https://portfolio.example.com\nWhatsApp: +1 202 555 0143`,
    );
    expect(message.attachment.headers).toMatch(/filename="Sam Rivera CV\.pdf"/);
    expect(message.attachment.bytes.equals(readFileSync(join(SYNTHETIC, "cv.sample.pdf")))).toBe(
      true,
    );
    const after = await view(id);
    expect(after.application!.status).toBe("sent");
    expect(kinds(after)).toEqual(["sent"]);
    expect(after.send).toMatchObject({ status: "sent", messageId: "m1" });
    const { rows } = await db.query(
      "select changed, changed_in_gmail, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ changed: [], changed_in_gmail: false, factual_edit: false }]);
  });

  it("waits until it is due", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS - 1_000);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      ok: false,
      reason: "not-due",
    });
    expect(gmail.sent).toEqual([]);
  });

  it("sends once when two deliveries meet", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS);

    await Promise.all([deliverSend(sendDeps(), id, send.id), deliverSend(sendDeps(), id, send.id)]);

    expect(gmail.sent).toHaveLength(1);
  });

  it("sends nothing when the kit changed during the countdown", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    // On the phone, the owner takes back "I checked this".
    await recordReview({ db, clock, dns: offlineDns() }, id, { kind: "uncheck", blockId: "S1" });
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      ok: true,
      send: { status: "failed", error: expect.stringMatching(/not sent/i) },
    });
    expect(gmail.sent).toEqual([]);
    expect((await view(id)).application?.status).not.toBe("sent");
  });

  it("fails with Gmail's reason, and leaves the kit open to send again", async () => {
    const id = await readyKit(POST);
    gmail.answerWith({ ok: false, reason: "failed", message: "Gmail answered 500: backend error" });
    const send = await press(id);
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      ok: true,
      send: { status: "failed", error: expect.stringContaining("backend error") },
    });
    const after = await view(id);
    expect(kinds(after)).toEqual([]);
    expect(after.application?.status).not.toBe("sent");

    gmail.answerWith(null);
    const again = await press(id);
    clock.advance(UNDO_MS);
    expect(await deliverSend(sendDeps(), id, again.id)).toMatchObject({
      ok: true,
      send: { status: "sent" },
    });
  });

  it("says to check Gmail's Sent folder when Gmail's answer is lost, since it may have gone", async () => {
    const id = await readyKit(POST);
    gmail.answerWith({ ok: false, reason: "unknown", message: "fetch failed" });
    const send = await press(id);
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/cannot tell.*Sent folder/) },
    });
    // Mark sent is open, for when it went.
    expect(kinds(await view(id))).toEqual([]);
  });

  it("says to connect Gmail again when Google refuses, and to connect it when it is not", async () => {
    const id = await readyKit(POST);
    gmail.answerWith({ ok: false, reason: "unauthorised", message: "Gmail answered 401" });
    const refused = await press(id);
    clock.advance(UNDO_MS);
    expect(await deliverSend(sendDeps(), id, refused.id)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/connect Gmail again/i) },
    });

    connected = false;
    const unconnected = await press(id);
    clock.advance(UNDO_MS);
    expect(await deliverSend(sendDeps(), id, unconnected.id)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/connect Gmail/i) },
    });
  });

  it("lets a send whose moment passed lapse, rather than send it late", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS + LATE_MS + 1);
    // Nothing holds the kit while no one is sending it.
    expect(kinds(await view(id))).toEqual([]);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/not sent/i) },
    });
    expect(gmail.sent).toEqual([]);
  });
});

describe("takeBackSent", () => {
  it("takes back no email jobkit sent: it went", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS);
    await deliverSend(sendDeps(), id, send.id);

    expect(await takeBackSent({ db, clock }, id, null)).toEqual({
      ok: false,
      reason: "sent-by-jobkit",
    });
    expect((await view(id)).application!.status).toBe("sent");
  });
});
