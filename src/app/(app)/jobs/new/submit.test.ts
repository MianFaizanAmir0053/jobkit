import { describe, expect, it } from "vitest";

import { TOO_TALL } from "@/core/intake/encode";

import type { Prepared } from "./prepare";
import {
  BACKOFF_MS,
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
  const deps: SubmitDeps = {
    pending: {
      save: async (upload) => {
        kept.set(upload.jobId, upload);
      },
      latest: async () => [...kept.values()].at(-1) ?? null,
      clear: async (jobId) => {
        kept.delete(jobId);
      },
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
    // Kept, so opening New job again tries once more while the server still waits for it.
    expect([...fake.kept.keys()]).toEqual(["job-9"]);
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
    const answers: [Response, string][] = [
      [json({ error: "unauthorised" }, 401), MESSAGES.signIn],
      [json({ error: "forbidden" }, 403), MESSAGES.notAllowed],
      [json({ error: "not-found" }, 404), MESSAGES.notFound],
    ];
    for (const [answer, message] of answers) {
      const fake = browser({ "a.png": screenshot(1) }, (call) =>
        call.url.endsWith("/uploaded") ? answer : happy(call),
      );
      expect(
        await submitJob(fake.deps, { files: [file("a.png")], text: "" }, fake.onStatus),
      ).toEqual({ ok: false, message });
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
    const fake = browser(
      { "a.png": screenshot(1), "b.png": screenshot(2) },
      server("job-14", 2),
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
      [
        [new Error("dropped"), json({ error: "unauthorised" }, 401)],
        `${MESSAGES.signIn} ${MESSAGES.checkJobs}`,
      ],
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

  it("forgets an upload past the server's 15 minutes without asking", async () => {
    const fake = browser({}, () => new Error("no request"));
    await fake.deps.pending.save({ ...pending(new Blob(["b"])), deadlineAt: 1_000_000 - 1 });

    expect(await resumeUpload(fake.deps, fake.onStatus)).toEqual({
      ok: false,
      message: MESSAGES.uploadTimedOut,
    });
    expect(fake.calls).toEqual([]);
    expect(fake.kept.size).toBe(0);
  });
});
