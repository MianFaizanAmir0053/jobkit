import { ApiError } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { LlmRequest } from "@/core/ports";

import { createGeminiLlm, fromChunks, fromError, jsonSchemaOf, retryDelayOf, toParts } from "./gemini";
import { recordedBody } from "./recordedBody";
import { ConnectionLost, type Fetch } from "./reportingFetch";

/*
 * The adapter runs against the real SDK with a fake fetch that answers with
 * recorded server-sent events, one string per chunk of the response body. No
 * test here touches the network (platform spec A8).
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const MODEL = "gemini-3.8-flash";

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL,
    system: "Read the contact box.",
    content: [
      { type: "text", text: "The crop:" },
      { type: "image", mediaType: "image/png", base64: "iVBORw0KGgo=" },
    ],
    schema: z.object({ email: z.string().nullable() }),
    effort: "low",
    maxTokens: 1000,
    signal: new AbortController().signal,
    onEvent: () => undefined,
    ...overrides,
  };
}

/** One server-sent event as the Gemini API writes it. */
const event = (data: object) => `data: ${JSON.stringify(data)}\r\n\r\n`;

const counts = (overrides: Record<string, number> = {}) => ({
  promptTokenCount: 800,
  candidatesTokenCount: 6,
  thoughtsTokenCount: 120,
  totalTokenCount: 926,
  ...overrides,
});

function textChunk(
  text: string,
  opts: { finishReason?: string; thought?: boolean; usage?: object | null } = {},
): string {
  return event({
    candidates: [
      {
        content: { role: "model", parts: [{ text, ...(opts.thought ? { thought: true } : {}) }] },
        index: 0,
        ...(opts.finishReason ? { finishReason: opts.finishReason } : {}),
      },
    ],
    ...(opts.usage === null ? {} : { usageMetadata: opts.usage ?? counts() }),
    modelVersion: MODEL,
    responseId: "resp_1",
  });
}

interface Sent {
  url: URL;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = Response | { chunks: readonly string[]; open?: boolean; failWith?: Error };

/** The API as a fetch: `reply` gives a whole response, or the chunks of an event stream. */
function fakeApi(reply: (sent: Sent) => Reply) {
  const sent: Sent[] = [];
  const fetch: Fetch = async (input, init) => {
    const call: Sent = {
      url: new URL(input instanceof Request ? input.url : input.toString()),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    sent.push(call);
    const answer = reply(call);
    if (answer instanceof Response) return answer;
    const body = recordedBody(answer.chunks, {
      failWith: answer.failWith,
      openUntil: answer.open ? (init?.signal ?? undefined) : undefined,
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, sent };
}

function errorResponse(status: number, error: object): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createGeminiLlm", () => {
  it("streams the answer and sends the stage's settings", async () => {
    const api = fakeApi(() => ({
      chunks: [
        textChunk("Reading the crop.", { thought: true }),
        textChunk('{"email":'),
        textChunk('"jobs@example.com"}', { finishReason: "STOP" }),
      ],
    }));
    const onEvent = vi.fn();

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request({ onEvent }),
    );

    expect(reply).toEqual({
      kind: "answer",
      text: '{"email":"jobs@example.com"}',
      model: MODEL,
      requestId: "resp_1",
      usage: [{ model: MODEL, inputTokens: 800, outputTokens: 126, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      truncated: false,
    });
    expect(onEvent).toHaveBeenCalled();
    const [sent] = api.sent;
    expect(sent!.url.pathname).toMatch(/\/models\/gemini-3\.8-flash:streamGenerateContent$/);
    expect(sent!.url.searchParams.get("alt")).toBe("sse");
    expect(sent!.headers.get("x-goog-api-key")).toBe("test-key");
    expect(sent!.body).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [{ text: "The crop:" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }],
        },
      ],
      systemInstruction: { parts: [{ text: "Read the contact box." }] },
      generationConfig: {
        maxOutputTokens: 1000,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
        thinkingConfig: { thinkingLevel: "LOW", includeThoughts: true },
      },
    });
    expect(sent!.body).not.toHaveProperty("tools");
  });

