import { describe, expect, it } from "vitest";

import { TOO_TALL } from "@/core/intake/encode";

import type { Prepared } from "./prepare";
import { MESSAGES, type SubmitDeps, submitJob } from "./submit";

/* Start's flow with the browser's pieces faked: intake AC1, AC3 and AC6 from the phone's side. */

const hash = (n: number) => n.toString(16).padStart(64, "0");

function screenshot(n: number, overrides: { height?: number; bytes?: number } = {}): Prepared {
  const bytes = overrides.bytes ?? 1_000 + n;
  return {
    ok: true,
    blob: new Blob([`image ${n}`]),
    meta: {
      contentType: "image/webp",
      bytes,
      width: 1080,
      height: overrides.height ?? 2400,
      sha256: hash(n),
    },
    tiles: 1,
  };
}

type Call = { url: string; method: string; body: unknown };

/** A fake browser: `prepared` by file name, and `answer` for each request in turn. */
function browser(
  prepared: Record<string, Prepared>,
  answer: (call: Call, calls: Call[]) => Response | Error,
  times: number[] = [0],
) {
  const calls: Call[] = [];
  const statuses: string[] = [];
  const deps: SubmitDeps = {
    prepare: async (file) => prepared[file.name]!,
    fetch: async (url, init) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      const call = { url, method: init.method ?? "GET", body };
      calls.push(call);
      const answered = answer(call, calls);
      if (answered instanceof Error) throw answered;
      return answered;
    },
    now: () => times.shift() ?? 0,
  };
  return { deps, calls, statuses, onStatus: (status: string) => statuses.push(status) };
}

const file = (name: string) => new File(["x"], name);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The server's happy answers: created with one upload URL per image, stored, confirmed. */
function server(jobId: string, uploads: number) {
  return (call: Call): Response => {
    if (call.url === "/api/jobs") {
      return json(
        {
          jobId,
          uploads: Array.from({ length: uploads }, (_, i) => ({
            imageId: `image-${i}`,
            url: `http://localhost:3000/api/dev/storage/upload/token-${i}`,
          })),
          queued: uploads === 0,
        },
        201,
      );
    }
    if (call.method === "PUT") return new Response(null, { status: 200 });
    return json({ queued: true }, 202);
  };
}

