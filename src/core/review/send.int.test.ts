import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import { offlineDns } from "@/adapters/dns";
import { fakeGmail, type FakeGmail } from "@/adapters/fakeGmail";
import { createLocalStorage, type LocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { asEmailKit, emailBody } from "@/core/drafting/kit";
import { setAddress } from "@/core/ledger/statuses";
import type { Db, GmailSender, QueryResult, Row } from "@/core/ports";
import { cryptoRandom } from "@/adapters/random";
import { issueSession } from "@/core/platform/sessions";
import { createTestDb } from "@/server/db/testDb";

import { openForJob } from "./applications";
import { approvalsKey, flagKey, NO_DECISIONS } from "./decisions";
import { storedDecisions } from "./jobView";
import { type JobView, jobView } from "./jobView";
import { recordReview } from "./kitReview";
import { markSent, recordHandoff, takeBackSent } from "./markSent";
import {
  BEGIN_WITHIN_MS,
  deliverSend,
  LATE_MS,
  scheduleSend,
  STUCK_MS,
  UNDO_MS,
  undoSend,
} from "./send";
import { type SkipKit, skipKit, takeBackSkip } from "./skipKit";
import { KIT_DRAFT, readyKit as kitFor, resetKitBed, SYNTHETIC } from "./testKit";

/* "Approve & send" from the owner's Gmail, with ten seconds to undo: decisions A20. */

let db: PgliteDb;
let clock: FakeClock;
let root: string;
let storage: LocalStorage;
let gmail: FakeGmail;
let connected: boolean;

const POST = "Northwind Analytics is hiring. Apply to jobs@example.com.";

const readyKit = (text: string, opts?: Parameters<typeof kitFor>[2]) =>
  kitFor({ db, clock, storage }, text, opts);

const view = async (id: string): Promise<JobView> => (await jobView({ db, clock }, id))!;

/** The delivery's ports: the fake Gmail, or one that does something more as it sends. */
const sendDeps = (sender: GmailSender = gmail, database: Db = db) => ({
  db: database,
  clock,
  storage,
  gmail: async (): Promise<GmailSender | null> => (connected ? sender : null),
});

/** The database, its first statement that records a send as sent failing, as on a dropped connection. */
function droppingFirstSentWrite(inner: Db): Db {
  let dropped = false;
  const wrap = (base: Db): Db => ({
    schema: base.schema,
    query: <T extends Row = Row>(sql: string, params?: readonly unknown[]) => {
      if (!dropped && sql.includes("set status = 'sent'")) {
        dropped = true;
        return Promise.reject<QueryResult<T>>(new Error("Connection terminated unexpectedly"));
      }
      return base.query<T>(sql, params);
    },
    exec: (sql) => base.exec(sql),
    tx: (fn) => base.tx((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

/** A Gmail that runs `meanwhile` while it has the email, then sends it as the fake does. */
const slowGmail = (meanwhile: () => Promise<void>): GmailSender => ({
  async send(message) {
    await meanwhile();
    return gmail.send(message);
  },
});

/** What the page showed as the owner pressed Send: the kit, the address, and any send that may have gone. */
const pressed = (shown: JobView, sessionId: string | null = null) => ({
  kit: shown.kitKey!,
  to: shown.handoff!.to,
  uncertain: shown.uncertain?.id ?? null,
  approved: approvalsKey(shown.kitParts!, shown.review!.decisions),
  words: shown.wordsKey!,
  sessionId,
});

const kinds = (shown: JobView) => shown.review!.gate.map((reason) => reason.kind);

/** Presses Approve & send on the kit as it stands. */
async function press(id: string, sessionId: string | null = null) {
  const scheduled = await scheduleSend({ db, clock }, id, pressed(await view(id), sessionId));
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
  it("refuses a press whose confirmation listed other sentences and flags than it would mark", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply to jobs@example.com.");
    const shown = await view(id);
    // The owner checks the sentence on the other device after this page was drawn.
    await recordReview({ db, clock, dns: offlineDns() }, id, { kind: "check", blockId: "S1" });

    expect(await scheduleSend({ db, clock }, id, pressed(shown))).toEqual({
      ok: false,
      reason: "changed",
    });
    expect((await scheduleSend({ db, clock }, id, pressed(await view(id)))).ok).toBe(true);
  });

  it("refuses a press from a page that showed other words, as one drawn before an edit on the other device", async () => {
    const id = await readyKit(POST);
    const shown = await view(id);
    const decide = (action: Parameters<typeof recordReview>[2]) =>
      recordReview({ db, clock, dns: offlineDns() }, id, action);
    await decide({ kind: "add", after: "S1", text: "I lead code reviews for a team of four." });
    await decide({ kind: "confirm", blockId: "N1" });

    expect(await scheduleSend({ db, clock }, id, pressed(shown))).toEqual({
      ok: false,
      reason: "changed",
    });
    expect((await scheduleSend({ db, clock }, id, pressed(await view(id)))).ok).toBe(true);
  });

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

  it("sends no kit whose words must change: it goes through Gmail, its flags ticked or not", async () => {
    // A must-have's line left to the owner: "Needs your line".
    const id = await readyKit(POST, {
      draft: {
        ...KIT_DRAFT,
        blocks: [
          ...KIT_DRAFT.blocks,
          {
            id: "S2",
            text: "",
            paragraph_break: true,
            class: "gap",
            fact_ids: [],
            fields: [],
            gap: { requirement_id: "R2", known_line_id: "", template_id: "", related_fact_id: "" },
          },
        ],
      },
      verdicts: [
        { blockId: "S1", verdict: "supported", companyClaim: false, note: "" },
        { blockId: "S2", verdict: "supported", companyClaim: false, note: "" },
      ],
    });
    const shown = await view(id);
    expect(shown.kitParts!.flags.map((flag) => flag.kind)).toContain("needs_your_line");

    expect(await scheduleSend({ db, clock }, id, pressed(shown))).toEqual({
      ok: false,
      reason: "words",
    });
    // "I will fix it in Gmail" on each: Open in Gmail opens, Approve & send still does not send.
    for (const flag of shown.kitParts!.flags) {
      await recordReview({ db, clock, dns: offlineDns() }, id, {
        kind: "check_flag",
        flag: flagKey(flag),
      });
    }
    expect(kinds(await view(id))).toEqual([]);
    expect(await scheduleSend({ db, clock }, id, pressed(await view(id)))).toEqual({
      ok: false,
      reason: "words",
    });
    expect((await view(id)).send).toBeNull();
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

  it("says a send jobkit lost track of may have gone, then lets the owner press again", async () => {
    const id = await readyKit(POST);
    const lost = await press(id);
    // The server stopped while Gmail was sending it.
    await db.query(
      "update {{schema}}.kit_sends set status = 'sending', updated_at = $2 where id = $1",
      [lost.id, clock.now()],
    );
    expect(kinds(await view(id))).toEqual(["sending"]);
    clock.advance(STUCK_MS + 1);

    // Before any press, the page says it cannot tell, and Mark sent is open for when it went.
    const stuck = await view(id);
    expect(kinds(stuck)).toEqual([]);
    expect(stuck.send).toMatchObject({
      id: lost.id,
      status: "unknown",
      error: expect.stringMatching(/Sent folder/),
    });

    const again = await press(id);

    expect(again.status).toBe("scheduled");
    const { rows } = await db.query<{ status: string; error: string }>(
      "select status, error from {{schema}}.kit_sends where id = $1",
      [lost.id],
    );
    expect(rows[0]).toEqual({ status: "unknown", error: expect.stringMatching(/Sent folder/) });
  });

  it("is not offered for a post that asks for a file besides the CV, ticked or not", async () => {
    const id = await readyKit(POST, {
      record: (record) => ({
        ...record,
        roles: record.roles.map((role) => ({
          ...role,
          required_attachments: [
            { name: "CV", is_cv: true },
            { name: "Writing sample", is_cv: false },
          ],
        })),
      }),
    });
    const dns = { db, clock, dns: offlineDns() };
    await recordReview(dns, id, { kind: "check", blockId: "S1" });
    expect(await scheduleSend({ db, clock }, id, pressed(await view(id)))).toEqual({
      ok: false,
      reason: "attachment",
    });

    // The tick promises to attach it in Gmail, which this way never opens.
    await recordReview(dns, id, { kind: "attach", id: "A2", ticked: true });
    expect(kinds(await view(id))).toEqual([]);
    expect(await scheduleSend({ db, clock }, id, pressed(await view(id)))).toEqual({
      ok: false,
      reason: "attachment",
    });
  });

  it("refuses a press from a page that did not show a send that may have gone", async () => {
    const id = await readyKit(POST);
    gmail.answerWith({ ok: false, reason: "unknown", message: "fetch failed" });
    const first = await press(id);
    clock.advance(UNDO_MS);
    await deliverSend(sendDeps(), id, first.id);
    const shown = await view(id);

    // A page drawn before it may have gone, as on the other device.
    expect(await scheduleSend({ db, clock }, id, { ...pressed(shown), uncertain: null })).toEqual({
      ok: false,
      reason: "uncertain",
    });
    expect(await scheduleSend({ db, clock }, id, pressed(shown))).toMatchObject({ ok: true });
  });

  it("takes no decision while jobkit sends the email, a handoff's included", async () => {
    const id = await readyKit(POST);
    await press(id);

    expect(
      await recordReview({ db, clock, dns: offlineDns() }, id, { kind: "uncheck", blockId: "S1" }),
    ).toEqual({ ok: false, reason: "sending" });
    const shown = await view(id);
    expect(
      await recordHandoff({ db, clock }, id, { kit: shown.kitKey!, words: shown.wordsKey! }),
    ).toEqual({ ok: false, reason: "sending" });
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

  it("takes Undo of a send that failed as done: it did not go", async () => {
    const id = await readyKit(POST);
    gmail.answerWith({ ok: false, reason: "failed", message: "Gmail answered 400: bad request" });
    const send = await press(id);
    clock.advance(UNDO_MS);
    await deliverSend(sendDeps(), id, send.id);

    expect(await undoSend({ db, clock }, id, send.id)).toEqual({ ok: true });
  });
});

describe("deliverSend", () => {
  it("sends the email as the owner edited it, and records the edit as a factual one", async () => {
    const id = await readyKit(POST);
    const shown = await view(id);
    const claim = shown.draft!.kit.blocks.find((block) => block.class === "claim")!;
    const words = "I have built production React applications for four years.";
    for (const action of [
      { kind: "edit", blockId: claim.id, text: words },
      { kind: "confirm", blockId: claim.id },
    ] as const) {
      expect(await recordReview({ db, clock, dns: offlineDns() }, id, action)).toMatchObject({
        ok: true,
      });
    }
    const send = await press(id);
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({ ok: true });

    const message = partsOf(gmail.sent[0]!);
    expect(message.text).toContain(words);
    expect(message.text).not.toContain(claim.text);
    const { rows } = await db.query(
      "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ changed: [`sentence:${claim.id}`], factual_edit: true }]);
  });

  it("sends the owner's own sentence and not one they deleted, and records both as factual edits", async () => {
    const id = await readyKit(POST);
    const drafted = (await view(id)).draft!.kit.blocks[0]!;
    const words = "I lead code reviews for a team of four.";
    for (const action of [
      { kind: "add", after: drafted.id, text: words },
      { kind: "confirm", blockId: "N1" },
      { kind: "delete", blockId: drafted.id },
    ] as const) {
      expect(await recordReview({ db, clock, dns: offlineDns() }, id, action)).toMatchObject({
        ok: true,
      });
    }
    const send = await press(id);
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, send.id)).toMatchObject({ ok: true });

    const message = partsOf(gmail.sent[0]!);
    expect(message.text).toContain(words);
    expect(message.text).not.toContain(drafted.text);
    const { rows } = await db.query(
      "select changed, factual_edit from {{schema}}.draft_outcomes where job_id = $1",
      [id],
    );
    expect(rows).toEqual([
      { changed: [`sentence:${drafted.id}`, "sentence:N1"], factual_edit: true },
    ]);
  });

  it("sends the email with the signature and the CV, and marks it sent with Gmail's IDs", async () => {
    const id = await readyKit(POST);
    const kit = asEmailKit((await view(id)).draft!.kit);
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
    // The kit is drafted again: its S1 is another sentence now.
    await db.query(
      `update {{schema}}.job_stage_runs set output_hash = 'drafted again'
        where job_id = $1 and stage = 'draft'`,
      [id],
    );
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
      send: { status: "unknown", error: expect.stringMatching(/cannot tell.*Sent folder/) },
    });
    // Mark sent is open, for when it went.
    expect(kinds(await view(id))).toEqual([]);
  });

  it("keeps warning that a send may have gone, though a later one was undone or failed", async () => {
    const id = await readyKit(POST);
    gmail.answerWith({ ok: false, reason: "unknown", message: "fetch failed" });
    const first = await press(id);
    clock.advance(UNDO_MS);
    await deliverSend(sendDeps(), id, first.id);
    gmail.answerWith(null);
    const second = await press(id);
    await undoSend({ db, clock }, id, second.id);

    const after = await view(id);

    expect(after.send).toMatchObject({ id: second.id, status: "cancelled" });
    expect(after.uncertain).toMatchObject({
      id: first.id,
      status: "unknown",
      error: expect.stringMatching(/Sent folder/),
    });
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

  it("records an email Gmail took though the session that pressed it signed out meanwhile", async () => {
    const id = await readyKit(POST);
    const { session } = await issueSession(
      { db, clock, random: cryptoRandom },
      { kind: "google", label: "phone" },
    );
    const send = await press(id, session.id);
    clock.advance(UNDO_MS);
    const signingOut = slowGmail(async () => {
      await db.query("delete from {{schema}}.sessions where id = $1", [session.id]);
    });

    expect(await deliverSend(sendDeps(signingOut), id, send.id)).toMatchObject({
      send: { status: "sent", messageId: "m1", error: null },
    });
    expect((await view(id)).application!.status).toBe("sent");
  });

  it("records an email Gmail took after a press made meanwhile, which then finds it sent", async () => {
    const id = await readyKit(POST);
    const first = await press(id);
    clock.advance(UNDO_MS);
    let second = "";
    // Gmail takes longer than jobkit waits for it, and the owner presses again meanwhile.
    const slow = slowGmail(async () => {
      clock.advance(STUCK_MS + 1);
      second = (await press(id)).id;
    });

    expect(await deliverSend(sendDeps(slow), id, first.id)).toMatchObject({
      send: { status: "sent", messageId: "m1" },
    });
    clock.advance(UNDO_MS);
    expect(await deliverSend(sendDeps(), id, second)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/already/) },
    });
    expect(gmail.sent).toHaveLength(1);
  });

  it("records Gmail's acceptance though the first write of it meets a dropped connection", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS);

    expect(
      await deliverSend(sendDeps(gmail, droppingFirstSentWrite(db)), id, send.id),
    ).toMatchObject({ send: { status: "sent", messageId: "m1" } });
    expect((await view(id)).application!.status).toBe("sent");
  });

  it("marks sent over the skip an email Gmail took after the owner skipped past it, as it looked stuck", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS);
    const seen: { skipped?: SkipKit; skippedAt?: Date | null } = {};
    // Gmail takes longer than jobkit waits for it: the page warns that the send may have gone, and
    // the owner skips the job past the warning.
    const slow = slowGmail(async () => {
      clock.advance(STUCK_MS + 1);
      const shown = await view(id);
      seen.skipped = await skipKit({ db, clock }, id, null, {
        kit: shown.kitKey,
        uncertain: send.id,
      });
      seen.skippedAt = (await view(id)).application?.skippedAt;
      clock.advance(1_000);
    });

    expect(await deliverSend(sendDeps(slow), id, send.id)).toMatchObject({
      send: { status: "sent", messageId: "m1" },
    });
    expect(seen.skipped).toEqual({ ok: true, changed: true });
    expect((await view(id)).application).toMatchObject({ status: "sent", skippedAt: null });
    const { rows } = await db.query<{ from_status: string | null; to_status: string }>(
      `select from_status, to_status from {{schema}}.status_changes
        where application_id = (select id from {{schema}}.applications where job_id = $1)`,
      [id],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { from_status: "kit_ready", to_status: "skipped" },
        { from_status: "skipped", to_status: "kit_ready" },
        { from_status: "kit_ready", to_status: "sent" },
      ]),
    );
    // It went: neither the skip nor the send is taken back.
    expect(await takeBackSkip({ db, clock }, id, null, seen.skippedAt!)).toEqual({
      ok: false,
      reason: "sent",
    });
    expect(await takeBackSent({ db, clock }, id, null)).toEqual({
      ok: false,
      reason: "sent-by-jobkit",
    });
  });

  it("holds a later send once an earlier one Gmail took late is recorded", async () => {
    const id = await readyKit(POST);
    const first = await press(id);
    // The first send's server stalled while Gmail had it, so the owner pressed again.
    await db.query(
      "update {{schema}}.kit_sends set status = 'sending', updated_at = $2 where id = $1",
      [first.id, clock.now()],
    );
    clock.advance(STUCK_MS + 1);
    const second = await press(id);
    // Then Gmail's answer to the first came through.
    await db.query(
      "update {{schema}}.kit_sends set status = 'sent', gmail_message_id = 'm0' where id = $1",
      [first.id],
    );
    expect(kinds(await view(id))).toEqual(["sent"]);
    clock.advance(UNDO_MS);

    expect(await deliverSend(sendDeps(), id, second.id)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/already/) },
    });
    expect(gmail.sent).toEqual([]);
  });

  it("begins no send whose delivery took too long to reach Gmail", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS);
    const late = {
      db,
      clock,
      storage,
      // The connection's lookup stalls past the time a delivery may take to begin.
      gmail: async (): Promise<GmailSender | null> => {
        clock.advance(BEGIN_WITHIN_MS + 1);
        return gmail;
      },
    };

    expect(await deliverSend(late, id, send.id)).toMatchObject({
      send: { status: "failed", error: expect.stringMatching(/not sent/i) },
    });
    expect(gmail.sent).toEqual([]);
  });

  it("records in the ledger the address the email went to", async () => {
    const id = await readyKit("Northwind Analytics is hiring. Apply on our site.");
    const dns = { db, clock, dns: offlineDns() };
    await recordReview(dns, id, { kind: "retype", value: "hr@northwind.io" });
    const send = await press(id);
    clock.advance(UNDO_MS);
    const { kitKey, role } = await view(id);
    // Another address is kept as Gmail sends, by a way the page no longer offers.
    const retyped = slowGmail(async () => {
      await db.query(
        "update {{schema}}.kit_reviews set decisions = $3::jsonb where job_id = $1 and role_id = $2",
        [
          id,
          role!.id,
          storedDecisions(kitKey!, {
            ...NO_DECISIONS,
            checked: ["S1"],
            retyped: { value: "careers@northwind.io", checks: [] },
          }),
        ],
      );
    });

    await deliverSend(sendDeps(retyped), id, send.id);

    const { rows } = await db.query<{ address: string }>(
      "select address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ address: "hr@northwind.io" }]);
  });

  it("records the address jobkit sent the email to, though a skip kept another the owner typed since", async () => {
    const id = await readyKit(POST);
    const applicationId = (await openForJob({ db, clock }, id, null))!;
    const send = await press(id);
    clock.advance(UNDO_MS);
    // Once the send looked stuck, the owner typed another address, which a skip then kept.
    const retyped = slowGmail(async () => {
      clock.advance(STUCK_MS + 1);
      await setAddress({ db }, applicationId, "hr@example.com");
    });

    await deliverSend(sendDeps(retyped), id, send.id);

    const { rows } = await db.query<{ status: string; address: string }>(
      "select status, address from {{schema}}.applications where job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ status: "sent", address: "jobs@example.com" }]);
  });

  it("holds the kit as sent once jobkit sent it, though the ledger did not record it", async () => {
    const id = await readyKit(POST);
    const { kitKey, role } = await view(id);
    await db.query(
      `insert into {{schema}}.kit_sends
         (job_id, role_id, kit, to_address, status, send_at, gmail_message_id, created_at, updated_at)
       values ($1, $2, $3, 'jobs@example.com', 'sent', $4, 'm9', $4, $4)`,
      [id, role!.id, kitKey, clock.now()],
    );

    expect(kinds(await view(id))).toEqual(["sent"]);
  });

  it("lets a send whose moment passed lapse, rather than send it late", async () => {
    const id = await readyKit(POST);
    const send = await press(id);
    clock.advance(UNDO_MS + LATE_MS + 1);
    // Nothing holds the kit while no one is sending it, and the page says it did not go.
    const lapsed = await view(id);
    expect(kinds(lapsed)).toEqual([]);
    expect(lapsed.send).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/not sent/i),
    });

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
