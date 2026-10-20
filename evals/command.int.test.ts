import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { fakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm } from "@/adapters/fakeLlm";
import { createLocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { DRAFT } from "@/core/drafting/draftStage";
import { JUDGE } from "@/core/drafting/judgeStage";
import { S01_DRAFT, S01_JUDGED } from "@/core/drafting/testDrafts";
import { ADDRESS_READ } from "@/core/extraction/addressReadStage";
import { EXTRACT } from "@/core/extraction/extract";
import { createTestDb } from "@/server/db/testDb";

import type { Labels } from "./cases";
import {
  type DraftReport,
  evalCommand,
  type EvalIo,
  GAP_COVERAGE,
  parseEvalArgs,
  type RunReport,
  type SecondReadReport,
} from "./command";
import type { JudgeSetReport } from "./judgeSet";
import { keepClaims, labelClaim } from "./liveClaims";
import { manifestOf, sourceOf } from "./render";
import { appendSplitEvents } from "./splitFile";
import { syntheticPosts } from "./synthetic";

/* npm run eval: evals AC3's runner clauses and AC5. Fake models only, so nothing here spends. */

const SYNTHETIC = join(process.cwd(), "evals", "synthetic");
const CASE = "2026-03-16-8282e9a1";
const LABELS: Labels = {
  company: "Contoso Health",
  role: "Senior Full-Stack Engineer",
  route: "email",
  contact: "jobs@example.com",
  eligibility: "eligible",
  must: [],
  cropShowsContact: null,
  seenInJobkit: false,
};

let dir: string;
let db: PgliteDb;
let llm: FakeLlm;
let opened: number;
let seeded: string[];
let lines: string[];

function io(overrides: Partial<EvalIo> = {}): EvalIo {
  return {
    env: {},
    localEnv: { GEMINI_EVALS_API_KEY: "fixture-evals-key" },
    archive: join(dir, "archive"),
    profileFile: join(SYNTHETIC, "profile.sample.yaml"),
    syntheticDir: join(dir, "synthetic"),
    evalsDir: join(dir, "evals"),
    commit: "0123456789abcdef0123",
    now: () => new Date("2026-10-13T12:00:00Z"),
    log: (line) => lines.push(line),
    open: async (profileFile) => {
      opened++;
      seeded.push(profileFile);
      const storage = createLocalStorage({
        root: join(dir, "storage"),
        origin: "http://localhost:3000",
      });
      const checked = validateProfile(
        readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"),
        {
          read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
        },
      );
      if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
      await seedProfile({ db, storage, clock: fakeClock() }, checked);
      return {
        db,
        storage,
        clock: fakeClock(),
        random: cryptoRandom,
        llmFor: () => llm,
        close: async () => {},
      };
    },
    ...overrides,
  };
}

/** A labelled mail case with one screenshot, in the split given, as eval:split and the labelling page leave it. */
async function labelledCase(id: string, split: "dev" | "test"): Promise<void> {
  const archive = join(dir, "archive");
  const folder = join(archive, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(archive, "import.json"),
    JSON.stringify({ jobkitFrom: "2099-01-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(folder, "email.eml"),
    `Subject: Application ${id}\r\nDate: Mon, 16 Mar 2026 10:00:00 +0500\r\n\r\nHello`,
  );
  const png = await sharp({
    create: { width: 1080, height: 2400, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .png()
    .toBuffer();
  writeFileSync(join(folder, "post-1.png"), png);
  appendSplitEvents(archive, [{ at: "2026-10-01T00:00:00.000Z", id, split }]);
  writeFileSync(
    join(folder, "labels.json"),
    JSON.stringify({
      ...LABELS,
      labelledAt: "2026-10-02T00:00:00.000Z",
      split,
      prelabelsShown: false,
      cropSha256: null,
    }),
  );
}

/** One public post, rendered as a blank screenshot its manifest vouches for, in a synthetic folder of the test's own. */
async function renderedPost(id: string): Promise<void> {
  const synthetic = join(dir, "synthetic");
  const post = syntheticPosts(join(SYNTHETIC, "posts.yaml")).find((each) => each.id === id)!;
  const entries = parse(readFileSync(join(SYNTHETIC, "posts.yaml"), "utf8")) as { id: string }[];
  mkdirSync(join(synthetic, "screenshots"), { recursive: true });
  writeFileSync(
    join(synthetic, "posts.yaml"),
    stringify(entries.filter((entry) => entry.id === id)),
  );
  const png = new Uint8Array(
    await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .png()
      .toBuffer(),
  );
  writeFileSync(join(synthetic, "screenshots", `${id}.png`), png);
  writeFileSync(
    join(synthetic, "screenshots", "manifest.json"),
    JSON.stringify(
      manifestOf("155.0.8059.40", { [`${id}.png`]: { bytes: png, source: sourceOf(post) } }),
    ),
  );
}

const record = () =>
  JSON.parse(readFileSync(join(SYNTHETIC, "records", "S01-email-simple.json"), "utf8")) as unknown;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `delete from {{schema}}.model_calls; delete from {{schema}}.job_stage_runs;
     delete from {{schema}}.job_leases; delete from {{schema}}.job_images;
     delete from {{schema}}.job_state_changes; delete from {{schema}}.jobs;
     delete from {{schema}}.profile_versions`,
  );
  dir = mkdtempSync(join(tmpdir(), "jobkit-eval-"));
  llm = fakeLlm([]);
  opened = 0;
  seeded = [];
  lines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("evalCommand", () => {
  it("refuses to start without the evaluation key of the model it runs, before reading any case", async () => {
    await labelledCase(CASE, "dev");

    await expect(
      evalCommand(["--stage", "extract", "--yes"], io({ localEnv: {} })),
    ).rejects.toThrow(/GEMINI_EVALS_API_KEY/);
    await expect(
      evalCommand(
        ["--stage", "extract", "--model", "claude-opus-5-5", "--yes"],
        io({ localEnv: { GEMINI_EVALS_API_KEY: "fixture-evals-key" } }),
      ),
    ).rejects.toThrow(/ANTHROPIC_EVALS_API_KEY/);
    expect([opened, lines.length]).toEqual([0, 0]);
  });

  it("refuses to start beside an app key or a remote database, in the process or in .env.local", async () => {
    await labelledCase(CASE, "dev");
    const key = { GEMINI_EVALS_API_KEY: "fixture-evals-key" };

    await expect(
      evalCommand(
        ["--stage", "extract", "--yes"],
        io({ env: { ANTHROPIC_API_KEY: "fixture-app-key" } }),
      ),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(
      evalCommand(
        ["--stage", "extract", "--yes"],
        io({ localEnv: { ...key, DATABASE_URL: "postgres://db.example.com:5432/jobkit" } }),
      ),
    ).rejects.toThrow(/DATABASE_URL/);
    expect(opened).toBe(0);
  });

  it("without --yes, says how many cases and the most they can cost, and spends nothing", async () => {
    await labelledCase(CASE, "dev");

    expect(await evalCommand(["--stage", "extract"], io())).toBeNull();

    expect([opened, llm.calls.length]).toEqual([0, 0]);
    expect(lines[0]).toBe("1 labelled dev cases to run; 0 in dev have no labels yet.");
    expect(lines[1]).toMatch(
      new RegExp(`^At most \\$\\d+\\.\\d\\d for extract with ${EXTRACT.model}`),
    );
    expect(lines.at(-1)).toBe("Nothing was spent. Run again with --yes to spend.");
    expect(existsSync(join(dir, "evals"))).toBe(false);
  });

  it("with --yes, runs the dev cases, prints each, and writes the report with its versions", async () => {
    await labelledCase(CASE, "dev");
    llm = fakeLlm([answer(record())]);

    await evalCommand(["--stage", "extract", "--yes"], io());

    const runs = join(dir, "evals", "runs");
    const [folder] = readdirSync(runs);
    expect(folder).toBe(`2026-10-13T12-00-00.000Z-extract-${EXTRACT.model}`);
    const saved = JSON.parse(readFileSync(join(runs, folder!, "report.json"), "utf8")) as RunReport;
    expect(saved).toMatchObject({
      stage: "extract",
      split: "dev",
      final: false,
      commit: "0123456789abcdef0123",
      model: EXTRACT.model,
      prompt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(saved.cases.map((result) => result.id)).toEqual([CASE]);
    expect(readFileSync(join(runs, folder!, "report.md"), "utf8")).toContain(
      `| ${CASE} | scored |`,
    );
    expect(lines.some((line) => line.includes(CASE))).toBe(true);
  });

  it("drafts each dev case, past the eligibility decision, checks each draft, and scores gap coverage", async () => {
    await labelledCase(CASE, "dev");
    // S01 with AWS a must-have, which the sample profile lacks: the draft's gap line answers it.
    const read = record() as { roles: { requirements: { id: string; priority: string }[] }[] };
    read.roles[0]!.requirements.find((requirement) => requirement.id === "R4")!.priority = "must";
    llm = fakeLlm([answer(read), answer(S01_DRAFT), answer(S01_JUDGED)]);

    expect(await evalCommand(["--stage", "draft", "--yes"], io())).toBeNull();

    const runs = join(dir, "evals", "runs");
    const [folder] = readdirSync(runs);
    expect(folder).toBe(`2026-10-13T12-00-00.000Z-draft-${DRAFT.model}`);
    const saved = JSON.parse(
      readFileSync(join(runs, folder!, "report.json"), "utf8"),
    ) as DraftReport;
    expect(saved).toMatchObject({
      stage: "draft",
      gapCoverage: { successes: 1, n: 1 },
      verdicts: { not_a_claim: 2, supported: 3 },
      judgePrompt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(saved.cases).toMatchObject([
      { id: CASE, outcome: "scored", kit: "email", answered: 1, missing: 0 },
    ]);
    expect(lines).toContain(`${GAP_COVERAGE}: 1 of 1 (100%, 21% to 100%)`);
    expect(readFileSync(join(runs, folder!, "report.md"), "utf8")).toContain(
      `| ${CASE} | scored | email | 1 | 0 |`,
    );
  });

  it("reads each dev case's contact a second time from its crop, and scores the read against the label", async () => {
    await labelledCase(CASE, "dev");
    const read = record() as { roles: { route: { box: unknown } }[] };
    read.roles[0]!.route.box = { tile: 1, x1: 100, y1: 100, x2: 400, y2: 140 };
    // The post's reading is right, and the second read misreads a letter: a false alarm.
    llm = fakeLlm([answer(read), answer({ contact: "jobs@examp1e.com" })]);

    expect(await evalCommand(["--stage", "address_read", "--yes"], io())).toBeNull();

    const runs = join(dir, "evals", "runs");
    const saved = JSON.parse(
      readFileSync(join(runs, readdirSync(runs)[0]!, "report.json"), "utf8"),
    ) as SecondReadReport;
    expect(saved).toMatchObject({
      stage: "address_read",
      model: ADDRESS_READ.model,
      agreesWithLabel: { successes: 0, n: 1 },
      caught: { successes: 0, n: 0 },
      falseAlarms: { successes: 1, n: 1 },
    });
    expect(saved.cases).toMatchObject([
      { id: CASE, outcome: "scored", firstRight: true, secondRight: false, agreed: false },
    ]);
    expect(lines).toContain("False alarms on a right first read: 1 of 1 (100%, 21% to 100%)");
  });

  it("runs the judge on the labelled claims from live drafts, and scores the check as it ran live", async () => {
    const checked = validateProfile(readFileSync(join(SYNTHETIC, "profile.sample.yaml"), "utf8"), {
      read: (path) => new Uint8Array(readFileSync(join(SYNTHETIC, path))),
    });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    const fact = checked.profile.facts.find((each) => each.approved)!;
    const archive = join(dir, "archive");
    const live = "live-2026-10-20-0123abcd";
    mkdirSync(join(archive, live), { recursive: true });
    keepClaims(join(archive, live), "job", [
      {
        blockId: "S2",
        sentence: "I led a team of fifty engineers.",
        facts: [fact],
        liveVerdict: "overstated",
      },
    ]);
    labelClaim(archive, live, "S2", "not_supported", new Date("2026-10-13T11:00:00Z"));
    // The model under test lets the inflated claim through, where the check caught it live.
    llm = fakeLlm([
      answer({
        verdicts: [{ block_id: "S1", verdict: "supported", company_claim: false, note: "" }],
      }),
    ]);

    expect(await evalCommand(["--stage", "judge", "--yes"], io())).toBeNull();

    expect(lines).toContain(
      "As the check ran live, on the 1 it weighed: precision 1 of 1 (100%, 21% to 100%), recall 1 of 1 (100%, 21% to 100%).",
    );
    const runs = join(dir, "evals", "runs");
    const [folder] = readdirSync(runs);
    expect(folder).toBe(`2026-10-13T12-00-00.000Z-judge-${JUDGE.model}`);
    const saved = JSON.parse(
      readFileSync(join(runs, folder!, "report.json"), "utf8"),
    ) as JudgeSetReport;
    expect(saved).toMatchObject({
      stage: "judge",
      notSupported: { recall: { successes: 0, n: 1 } },
      live: { claims: 1, notSupported: { recall: { successes: 1, n: 1 } } },
    });
    expect(() => parseEvalArgs(["--stage", "judge", "--split", "dev"])).toThrow(/no split/);
  });

  it("scores test cases only with --final, which it records, printing none of them", async () => {
    expect(() => parseEvalArgs(["--stage", "extract", "--split", "test"])).toThrow(/--final/);
    await labelledCase(CASE, "test");
    llm = fakeLlm([answer(record())]);

    await evalCommand(["--stage", "extract", "--split", "test", "--final", "--yes"], io());

    const finals = JSON.parse(
      readFileSync(join(dir, "evals", "final-runs.json"), "utf8"),
    ) as unknown[];
    expect(finals).toEqual([
      expect.objectContaining({
        at: "2026-10-13T12:00:00.000Z",
        stage: "extract",
        model: EXTRACT.model,
      }),
    ]);
    expect(lines.some((line) => line.includes(CASE))).toBe(false);
    const runs = join(dir, "evals", "runs");
    expect(readFileSync(join(runs, readdirSync(runs)[0]!, "report.md"), "utf8")).not.toContain(
      CASE,
    );
  });

  it("says what this month's runs have spent", async () => {
    await labelledCase(CASE, "dev");
    for (const [name, startedAt, costUsd] of [
      ["a", "2026-10-02T09:00:00.000Z", 1.25],
      ["b", "2026-09-30T09:00:00.000Z", 3],
    ] as const) {
      mkdirSync(join(dir, "evals", "runs", name), { recursive: true });
      writeFileSync(
        join(dir, "evals", "runs", name, "report.json"),
        JSON.stringify({ startedAt, costUsd }),
      );
    }

    await evalCommand(["--stage", "extract"], io());

    expect(lines).toContain("Evaluation runs this month have spent $1.25.");
  });

  it("refuses the synthetic posts while their renders are not vouched for, before opening anything", async () => {
    await renderedPost("S09-ai-trap-and-keyword");
    writeFileSync(join(dir, "synthetic", "screenshots", "S09-ai-trap-and-keyword.png"), "changed");

    await expect(
      evalCommand(["--stage", "extract", "--split", "synthetic", "--yes"], io()),
    ).rejects.toThrow(/S09-ai-trap-and-keyword.png is not the image the last render made/);
    expect(opened).toBe(0);
    expect(() => parseEvalArgs(["--stage", "extract", "--split", "synthetic", "--final"])).toThrow(
      /--final is for the test split/,
    );
  });

  it("runs the synthetic posts on the sample profile, prints each with its checks, and records the renders", async () => {
    await renderedPost("S09-ai-trap-and-keyword");
    const read = JSON.parse(
      readFileSync(join(SYNTHETIC, "records", "S09-ai-trap-and-keyword.json"), "utf8"),
    ) as { roles: { instructions: { addressed_to_ai: boolean }[] }[] };
    read.roles[0]!.instructions[1]!.addressed_to_ai = false;
    llm = fakeLlm([answer(read)]);

    const report = await evalCommand(["--stage", "extract", "--split", "synthetic", "--yes"], io());

    expect(seeded).toEqual([join(dir, "synthetic", "profile.sample.yaml")]);
    expect(lines[0]).toBe("1 synthetic posts to run, rendered by Chrome 155.0.8059.40.");
    expect(report).toMatchObject({
      split: "synthetic",
      final: false,
      renders: {
        browser: "155.0.8059.40",
        images: { "S09-ai-trap-and-keyword.png": expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
      checks: { instructions: { successes: 0, n: 1 } },
    });
    expect(report!.cases[0]!.matches).toEqual({ company: true, route: true, contact: true });
    expect(lines).toContain("  S09-ai-trap-and-keyword  scored  checks not met: instructions");
    expect(
      lines.some((line) => line.includes("include_keyword addressed to AI was not read")),
    ).toBe(true);
    const runs = join(dir, "evals", "runs");
    const markdown = readFileSync(join(runs, readdirSync(runs)[0]!, "report.md"), "utf8");
    expect(markdown).toContain("Screenshots rendered by Chrome 155.0.8059.40");
    expect(markdown).toContain("| instructions | 0 | 1 |");
    expect(markdown).toContain("| S09-ai-trap-and-keyword | scored |");
  });
});
