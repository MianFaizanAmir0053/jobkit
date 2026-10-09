/**
 * Live contract test against the Gemini API, on the evaluation key, so it
 * spends from the evaluation project: about a cent a run. Runs only by hand,
 * with the owner's approval, through `npx vitest run --mode live
 * src/adapters/gemini.live.test.ts`, with .env.local filled in.
 */
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { LlmRequest } from "@/core/ports";

import { loadLocalEnv } from "../../scripts/ops";
import { createGeminiLlm } from "./gemini";

const key = loadLocalEnv().GEMINI_EVALS_API_KEY;
if (!key) throw new Error("GEMINI_EVALS_API_KEY is missing from .env.local");
const llm = createGeminiLlm({ apiKey: key });

const capital = z.object({
  city: z.string(),
  country: z.string().nullable(),
  continent: z.enum(["Africa", "Asia", "Europe", "North America", "Oceania", "South America"]),
});

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "gemini-3.8-flash",
    system: "Answer briefly, in the requested format.",
    content: [{ type: "text", text: "Which city is the capital of France?" }],
    schema: capital,
    effort: "low",
    maxTokens: 2000,
    signal: AbortSignal.timeout(120_000),
    onEvent: () => undefined,
    ...overrides,
  };
}

/** A PNG of one colour, built by hand so the test needs no image library. */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): string {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from(rgb))]);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

describe("Gemini through the adapter", () => {
  it("answers in the schema's shape, with usage and the response ID", async () => {
    const counted = await llm.countInputTokens(request());
    const reply = await llm.call(request());

    expect(reply.kind).toBe("answer");
    if (reply.kind !== "answer") return;
    expect(capital.parse(JSON.parse(reply.text))).toMatchObject({ city: "Paris" });
    expect(reply.model).toMatch(/^gemini-3\.8-flash/);
    expect(reply.requestId).toBeTruthy();
    const [usage] = reply.usage;
    expect(usage).toMatchObject({ model: "gemini-3.8-flash" });
    expect(usage!.outputTokens).toBeGreaterThan(0);
    expect(counted).toBeGreaterThan(0);
  }, 150_000);

  it("reads an inline image at a high thinking level, and keeps sending while it thinks", async () => {
    const colour = z.object({ colour: z.enum(["red", "green", "blue", "other"]) });
    const arrivals = [Date.now()];

    const reply = await llm.call(
      request({
        content: [
          { type: "text", text: "Which colour fills this image?" },
          { type: "image", mediaType: "image/png", base64: solidPng(64, 64, [220, 20, 20]) },
        ],
        schema: colour,
        effort: "high",
        maxTokens: 4000,
        onEvent: () => arrivals.push(Date.now()),
      }),
    );

    const longest = Math.max(...arrivals.slice(1).map((at, i) => at - arrivals[i]!));
    console.info(`${arrivals.length - 1} arrivals, longest silence ${longest} ms`);
    expect(reply.kind).toBe("answer");
    if (reply.kind !== "answer") return;
    expect(colour.parse(JSON.parse(reply.text))).toEqual({ colour: "red" });
    // The wrapper abandons a stream silent for 45 seconds (platform spec B4).
    expect(longest).toBeLessThan(45_000);
  }, 150_000);
});
