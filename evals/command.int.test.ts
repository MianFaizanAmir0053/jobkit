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

import { fakeClock } from "@/adapters/clock";
import { answer, fakeLlm, type FakeLlm } from "@/adapters/fakeLlm";
import { createLocalStorage } from "@/adapters/localStorage";
import type { PgliteDb } from "@/adapters/pglite";
import { cryptoRandom } from "@/adapters/random";
import { seedProfile } from "@/core/profile/seed";
import { validateProfile } from "@/core/profile/validate";
import { createTestDb } from "@/server/db/testDb";

import type { Labels } from "./cases";
import { evalCommand, type EvalIo, parseEvalArgs, type RunReport } from "./command";

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
};

let dir: string;
let db: PgliteDb;
let llm: FakeLlm;
let opened: number;
let lines: string[];

function io(overrides: Partial<EvalIo> = {}): EvalIo {
  return {
    env: {},
    localEnv: { ANTHROPIC_EVALS_API_KEY: "fixture-evals-key" },
    archive: join(dir, "archive"),
    profileFile: join(SYNTHETIC, "profile.sample.yaml"),
    evalsDir: join(dir, "evals"),
    commit: "0123456789abcdef0123",
    now: () => new Date("2026-10-13T12:00:00Z"),
    log: (line) => lines.push(line),
    open: async () => {
      opened++;
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

/** A labelled mail case with one screenshot, in the split given. */
async function labelledCase(id: string, split: "dev" | "test"): Promise<void> {
  const folder = join(dir, "archive", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "email.eml"),
    "Subject: Application\r\nDate: Mon, 16 Mar 2026 10:00:00 +0500\r\n\r\nHello",
  );
  const png = await sharp({
    create: { width: 1080, height: 2400, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .png()
    .toBuffer();
  writeFileSync(join(folder, "post-1.png"), png);
  writeFileSync(join(folder, "labels.json"), JSON.stringify(LABELS));
  const splitFile = join(dir, "archive", "split.json");
  const splits = existsSync(splitFile)
    ? (JSON.parse(readFileSync(splitFile, "utf8")) as object)
    : {};
  writeFileSync(splitFile, JSON.stringify({ ...splits, [id]: split }));
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
  lines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("evalCommand", () => {
  it("refuses to start without the evaluation key, before reading any case", async () => {
    await labelledCase(CASE, "dev");

    await expect(
      evalCommand(["--stage", "extract", "--yes"], io({ localEnv: {} })),
    ).rejects.toThrow(/ANTHROPIC_EVALS_API_KEY/);
    expect([opened, lines.length]).toEqual([0, 0]);
  });

  it("refuses to start beside an app key or a remote database, in the process or in .env.local", async () => {
    await labelledCase(CASE, "dev");
    const key = { ANTHROPIC_EVALS_API_KEY: "fixture-evals-key" };

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
    expect(lines[1]).toMatch(/^At most \$\d+\.\d\d for extract with claude-opus-5-5/);
    expect(lines.at(-1)).toBe("Nothing was spent. Run again with --yes to spend.");
    expect(existsSync(join(dir, "evals"))).toBe(false);
  });

  it("with --yes, runs the dev cases, prints each, and writes the report with its versions", async () => {
    await labelledCase(CASE, "dev");
    llm = fakeLlm([answer(record())]);

    await evalCommand(["--stage", "extract", "--yes"], io());

    const runs = join(dir, "evals", "runs");
    const [folder] = readdirSync(runs);
    expect(folder).toBe("2026-10-13T12-00-00.000Z-extract-claude-opus-5-5");
    const saved = JSON.parse(readFileSync(join(runs, folder!, "report.json"), "utf8")) as RunReport;
    expect(saved).toMatchObject({
      stage: "extract",
      split: "dev",
      final: false,
      commit: "0123456789abcdef0123",
      model: "claude-opus-5-5",
      prompt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(saved.cases.map((result) => result.id)).toEqual([CASE]);
    expect(readFileSync(join(runs, folder!, "report.md"), "utf8")).toContain(
      `| ${CASE} | scored |`,
    );
    expect(lines.some((line) => line.includes(CASE))).toBe(true);
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
        model: "claude-opus-5-5",
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
});
