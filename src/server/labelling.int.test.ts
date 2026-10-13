import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeClock, type FakeClock } from "@/adapters/clock";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { issueSession } from "@/core/platform/sessions";
import type { AppConfig } from "@/server/config";
import { createTestDb } from "@/server/db/testDb";

import {
  getArchiveImage,
  labellingAllowed,
  type LabellingDeps,
  postAdopt,
  postDismiss,
  postLabels,
} from "./labelling";

/* The labelling page's routes: evals spec, "Labelling", and AC2's local-only rule. */

const ORIGIN = "http://localhost:3000";
const CASE = "2026-03-16-8282e9a1";
const config: AppConfig = {
  appOrigin: ORIGIN,
  ownerEmail: "owner@example.com",
  google: { clientId: "client-123", clientSecret: "fixture-client-secret" },
};

const LABELS = {
  company: "Northwind Analytics",
  role: "Senior Engineer",
  route: "email",
  contact: "jobs@northwind.example",
  eligibility: "eligible",
  must: ["4+ years with React"],
  cropShowsContact: true,
};

let db: PgliteDb;
let clock: FakeClock;
let archive: string;

const deps = (allowed = true): LabellingDeps => ({ db, clock, config, allowed, archive });

async function signedIn(kind: "google" | "paired" = "google"): Promise<string> {
  const { token } = await issueSession(
    { db, clock, random: cryptoRandom },
    { kind, label: kind === "google" ? "laptop" : "phone" },
  );
  return token;
}

function request(
  method: "GET" | "POST",
  path: string,
  cookie?: string,
  body?: unknown,
): NextRequest {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookie) headers.cookie = `jobkit_session=${cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  clock = fakeClock();
  archive = mkdtempSync(join(tmpdir(), "jobkit-labelling-"));
  mkdirSync(join(archive, CASE));
  writeFileSync(join(archive, CASE, "email.eml"), "Subject: Application\r\n\r\nHello");
  mkdirSync(join(archive, "_screenshots"));
  writeFileSync(join(archive, "_screenshots", "Screenshot_20260314-101500.png"), "image");
});

afterEach(() => {
  rmSync(archive, { recursive: true, force: true });
});

describe("labellingAllowed", () => {
  it("is the laptop's dev server with JOBKIT_LOCAL_EVALS=1 only", () => {
    expect(labellingAllowed({ JOBKIT_LOCAL_EVALS: "1" }, "development")).toBe(true);
    expect(labellingAllowed({}, "development")).toBe(false);
    expect(labellingAllowed({ JOBKIT_LOCAL_EVALS: "1" }, "test")).toBe(false);
    expect(labellingAllowed({ JOBKIT_LOCAL_EVALS: "1" }, "production")).toBe(false);
  });
});

describe("the labelling routes", () => {
  it("are not there at all where labelling is not allowed", async () => {
    const cookie = await signedIn();

    expect(
      (await postLabels(request("POST", "/x", cookie, LABELS), deps(false), CASE)).status,
    ).toBe(404);
    expect(
      (await postAdopt(request("POST", "/x", cookie, { file: "a.png" }), deps(false), CASE)).status,
    ).toBe(404);
    expect(
      (await getArchiveImage(request("GET", "/x", cookie), deps(false), CASE, "a.png")).status,
    ).toBe(404);
  });

  it("answer only the laptop's own session", async () => {
    expect((await postLabels(request("POST", "/x", undefined, LABELS), deps(), CASE)).status).toBe(
      401,
    );
    const phone = await signedIn("paired");
    // An approved phone: still not the laptop.
    await db.query("update {{schema}}.sessions set approved_at = $1 where kind = 'paired'", [
      clock.now(),
    ]);
    expect(
      (await getArchiveImage(request("GET", "/x", phone), deps(), "_screenshots", "x.png")).status,
    ).toBe(403);
  });

  it("save a case's labels, refusing ones that do not fit and cases that do not exist", async () => {
    const cookie = await signedIn();

    const saved = await postLabels(request("POST", "/x", cookie, LABELS), deps(), CASE);

    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(join(archive, CASE, "labels.json"), "utf8"))).toMatchObject({
      ...LABELS,
      labelledAt: "2026-10-06T09:00:00.000Z",
    });
    const unfit = await postLabels(
      request("POST", "/x", cookie, { ...LABELS, route: "fax", company: 7 }),
      deps(),
      CASE,
    );
    expect(unfit.status).toBe(400);
    expect(await unfit.json()).toEqual({ error: "bad-labels", fields: ["company", "route"] });
    expect(
      (await postLabels(request("POST", "/x", cookie, LABELS), deps(), "2026-01-01-00000000"))
        .status,
    ).toBe(404);
  });

  it("set a case aside as not an application, and only a case", async () => {
    const cookie = await signedIn();

    expect((await postDismiss(request("POST", "/x", cookie), deps(false), CASE)).status).toBe(404);
    const dismissed = await postDismiss(request("POST", "/x", cookie), deps(), CASE);

    expect(await dismissed.json()).toEqual({ dismissed: true });
    expect(existsSync(join(archive, "_dismissed", CASE, "email.eml"))).toBe(true);
    expect((await postDismiss(request("POST", "/x", cookie), deps(), CASE)).status).toBe(404);
    expect(
      (await postDismiss(request("POST", "/x", cookie), deps(), "../_screenshots")).status,
    ).toBe(404);
  });

  it("move a pool screenshot into a case, and show it, but nothing outside the archive's images", async () => {
    const cookie = await signedIn();

    const moved = await postAdopt(
      request("POST", "/x", cookie, { file: "Screenshot_20260314-101500.png" }),
      deps(),
      CASE,
    );

    expect(await moved.json()).toEqual({ name: "Screenshot_20260314-101500.png" });
    expect(existsSync(join(archive, CASE, "Screenshot_20260314-101500.png"))).toBe(true);
    const image = await getArchiveImage(
      request("GET", "/x", cookie),
      deps(),
      CASE,
      "Screenshot_20260314-101500.png",
    );
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(await image.text()).toBe("image");
    expect(
      (await postAdopt(request("POST", "/x", cookie, { file: "../email.eml" }), deps(), CASE))
        .status,
    ).toBe(404);
    expect(
      (await getArchiveImage(request("GET", "/x", cookie), deps(), CASE, "email.eml")).status,
    ).toBe(404);
  });
});