  it("goes to Google's own address, whatever the shell says", async () => {
    vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "https://proxy.example.test/");
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    const api = fakeApi(() => ({ chunks: [textChunk("{}", { finishReason: "STOP" })] }));

    await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(api.sent[0]!.url.origin).toBe("https://generativelanguage.googleapis.com");
  });

  it("returns a rate limit with Google's retry delay, after a single attempt", async () => {
    const api = fakeApi(() =>
      errorResponse(429, {
        code: 429,
        message: "Resource has been exhausted.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }],
      }),
    );

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(reply).toMatchObject({ kind: "failure", failure: "rate-limit", retryAfterMs: 30_000 });
    expect(api.sent).toHaveLength(1);
  });

  it("returns an outage as a server failure, after a single attempt", async () => {
    const api = fakeApi(() =>
      errorResponse(503, { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" }),
    );

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(reply).toMatchObject({ kind: "failure", failure: "server", retryAfterMs: null });
    expect(api.sent).toHaveLength(1);
  });

  it("returns a bad request as a client failure", async () => {
    const api = fakeApi(() =>
      errorResponse(400, { code: 400, message: "Invalid schema.", status: "INVALID_ARGUMENT" }),
    );

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(reply).toMatchObject({ kind: "failure", failure: "client" });
  });

  it("returns a request the network could not send as a dropped connection", async () => {
    const fetch: Fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch }).call(request());

    expect(reply).toMatchObject({ kind: "failure", failure: "connection", message: "fetch failed" });
  });

  it("returns a body the network breaks partway as a dropped connection", async () => {
    const api = fakeApi(() => ({
      chunks: [textChunk('{"email":')],
      failWith: new TypeError("terminated"),
    }));

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(reply).toMatchObject({ kind: "failure", failure: "connection", message: "terminated" });
  });

  it("returns a body that ends in the middle of an event as a dropped connection", async () => {
    const api = fakeApi(() => ({ chunks: ['data: {"candidates":[{"content":'] }));

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(reply).toMatchObject({ kind: "failure", failure: "connection" });
  });

  it("throws an event that is not JSON, since nothing the network does produces one", async () => {
    const api = fakeApi(() => ({ chunks: ["data: not json\r\n\r\n"] }));

    await expect(
      createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request()),
    ).rejects.toThrow();
  });

  it("returns a call its caller aborted as aborted", async () => {
    const controller = new AbortController();
    const api = fakeApi(() => ({ chunks: [textChunk('{"email":')], open: true }));

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request({ signal: controller.signal, onEvent: () => controller.abort() }),
    );

    expect(reply).toMatchObject({ kind: "failure", failure: "aborted" });
  });

  it("counts the system prompt and the response schema as text, since the API counts neither here", async () => {
    const api = fakeApi(() => Response.json({ totalTokens: 1234 }));

    const counted = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).countInputTokens(
      request(),
    );

    expect(counted).toBe(1234);
    expect(api.sent[0]!.url.pathname).toMatch(/:countTokens$/);
    expect(api.sent[0]!.body).toMatchObject({
      contents: [
        {
          parts: [
            { text: "Read the contact box." },
            { text: JSON.stringify(jsonSchemaOf(request().schema)) },
            { text: "The crop:" },
            { inlineData: {} },
          ],
        },
      ],
    });
  });

  it("sorts an error response whose body breaks by its status, so a 4xx is not sent again", async () => {
    const broken = (status: number) => () =>
      new Response(recordedBody(['{"error":{"code":'], { failWith: new TypeError("terminated") }), {
        status,
        headers: { "content-type": "application/json" },
      });

    const rejected = await createGeminiLlm({ apiKey: "test-key", fetch: fakeApi(broken(400)).fetch }).call(request());
    const overloaded = await createGeminiLlm({ apiKey: "test-key", fetch: fakeApi(broken(503)).fetch }).call(request());

    expect(rejected).toMatchObject({ kind: "failure", failure: "client" });
    expect(overloaded).toMatchObject({ kind: "failure", failure: "server" });
  });

  it("settles on a refusal that arrived before the stream broke, rather than sending it again", async () => {
    const api = fakeApi(() => ({
      chunks: [textChunk("", { finishReason: "SAFETY" })],
      failWith: new TypeError("terminated"),
    }));

    const reply = await createGeminiLlm({ apiKey: "test-key", fetch: api.fetch }).call(request());

    expect(reply).toMatchObject({ kind: "refusal", category: "SAFETY" });
  });
});

/** A streamed chunk as the SDK hands it over. */
type Chunk = Parameters<typeof fromChunks>[0][number];

function parsed(...events: string[]): Chunk[] {
  return events.map((text) => JSON.parse(text.slice("data: ".length)) as Chunk);
}

