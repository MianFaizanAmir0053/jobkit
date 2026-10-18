import { describe, expect, it } from "vitest";

import { TOO_TALL } from "@/core/intake/encode";

import type { Prepared } from "./prepare";
import {
  BACKOFF_MS,
  FORGET_AFTER_DEADLINE_MS,
  keepsUpload,
  MESSAGES,
  type PendingUpload,
  resumeUpload,
  type SubmitDeps,
  submitJob,
  UPLOAD_DEADLINE_MS,
  uploadTimeoutMs,
} from "./submit";

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

type Call = { url: string; method: string; body: unknown; signal: AbortSignal | null };

/** A fake browser: `prepared` by file name, and `answer` for each request in turn. */
function browser(
  prepared: Record<string, Prepared>,
  answer: (call: Call, calls: Call[]) => Response | Error,
  times: number[] = [0],
) {
  const calls: Call[] = [];
  const statuses: string[] = [];
  const waits: number[] = [];
  // Uploads kept to resume after a reload, as IndexedDB keeps them in the browser.
  const kept = new Map<string, PendingUpload>();
  // Locks held, as the browser's Web Locks hold them across tabs.
  const held = new Set<string>();
  const deps: SubmitDeps = {
    pending: {
      save: async (upload) => {
        kept.set(upload.jobId, upload);
      },
      latest: async () => [...kept.values()].at(-1) ?? null,
      get: async (jobId) => kept.get(jobId) ?? null,
      clear: async (jobId) => {
        kept.delete(jobId);
      },
      clearUpTo: async (deadlineAt) => {
        for (const [jobId, upload] of kept) if (upload.deadlineAt <= deadlineAt) kept.delete(jobId);
      },
    },
    exclusive: async (name, run) => {
      if (held.has(name)) return null;
      held.add(name);
      try {
        return await run();
      } finally {
        held.delete(name);
      }
    },
    wallNow: () => 1_000_000,
    prepare: async (file) => prepared[file.name]!,
    fetch: async (url, init) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      const call = { url, method: init.method ?? "GET", body, signal: init.signal ?? null };
      calls.push(call);
      const answered = answer(call, calls);
      if (answered instanceof Error) throw answered;
      return answered;
    },
    now: () => times.shift() ?? 0,
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return {
    deps,
    calls,
    statuses,
    waits,
    kept,
    held,
    onStatus: (status: string) => statuses.push(status),
  };
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
    // The tap, the upload deadline, then the request.
    const fake = browser({}, server("job-1", 0), [1_000, 1_200, 3_500]);

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
        signal: expect.any(AbortSignal),
        body: {
          images: [],
          pastedText: "We're hiring. Apply at jobs@example.com",
          inputKind: "page",
          sharedUrl: "",
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

  it("uploads a failed job's screenshots again through its own route, then uploads and confirms them as a new job's", async () => {
    const one = screenshot(1);
    const fake = browser({ "a.png": one }, (call) =>
      call.url === "/api/jobs/job-9/upload-again"
        ? json({
            jobId: "job-9",
            uploads: [
              { imageId: "image-0", url: "http://localhost:3000/api/dev/storage/upload/token-0" },
            ],
          })
        : server("job-9", 1)(call),
    );

    const submitted = await submitJob(
      fake.deps,
      { files: [file("a.png")], text: "", againOf: "job-9" },
      fake.onStatus,
    );

    expect(submitted).toEqual({ ok: true, jobId: "job-9" });
    expect(fake.calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "/api/jobs/job-9/upload-again"],
      ["PUT", "http://localhost:3000/api/dev/storage/upload/token-0"],
      ["POST", "/api/jobs/job-9/uploaded"],
    ]);
    if (!one.ok) throw new Error("unreachable");
    // Only the screenshots: the job keeps its text, link, start and arm.
    expect(fake.calls[0]!.body).toEqual({ images: [one.meta] });
    expect(fake.statuses).toContain("Starting the upload again…");
  });

  it("uploads a job's screenshots again only from the tab that holds its upload, asking nothing of the server otherwise", async () => {
    const fake = browser({ "a.png": screenshot(1) }, server("job-9", 1));
    fake.held.add("jobkit-upload-job-9");

    expect(
      await submitJob(
        fake.deps,
        { files: [file("a.png")], text: "", againOf: "job-9" },
        fake.onStatus,
      ),
    ).toEqual({ ok: false, message: MESSAGES.uploadingElsewhere });
    expect(fake.calls).toEqual([]);
  });

  it("says a job is no longer waiting for its screenshots when the server will not upload it again", async () => {
    const fake = browser({ "a.png": screenshot(1) }, () => json({ error: "not-failed" }, 409));

    expect(
      await submitJob(
        fake.deps,
        { files: [file("a.png")], text: "", againOf: "job-9" },
        fake.onStatus,
      ),
    ).toEqual({ ok: false, message: MESSAGES.notFailed });
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

  it("shows the server's message for a job it refused, and what to do for any other refusal", async () => {
    const refused = browser({}, () => json({ error: "The server's own words." }, 422));
    expect(await submitJob(refused.deps, { files: [], text: "a post" }, refused.onStatus)).toEqual({
      ok: false,
      message: "The server's own words.",
    });

    const cases: [Response, string][] = [
      [json({ error: "unauthorised" }, 401), MESSAGES.signIn],
      [json({ error: "forbidden" }, 403), MESSAGES.notAllowed],
      [json({ error: "invalid" }, 400), MESSAGES.badRequest],
      // A server error may come after the job was created.
      [new Response("not json", { status: 500 }), MESSAGES.createLost],
      [json({ error: 42 }, 422), MESSAGES.notStarted],
    ];
    for (const [answer, message] of cases) {
      const failed = browser({}, () => answer);
      expect(await submitJob(failed.deps, { files: [], text: "a post" }, failed.onStatus)).toEqual({
        ok: false,
        message,
      });
    }
  });

  it("says the job may have started when the connection drops while it starts", async () => {
    const fake = browser({}, () => new Error("dropped"));

    expect(await submitJob(fake.deps, { files: [], text: "a post" }, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.createLost,
    });
    // Never sent twice: the first may have reached the server.
    expect(fake.calls).toHaveLength(1);
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
    // Each later attempt waits longer, and every attempt gives up after its timeout.
    expect(fake.waits).toEqual([...BACKOFF_MS, ...BACKOFF_MS]);
    for (const call of fake.calls.filter((call) => call.method === "PUT")) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    // Half a minute plus the file at 16 KB a second: about five minutes for 4 MB.
    expect(uploadTimeoutMs(4 * 1024 * 1024)).toBe(30_000 + 262_144);
  });

  it("says the screenshots did not arrive when they are still missing after two rounds of fresh URLs", async () => {
    const happy = server("job-9", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) => {
      if (call.url.endsWith("/uploaded"))
        return json({ error: "missing", missing: ["image-0"] }, 409);
      if (call.url.endsWith("/upload-urls")) {
        return json({ uploads: [{ imageId: "image-0", url: "http://localhost:3000/x/fresh" }] });
      }
      return happy(call);
    });

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.notArrived },
    );
    expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual([
      "jobs",
      "token-0",
      "uploaded",
      "upload-urls",
      "fresh",
      "uploaded",
      "upload-urls",
      "fresh",
      "uploaded",
    ]);
    // Forgotten, since the page says to press Start again: no later visit finishes it.
    expect(fake.kept.size).toBe(0);
  });

  it("asks for fresh URLs for the screenshots that did not arrive, uploads only those, then confirms", async () => {
    const happy = server("job-20", 2);
    let confirms = 0;
    const two = screenshot(2);
    const fake = browser({ "a.png": screenshot(1), "b.png": two }, (call) => {
      if (call.url.endsWith("/uploaded")) {
        confirms += 1;
        return confirms === 1
          ? json({ error: "missing", missing: ["image-1"] }, 409)
          : json({ queued: true }, 202);
      }
      if (call.url.endsWith("/upload-urls")) {
        return json({ uploads: [{ imageId: "image-1", url: "http://localhost:3000/x/again-1" }] });
      }
      return happy(call);
    });

    expect(
      await submitJob(
        fake.deps,
        { files: [file("a.png"), file("b.png")], text: "" },
        fake.onStatus,
      ),
    ).toEqual({ ok: true, jobId: "job-20" });
    expect(fake.calls.map((call) => [call.method, call.url.split("/").pop()])).toEqual([
      ["POST", "jobs"],
      ["PUT", "token-0"],
      ["PUT", "token-1"],
      ["POST", "uploaded"],
      ["POST", "upload-urls"],
      ["PUT", "again-1"],
      ["POST", "uploaded"],
    ]);
    if (!two.ok) throw new Error("unreachable");
    expect(fake.calls[5]!.body).toBe(two.blob);
    expect(fake.kept.size).toBe(0);
  });

  it("keeps a started upload to resume after a reload, until the server has it", async () => {
    const happy = server("job-21", 1);
    const one = screenshot(1);
    let kept: PendingUpload | undefined;
    const fake = browser({ "a.png": one }, (call, calls) => {
      if (call.method === "PUT") kept = [...(fake.kept.values() as Iterable<PendingUpload>)][0];
      void calls;
      return happy(call);
    });

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      {
        ok: true,
        jobId: "job-21",
      },
    );
    if (!one.ok) throw new Error("unreachable");
    expect(kept).toEqual({
      jobId: "job-21",
      deadlineAt: 1_000_000 + UPLOAD_DEADLINE_MS,
      images: [{ imageId: "image-0", blob: one.blob }],
    });
    expect(fake.kept.size).toBe(0);
  });

  it("counts the time a share waited before the page took it into the job's clock", async () => {
    // The page's start, the upload deadline, then the request.
    const fake = browser({}, server("job-23", 0), [1_000, 1_000, 1_500]);

    await submitJob(
      fake.deps,
      { files: [], text: "A post", inputKind: "share", startedAgo: 4_000 },
      fake.onStatus,
    );

    expect(fake.calls[0]!.body).toMatchObject({ clientElapsedMs: 4_500 });
  });

  it("leaves an upload kept from before for New job to finish when the owner starts another job", async () => {
    const fake = browser({}, server("job-24", 0));
    await fake.deps.pending.save({
      jobId: "job-old",
      deadlineAt: 1_000_000 + 60_000,
      images: [{ imageId: "image-0", blob: new Blob(["old"]) }],
    });

    await submitJob(fake.deps, { files: [], text: "A post" }, fake.onStatus);

    // The page said "jobkit tries again when you open New job", so it does.
    expect([...fake.kept.keys()]).toEqual(["job-old"]);
  });

  it("forgets an upload whose start went wrong after the job was created, since the page says to press Start again", async () => {
    const happy = server("job-25", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.method === "PUT" ? new Response(null, { status: 503 }) : happy(call),
    );
    fake.deps.wait = async () => {
      throw new Error("a timer that fails");
    };

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.wentWrong },
    );
    expect(fake.kept.size).toBe(0);
  });

  it("sends how the job came in and a shared link with its metadata", async () => {
    const fake = browser({}, server("job-22", 0));

    await submitJob(
      fake.deps,
      { files: [], text: "A post", inputKind: "share", sharedUrl: "https://lnkd.in/x" },
      fake.onStatus,
    );

    expect(fake.calls[0]!.body).toMatchObject({
      inputKind: "share",
      sharedUrl: "https://lnkd.in/x",
    });
  });

  it("asks for the confirmation again while the connection or the server fails, three times at most", async () => {
    const happy = server("job-10", 1);
    const confirms: (Response | Error)[] = [
      new Error("dropped"),
      new Response(null, { status: 502 }),
      json({ queued: true }, 202),
    ];
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? confirms.shift()! : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: true, jobId: "job-10" },
    );
    expect(fake.calls.filter((call) => call.url.endsWith("/uploaded"))).toHaveLength(3);
    expect(fake.waits).toEqual([...BACKOFF_MS]);

    // The last answer lost may have queued the job, so the page does not just say "Start again".
    const down = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? new Error("dropped") : happy(call),
    );
    expect(await submitJob(down.deps, { files: [file("a.png")], text: "" }, down.onStatus)).toEqual(
      { ok: false, message: MESSAGES.confirmLost },
    );
    for (const call of down.calls.filter((call) => call.url.endsWith("/uploaded"))) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(down.calls.filter((call) => call.url.endsWith("/uploaded"))).toHaveLength(3);
  });

  it("opens the job when it is no longer uploading, as after a confirmation whose answer was lost", async () => {
    const happy = server("job-11", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? json({ error: "not-uploading" }, 409) : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: true, jobId: "job-11" },
    );
  });

  it("tells a signed-out owner to sign in, and says when the job is gone", async () => {
    const happy = server("job-12", 1);
    const answers: [Response, string, number][] = [
      // The job exists, and New job finishes it once the owner is signed in again.
      [json({ error: "unauthorised" }, 401), MESSAGES.signInToFinish, 1],
      [json({ error: "forbidden" }, 403), MESSAGES.notAllowedToFinish, 1],
      [json({ error: "not-found" }, 404), MESSAGES.notFound, 0],
    ];
    for (const [answer, message, kept] of answers) {
      const fake = browser({ "a.png": screenshot(1) }, (call) =>
        call.url.endsWith("/uploaded") ? answer : happy(call),
      );
      expect(
        await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus),
      ).toEqual({ ok: false, message });
      expect(fake.kept.size).toBe(kept);
    }
  });
  it("says the job may have started when the answer to creating it cannot be read", async () => {
    const fake = browser({}, () => new Response("{not json", { status: 201 }));

    expect(await submitJob(fake.deps, { files: [], text: "a post" }, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.createLost,
    });
  });

  it("says the upload ran out of time when the server stopped it, never opening the job", async () => {
    const happy = server("job-13", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? json({ error: "upload-failed" }, 409) : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.uploadTimedOut },
    );
  });

  it("starts no upload once the server's 15 minutes are nearly up", async () => {
    const happy = server("job-14", 2);
    const fake = browser(
      { "a.png": screenshot(1), "b.png": screenshot(2) },
      // The confirmation asked for at the deadline finds the second screenshot missing.
      (call) =>
        call.url.endsWith("/uploaded")
          ? json({ error: "missing", missing: ["image-1"] }, 409)
          : happy(call),
      // The tap, the request, the uploads' start, the first upload, then past the deadline.
      [0, 0, 0, 1_000, UPLOAD_DEADLINE_MS + 1],
    );

    expect(
      await submitJob(
        fake.deps,
        { files: [file("a.png"), file("b.png")], text: "" },
        fake.onStatus,
      ),
    ).toEqual({ ok: false, message: MESSAGES.tooSlow });
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("stops when storage refuses a screenshot as too large, and says so", async () => {
    const happy = server("job-15", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.method === "PUT" ? new Response(null, { status: 413 }) : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.refusedUpload },
    );
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("says the text is too much when the server refuses a body over 64 KB", async () => {
    const fake = browser({}, () => json({ error: "too-large" }, 413));

    expect(await submitJob(fake.deps, { files: [], text: "a post" }, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.tooLarge,
    });
  });
  it("keeps saying the job may have started once an answer could have been lost", async () => {
    const happy = server("job-16", 1);
    const cases: [(Response | Error)[], string][] = [
      [
        [
          new Error("dropped"),
          new Response(null, { status: 502 }),
          new Response(null, { status: 503 }),
        ],
        MESSAGES.confirmLost,
      ],
      // Kept, so New job asks the server how the job stands once the owner signs in again.
      [[new Error("dropped"), json({ error: "unauthorised" }, 401)], MESSAGES.signInToFinish],
      [
        [new Response(null, { status: 500 }), json({ error: "not-found" }, 404)],
        `${MESSAGES.notFound} ${MESSAGES.checkJobs}`,
      ],
    ];
    for (const [confirms, message] of cases) {
      const fake = browser({ "a.png": screenshot(1) }, (call) =>
        call.url.endsWith("/uploaded") ? confirms.shift()! : happy(call),
      );
      expect(
        await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus),
      ).toEqual({ ok: false, message });
    }
  });

  it("asks for no fresh URLs once the page's deadline has passed, saying the upload is too slow", async () => {
    const happy = server("job-26", 1);
    const fake = browser(
      { "a.png": screenshot(1) },
      (call) =>
        call.url.endsWith("/uploaded")
          ? json({ error: "missing", missing: ["image-0"] }, 409)
          : happy(call),
      // The tap, the request, the upload's start and its deadline check, then past the deadline.
      [0, 0, 0, 0, UPLOAD_DEADLINE_MS + 1],
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.tooSlow },
    );
    // Fresh URLs would log an upload attempt that never runs.
    expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual([
      "jobs",
      "token-0",
      "uploaded",
    ]);
    expect(fake.kept.size).toBe(0);
  });

  it("asks for the confirmation again after a rate limit or a timeout, as after a server error", async () => {
    const happy = server("job-27", 1);
    const confirms: Response[] = [
      new Response(null, { status: 429 }),
      new Response(null, { status: 408 }),
      json({ queued: true }, 202),
    ];
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? confirms.shift()! : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: true, jobId: "job-27" },
    );
    expect(fake.waits).toEqual([...BACKOFF_MS]);
  });

  it("keeps the upload when an answer to the confirmation says nothing of what arrived", async () => {
    const happy = server("job-28", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? new Response(null, { status: 400 }) : happy(call),
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.confirmLost },
    );
    expect(fake.kept.size).toBe(1);
  });

  it("asks for the confirmation once the deadline passes during an upload, opening a job whose files all arrived", async () => {
    const happy = server("job-29", 1);
    const fake = browser(
      { "a.png": screenshot(1) },
      // The upload's bytes arrive, but its answer is lost; the second attempt would be too late.
      (call) => (call.method === "PUT" ? new Error("answer lost") : happy(call)),
      // The tap, the request, then each attempt's deadline check: the first in time, the second not.
      [0, 0, 0, 0, UPLOAD_DEADLINE_MS + 1],
    );

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: true, jobId: "job-29" },
    );
    expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual([
      "jobs",
      "token-0",
      "uploaded",
    ]);
  });

  it("stops uploading once the wall clock passes the deadline, though the page's own clock stood still, as on a phone asleep", async () => {
    const happy = server("job-31", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded")
        ? json({ error: "missing", missing: ["image-0"] }, 409)
        : happy(call),
    );
    const walls = [1_000_000, 1_000_000 + UPLOAD_DEADLINE_MS + 1];
    fake.deps.wallNow = () => walls.shift() ?? 1_000_000 + UPLOAD_DEADLINE_MS + 1;

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.tooSlow },
    );
    expect(fake.calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it("says the upload cannot be checked later when the browser could not keep it", async () => {
    const happy = server("job-32", 1);
    const fake = browser({ "a.png": screenshot(1) }, (call) =>
      call.url.endsWith("/uploaded") ? new Error("dropped") : happy(call),
    );
    fake.deps.pending.save = async () => {
      throw new Error("quota exceeded");
    };

    expect(await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus)).toEqual(
      { ok: false, message: MESSAGES.unkept },
    );
  });

  it("tells the form which outcomes keep an upload for New job to finish, and only those", () => {
    for (const message of [
      MESSAGES.confirmLost,
      MESSAGES.notResumed,
      MESSAGES.signInToFinish,
      MESSAGES.notAllowedToFinish,
    ]) {
      expect(keepsUpload({ ok: false, message })).toBe(true);
    }
    for (const message of [
      MESSAGES.createLost,
      MESSAGES.notArrived,
      MESSAGES.unkept,
      `${MESSAGES.notFound} ${MESSAGES.checkJobs}`,
    ]) {
      expect(keepsUpload({ ok: false, message })).toBe(false);
    }
    expect(keepsUpload({ ok: true, jobId: "job-1" })).toBe(false);
  });

  it("says the job may have started when the answer to creating it has no upload list", async () => {
    const fake = browser({}, () => json({ jobId: "job-17" }, 201));

    expect(await submitJob(fake.deps, { files: [], text: "a post" }, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.createLost,
    });
  });
});