describe("submitJob", () => {
  it("starts a paste-only job with one request, timing it from the tap", async () => {
    const fake = browser({}, server("job-1", 0), [1_000, 3_500]);

    const submitted = await submitJob(
      fake.deps,
      { files: [], text: "We're hiring. Apply at jobs@example.com" },
      fake.onStatus,
    );

    expect(submitted).toEqual({ ok: true, jobId: "job-1" });
    expect(fake.calls).toEqual([
      {
        url: "/api/jobs",
        method: "POST",
        body: {
          images: [],
          pastedText: "We're hiring. Apply at jobs@example.com",
          clientElapsedMs: 2_500,
        },
      },
    ]);
    expect(fake.statuses).toEqual(["Starting the job…"]);
  });

  it("sends each screenshot's metadata once, uploads each to its own URL in order, then confirms", async () => {
    const one = screenshot(1);
    const two = screenshot(2);
    const fake = browser({ "a.png": one, "b.png": two, "a-again.png": one }, server("job-2", 2));

    const submitted = await submitJob(
      fake.deps,
      { files: [file("a.png"), file("b.png"), file("a-again.png")], text: "" },
      fake.onStatus,
    );

    expect(submitted).toEqual({ ok: true, jobId: "job-2" });
    expect(fake.calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "/api/jobs"],
      ["PUT", "http://localhost:3000/api/dev/storage/upload/token-0"],
      ["PUT", "http://localhost:3000/api/dev/storage/upload/token-1"],
      ["POST", "/api/jobs/job-2/uploaded"],
    ]);
    if (!one.ok || !two.ok) throw new Error("unreachable");
    expect((fake.calls[0]!.body as { images: unknown[] }).images).toEqual([one.meta, two.meta]);
    expect(fake.calls[1]!.body).toBe(one.blob);
    expect(fake.calls[2]!.body).toBe(two.blob);
    expect(fake.statuses).toEqual([
      "Preparing the screenshots…",
      "Starting the job…",
      "Uploading screenshot 1 of 2…",
      "Uploading screenshot 2 of 2…",
      "Checking the upload…",
    ]);
  });

  it("refuses before sending anything when a screenshot cannot be prepared", async () => {
    const fake = browser(
      { "tall.png": { ok: false, message: TOO_TALL }, "a.png": screenshot(1) },
      server("job-3", 1),
    );

    expect(
      await submitJob(
        fake.deps,
        { files: [file("a.png"), file("tall.png")], text: "" },
        fake.onStatus,
      ),
    ).toEqual({ ok: false, message: TOO_TALL });
    expect(fake.calls).toEqual([]);
  });

  it("refuses with the server's words before sending anything, counting repeats once", async () => {
    const prepared = Object.fromEntries(
      Array.from({ length: 9 }, (_, n) => [`${n}.png`, screenshot(n)]),
    );
    const nine = Object.keys(prepared).map(file);
    const fake = browser(prepared, server("job-4", 9));

    expect(await submitJob(fake.deps, { files: nine, text: "" }, fake.onStatus)).toEqual({
      ok: false,
      message: "At most 8 screenshots per job. Remove some, or split the post into two jobs.",
    });
    const tall = browser(
      { "a.png": screenshot(1, { height: 30_000 }), "b.png": screenshot(2, { height: 30_000 }) },
      server("job-5", 2),
    );
    expect(
      await submitJob(
        tall.deps,
        { files: [file("a.png"), file("b.png")], text: "" },
        tall.onStatus,
      ),
    ).toEqual({
      ok: false,
      message: "Too many screenshots for one job. Remove some, or split the post into two jobs.",
    });
    const repeated = browser({ "a.png": screenshot(1) }, server("job-6", 1));
    expect(
      await submitJob(
        repeated.deps,
        { files: Array.from({ length: 9 }, () => file("a.png")), text: "" },
        repeated.onStatus,
      ),
    ).toEqual({ ok: true, jobId: "job-6" });
    expect(fake.calls).toEqual([]);
    expect(tall.calls).toEqual([]);
  });

  it("shows the server's message for a job it refused, and a general one otherwise", async () => {
    const refused = browser({}, () => json({ error: "The server's own words." }, 422));
    expect(await submitJob(refused.deps, { files: [], text: "a post" }, refused.onStatus)).toEqual({
      ok: false,
      message: "The server's own words.",
    });

    for (const answer of [
      json({ error: "forbidden" }, 403),
      new Response("not json", { status: 500 }),
      json({ error: 42 }, 422),
    ]) {
      const failed = browser({}, () => answer);
      expect(await submitJob(failed.deps, { files: [], text: "a post" }, failed.onStatus)).toEqual({
        ok: false,
        message: MESSAGES.notStarted,
      });
    }
  });

  it("refuses when the server hands back a different number of upload URLs", async () => {
    const fake = browser({ "a.png": screenshot(1) }, server("job-7", 2));

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.notStarted },
    );
    expect(fake.calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("tries an upload again only after a dropped connection or a server error, three times at most", async () => {
    const happy = server("job-8", 3);
    const answers: Record<string, (Response | Error)[]> = {
      "token-0": [new Error("dropped"), new Response(null, { status: 503 }), new Response(null)],
      "token-1": [new Response(null, { status: 404 })],
      "token-2": [new Error("dropped"), new Error("dropped"), new Error("dropped")],
    };
    const fake = browser(
      { "a.png": screenshot(1), "b.png": screenshot(2), "c.png": screenshot(3) },
      (call) => {
        if (call.method !== "PUT") return happy(call);
        const token = call.url.split("/").pop()!;
        return answers[token]!.shift()!;
      },
    );

    expect(
      await submitJob(
        fake.deps,
        { files: [file("a.png"), file("b.png"), file("c.png")], text: "" },
        fake.onStatus,
      ),
    ).toEqual({ ok: true, jobId: "job-8" });
    expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual([
      "jobs",
      "token-0",
      "token-0",
      "token-0",
      "token-1",
      "token-2",
      "token-2",
      "token-2",
      "uploaded",
    ]);
  });

  it("says the screenshots did not arrive when the server cannot confirm them", async () => {
    const happy = server("job-9", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded")
        ? json({ error: "missing", missing: ["image-0"] }, 409)
        : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.notArrived },
    );
  });
});