describe("fromChunks", () => {
  it("leaves out thought parts and bills thinking as output", () => {
    const reply = fromChunks(
      parsed(
        textChunk("Weighing the crop.", { thought: true }),
        textChunk('{"email":null}', { finishReason: "STOP" }),
      ),
      MODEL,
    );

    expect(reply).toMatchObject({
      kind: "answer",
      text: '{"email":null}',
      usage: [{ outputTokens: 126 }],
    });
  });

  it("bills cached prompt tokens at the cache rate, not twice", () => {
    const reply = fromChunks(
      parsed(textChunk("{}", { finishReason: "STOP", usage: counts({ cachedContentTokenCount: 300 }) })),
      MODEL,
    );

    expect(reply).toMatchObject({ usage: [{ inputTokens: 500, cacheReadTokens: 300 }] });
  });

  it("prices by the requested model when the version string carries a suffix", () => {
    const [chunk] = parsed(textChunk("{}", { finishReason: "STOP" }));

    const reply = fromChunks([{ ...chunk!, modelVersion: `${MODEL}-001` } as Chunk], MODEL);

    expect(reply).toMatchObject({ model: `${MODEL}-001`, usage: [{ model: MODEL }] });
  });

  it("keeps a finished answer that came without usage, which then keeps its provisional cost", () => {
    expect(
      fromChunks(parsed(textChunk('{"email":null}', { finishReason: "STOP", usage: null })), MODEL),
    ).toMatchObject({ kind: "answer", text: '{"email":null}', usage: [] });
  });

  it("takes MAX_TOKENS and CONTINUATION as an unfinished answer", () => {
    for (const finishReason of ["MAX_TOKENS", "CONTINUATION"]) {
      expect(fromChunks(parsed(textChunk('{"email":', { finishReason })), MODEL), finishReason).toMatchObject({
        kind: "answer",
        truncated: true,
      });
    }
  });

  it("leaves any other ending to the wrapper's parse, with its usage, not calling it cut off", () => {
    expect(fromChunks(parsed(textChunk('{"email":', { finishReason: "OTHER" })), MODEL)).toMatchObject({
      kind: "answer",
      text: '{"email":',
      truncated: false,
      usage: [{ model: MODEL }],
    });
  });

  it("never counts fewer than no input tokens", () => {
    const usage = { cachedContentTokenCount: 300, candidatesTokenCount: 6 };

    expect(fromChunks(parsed(textChunk("{}", { finishReason: "STOP", usage })), MODEL)).toMatchObject({
      usage: [{ inputTokens: 0, cacheReadTokens: 300, outputTokens: 6 }],
    });
  });

  it("reports a safety stop as a refusal, with no usage when none came", () => {
    expect(fromChunks(parsed(textChunk("", { finishReason: "SAFETY", usage: null })), MODEL)).toMatchObject({
      kind: "refusal",
      category: "SAFETY",
      usage: [],
    });
  });

  it("reports a blocked prompt as a refusal", () => {
    const blocked = parsed(
      event({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: counts(), responseId: "resp_2" }),
    );

    expect(fromChunks(blocked, MODEL)).toMatchObject({
      kind: "refusal",
      category: "PROHIBITED_CONTENT",
      requestId: "resp_2",
    });
  });

  it("returns a stream that stopped before a finish reason as a dropped connection", () => {
    expect(fromChunks(parsed(textChunk('{"email":')), MODEL)).toMatchObject({
      kind: "failure",
      failure: "connection",
    });
    expect(fromChunks([], MODEL)).toMatchObject({ kind: "failure", failure: "connection" });
  });
});

describe("fromError", () => {
  const live = new AbortController().signal;

  it("throws anything that is not an error, or an error that is not the network's, since those are bugs", () => {
    expect(() => fromError("oops", live)).toThrow();
    expect(() => fromError(new TypeError("Cannot read properties of undefined"), live)).toThrow(TypeError);
  });

  it("takes the network's failures as dropped connections", () => {
    expect(fromError(new ConnectionLost(new TypeError("fetch failed")), live)).toMatchObject({
      failure: "connection",
    });
  });

  it("calls any error after the caller aborted an abort", () => {
    const controller = new AbortController();
    controller.abort();

    expect(fromError(new ApiError({ message: "{}", status: 503 }), controller.signal)).toMatchObject({
      failure: "aborted",
    });
  });
});

describe("retryDelayOf", () => {
  it("reads Google's retry delay in seconds, and nothing when there is none", () => {
    expect(retryDelayOf('{"error":{"details":[{"retryDelay":"7s"}]}}')).toBe(7000);
    expect(retryDelayOf('{"error":{"details":[{"retryDelay": "1.5s"}]}}')).toBe(1500);
    expect(retryDelayOf('{"error":{"code":429}}')).toBeNull();
  });
});

describe("jsonSchemaOf", () => {
  it("sends the schema without its $schema line", () => {
    const json = jsonSchemaOf(z.object({ email: z.string() }));

    expect(json).toMatchObject({ type: "object", required: ["email"] });
    expect(json).not.toHaveProperty("$schema");
  });
});

describe("toParts", () => {
  it("sends text as text and images inline", () => {
    expect(
      toParts([
        { type: "text", text: "Read this." },
        { type: "image", mediaType: "image/jpeg", base64: "AAAA" },
      ]),
    ).toEqual([{ text: "Read this." }, { inlineData: { mimeType: "image/jpeg", data: "AAAA" } }]);
  });
});