describe("resumeUpload", () => {
  const pending = (blob: Blob): PendingUpload => ({
    jobId: "job-30",
    deadlineAt: 1_000_000 + 60_000,
    images: [
      { imageId: "image-0", blob: new Blob(["first"]) },
      { imageId: "image-1", blob },
    ],
  });

  it("finishes an upload a reload cut short: fresh URLs for what is missing, then the confirmation", async () => {
    const second = new Blob(["second"]);
    const fake = browser({}, (call) => {
      if (call.url.endsWith("/upload-urls")) {
        return json({ uploads: [{ imageId: "image-1", url: "http://localhost:3000/x/fresh-1" }] });
      }
      if (call.method === "PUT") return new Response(null, { status: 200 });
      return json({ queued: true }, 202);
    });
    await fake.deps.pending.save(pending(second));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({ ok: true, jobId: "job-30" });
    expect(fake.calls.map((call) => [call.method, call.url.split("/").pop()])).toEqual([
      ["POST", "upload-urls"],
      ["PUT", "fresh-1"],
      ["POST", "uploaded"],
    ]);
    expect(fake.calls[1]!.body).toBe(second);
    expect(fake.kept.size).toBe(0);
    expect(fake.statuses[0]).toBe("Finishing the upload of a job started before…");
  });

  it("does nothing when no upload waits", async () => {
    const fake = browser({}, () => new Error("no request"));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("opens a job the server took already, and forgets one that ran out of time or is gone", async () => {
    const answers: [Response, unknown][] = [
      [json({ error: "not-uploading" }, 409), { ok: true, jobId: "job-30" }],
      [json({ error: "upload-failed" }, 409), { ok: false, message: MESSAGES.uploadTimedOut }],
      [json({ error: "not-found" }, 404), { ok: false, message: MESSAGES.notFound }],
    ];
    for (const [answer, outcome] of answers) {
      const fake = browser({}, () => answer);
      await fake.deps.pending.save(pending(new Blob(["b"])));

      expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual(outcome);
      expect(fake.kept.size).toBe(0);
    }
  });

  it("keeps the upload when the connection drops, to try again on the next visit", async () => {
    const fake = browser({}, () => new Error("dropped"));
    await fake.deps.pending.save(pending(new Blob(["b"])));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.notResumed,
    });
    expect(fake.kept.size).toBe(1);
  });

  it("asks for the confirmation of a job past the page's deadline, never for fresh URLs, and uploads nothing more", async () => {
    const answers: [Response, unknown][] = [
      // Every file arrived before the deadline: the confirmation queues the job.
      [json({ queued: true }, 202), { ok: true, jobId: "job-30" }],
      // A confirmation reached the server before, though its answer was lost: the job runs.
      [json({ error: "not-uploading" }, 409), { ok: true, jobId: "job-30" }],
      [json({ error: "upload-failed" }, 409), { ok: false, message: MESSAGES.uploadTimedOut }],
      [
        json({ error: "missing", missing: ["image-1"] }, 409),
        { ok: false, message: MESSAGES.tooSlow },
      ],
    ];
    for (const [answer, outcome] of answers) {
      const fake = browser({}, () => answer);
      await fake.deps.pending.save({ ...pending(new Blob(["b"])), deadlineAt: 1_000_000 - 1 });

      expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual(outcome);
      // Fresh URLs would log an upload attempt that never runs.
      expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual(["uploaded"]);
      expect(fake.kept.size).toBe(0);
    }
  });

  it("forgets every kept upload without asking once even the newest is a minute past the server's 15 minutes", async () => {
    const fake = browser({}, () => new Error("no request"));
    const long = 1_000_000 - FORGET_AFTER_DEADLINE_MS - 1;
    await fake.deps.pending.save({
      ...pending(new Blob(["a"])),
      jobId: "job-40",
      deadlineAt: long - 5,
    });
    await fake.deps.pending.save({
      ...pending(new Blob(["b"])),
      jobId: "job-41",
      deadlineAt: long,
    });

    expect(await resumeUpload(fake.deps, fake.onStatus)).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(fake.kept.size).toBe(0);
    expect(fake.statuses).toEqual([]);
  });

  it("keeps an upload whose finish went wrong, to try again on the next visit", async () => {
    const fake = browser({}, () => new Response(null, { status: 503 }));
    fake.deps.wait = async () => {
      throw new Error("a timer that fails");
    };
    await fake.deps.pending.save(pending(new Blob(["b"])));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.notResumed,
    });
    expect(fake.kept.size).toBe(1);
  });

  it("finishes nothing that another tab forgot after this one read it", async () => {
    const fake = browser({}, () => new Error("no request"));
    await fake.deps.pending.save(pending(new Blob(["b"])));
    // Another tab forgets the upload between this tab's read and its lock.
    fake.deps.pending.latest = async () => {
      const upload = fake.kept.get("job-30") ?? null;
      fake.kept.delete("job-30");
      return upload;
    };

    expect(await resumeUpload(fake.deps, fake.onStatus)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("forgets only uploads as old as the one it found long past, never one kept since", async () => {
    const fake = browser({}, () => new Error("no request"));
    const long = 1_000_000 - FORGET_AFTER_DEADLINE_MS - 1;
    const old = { ...pending(new Blob(["a"])), jobId: "job-42", deadlineAt: long };
    await fake.deps.pending.save(old);
    // Another tab starts a job and keeps its upload between this tab's read and its clearing.
    fake.deps.pending.latest = async () => {
      await fake.deps.pending.save({ ...pending(new Blob(["b"])), jobId: "job-43" });
      return old;
    };

    expect(await resumeUpload(fake.deps, fake.onStatus)).toBeNull();
    expect([...fake.kept.keys()]).toEqual(["job-43"]);
  });

  it("keeps the upload of a device no longer approved, and says it finishes once approved again", async () => {
    const fake = browser({}, () => json({ error: "forbidden" }, 403));
    await fake.deps.pending.save(pending(new Blob(["b"])));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.notAllowedToFinish,
    });
    expect(fake.kept.size).toBe(1);
  });

  it("keeps the upload of a signed-out owner, and says it finishes once they sign in again", async () => {
    const fake = browser({}, () => json({ error: "unauthorised" }, 401));
    await fake.deps.pending.save(pending(new Blob(["b"])));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.signInToFinish,
    });
    expect(fake.kept.size).toBe(1);
  });

  it("leaves an upload another tab is finishing to that tab", async () => {
    const fake = browser({}, () => new Error("no request"));
    await fake.deps.pending.save(pending(new Blob(["b"])));
    fake.held.add("jobkit-upload-job-30");

    expect(await resumeUpload(fake.deps, fake.onStatus)).toBe("elsewhere");
    expect(fake.calls).toEqual([]);
    expect(fake.kept.size).toBe(1);
  });

  it("asks for the confirmation when the deadline passes while it waits to ask for fresh URLs again", async () => {
    const answers: Response[] = [new Response(null, { status: 503 }), json({ queued: true }, 202)];
    const fake = browser({}, () => answers.shift()!, [0, 0, 600]);
    await fake.deps.pending.save({ ...pending(new Blob(["b"])), deadlineAt: 1_000_000 + 500 });

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({ ok: true, jobId: "job-30" });
    expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual([
      "upload-urls",
      "uploaded",
    ]);
  });

  it("asks for fresh URLs again while the connection or the server fails, three times at most", async () => {
    const answers: (Response | Error)[] = [
      new Error("dropped"),
      new Response(null, { status: 503 }),
      json({ uploads: [] }),
    ];
    const fake = browser({}, (call) =>
      call.url.endsWith("/upload-urls") ? answers.shift()! : json({ queued: true }, 202),
    );
    await fake.deps.pending.save(pending(new Blob(["b"])));

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({ ok: true, jobId: "job-30" });
    expect(fake.calls.map((call) => call.url.split("/").pop())).toEqual([
      "upload-urls",
      "upload-urls",
      "upload-urls",
      "uploaded",
    ]);
    expect(fake.waits).toEqual([...BACKOFF_MS]);
  });
});
