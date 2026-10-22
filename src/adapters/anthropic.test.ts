import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { caseless } from "@/core/platform/caseless";
import type { LlmRequest } from "@/core/ports";

import {
  createAnthropicLlm,
  fromError,
  fromMessage,
  outputFormat,
  restoreMembers,
  retryAfter,
  toMessages,
} from "./anthropic";
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

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-opus-5-5",
    system: "Read the post.",
    content: [{ type: "text", text: "A post." }],
    schema: z.object({ a: z.number() }),
    effort: "high",
    maxTokens: 4000,
    signal: new AbortController().signal,
    onEvent: () => undefined,
    ...overrides,
  };
}

/** One server-sent event as the API writes it. */
function event(data: { type: string } & Record<string, unknown>): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(model = "claude-opus-5-5"): string {
  return event({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      diagnostics: null,
      usage: {
        input_tokens: 1200,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: null,
      },
    },
  });
}

const textStart = (index: number) =>
  event({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  });
const textDelta = (index: number, text: string) =>
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => event({ type: "content_block_stop", index });
const messageStop = event({ type: "message_stop" });
const ping = event({ type: "ping" });

function messageDelta(
  delta: Record<string, unknown>,
  usage: Record<string, unknown> = { output_tokens: 300 },
): string {
  return event({
    type: "message_delta",
    delta: { stop_sequence: null, stop_details: null, ...delta },
    usage,
  });
}

/** A thinking block as Claude Opus 5.5 streams it by default: no text, only a signature. */
function hiddenThinking(index: number): string[] {
  return [
    event({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    event({
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: "c2ln" },
    }),
    blockStop(index),
  ];
}

function answerOf(text: string): string[] {
  return [
    messageStart(),
    textStart(0),
    textDelta(0, text),
    blockStop(0),
    messageDelta({ stop_reason: "end_turn" }),
    messageStop,
  ];
}

function refusalDetails(overrides: Record<string, unknown> = {}) {
  return {
    type: "refusal",
    category: "cyber",
    explanation: null,
    fallback_credit_token: null,
    fallback_has_prefill_claim: null,
    recommended_model: null,
    ...overrides,
  };
}

const run = (type: string, model: string | null, inputTokens: number, outputTokens: number) => ({
  type,
  model,
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
});

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
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req_stream" },
    });
  };
  return { fetch, sent };
}

describe("createAnthropicLlm", () => {
  it("streams the answer past the hidden thinking, and sends the stage's settings", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        ...hiddenThinking(0),
        textStart(1),
        textDelta(1, '{"a":'),
        textDelta(1, "1}"),
        blockStop(1),
        messageDelta({ stop_reason: "end_turn" }),
        messageStop,
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toEqual({
      kind: "answer",
      text: '{"a":1}',
      model: "claude-opus-5-5",
      requestId: "req_stream",
      usage: [
        {
          model: "claude-opus-5-5",
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      truncated: false,
    });
    const [sent] = api.sent;
    expect(sent!.url.pathname).toBe("/v1/messages");
    expect(sent!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(sent!.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      stream: true,
      system: "Read the post.",
      fallbacks: "default",
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: { type: "object" } },
      },
    });
    expect(sent!.body).not.toHaveProperty("thinking");
    expect(sent!.body).not.toHaveProperty("betas");
  });

  it("asks for no fallback on a model that does not take one", async () => {
    const api = fakeApi(() => ({ chunks: answerOf('{"a":1}') }));

    await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request({ model: "claude-opus-4-8" }),
    );

    expect(api.sent[0]!.body).not.toHaveProperty("fallbacks");
    expect(api.sent[0]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it("sends only its own key to Anthropic's address, whatever the shell says", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.test");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token-from-the-shell");
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      [
        "Authorization: Bearer shell-token",
        "x-api-key: shell-key",
        "cf-aig-authorization: Bearer gateway-token",
        "Cookie: session=shell",
        "anthropic-version: 1999-01-01",
        "anthropic-beta: some-other-beta",
      ].join("\n"),
    );
    const api = fakeApi((sent) =>
      sent.url.pathname.endsWith("count_tokens")
        ? Response.json({ input_tokens: 1, context_management: null })
        : { chunks: answerOf('{"a":1}') },
    );
    const llm = createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch });

    await llm.countInputTokens(request());
    await llm.call(request());
    await llm.call(request({ model: "claude-opus-4-8" }));

    expect(api.sent).toHaveLength(3);
    for (const sent of api.sent) {
      expect(sent.url.origin).toBe("https://api.anthropic.com");
      expect(sent.headers.get("x-api-key")).toBe("test-key");
      expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
      for (const name of ["authorization", "cf-aig-authorization", "cookie"]) {
        expect(sent.headers.get(name), name).toBeNull();
      }
    }
    expect(api.sent.map((sent) => sent.headers.get("anthropic-beta"))).toEqual([
      null,
      "server-side-fallback-2026-07-01",
      null,
    ]);
  });

  it("asks for fallbacks on a dated snapshot of a model that takes them", async () => {
    const api = fakeApi(() => ({ chunks: answerOf('{"a":1}') }));

    await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request({ model: "claude-opus-5-5-20260801" }),
    );

    expect(api.sent[0]!.body).toMatchObject({ fallbacks: "default" });
  });

  it("joins an answer a fallback model finished after the first model declined mid-stream", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        textStart(0),
        textDelta(0, '{"a":'),
        blockStop(0),
        event({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "fallback",
            from: { model: "claude-opus-5-5" },
            to: { model: "claude-opus-4-8" },
            trigger: { type: "refusal", category: "cyber" },
          },
        }),
        blockStop(1),
        textStart(2),
        textDelta(2, "1}"),
        blockStop(2),
        messageDelta(
          { stop_reason: "end_turn" },
          {
            output_tokens: 10,
            iterations: [
              run("message", null, 1200, 4),
              run("fallback_message", "claude-opus-4-8", 1210, 6),
            ],
          },
        ),
        messageStop,
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({
      kind: "answer",
      text: '{"a":1}',
      model: "claude-opus-4-8",
      usage: [
        { model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 4 },
        { model: "claude-opus-4-8", inputTokens: 1210, outputTokens: 6 },
      ],
    });
  });

  it("names and prices the fallback model on a turn it served from the start, with no fallback block", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart("claude-opus-4-8"),
        textStart(0),
        textDelta(0, '{"a":1}'),
        blockStop(0),
        messageDelta(
          { stop_reason: "end_turn" },
          { output_tokens: 8, iterations: [run("fallback_message", "claude-opus-4-8", 1200, 8)] },
        ),
        messageStop,
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({
      kind: "answer",
      model: "claude-opus-4-8",
      usage: [{ model: "claude-opus-4-8", inputTokens: 1200, outputTokens: 8 }],
    });
  });

  it("reports a refusal even when the declined answer stopped partway through the JSON", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        textStart(0),
        textDelta(0, '{"a":'),
        blockStop(0),
        messageDelta({ stop_reason: "refusal", stop_details: refusalDetails() }),
        messageStop,
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "refusal", category: "cyber", requestId: "req_stream" });
  });

  it("keeps a refusal whose fallback model was too busy to run as a refusal, with what it cost", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        messageDelta({
          stop_reason: "refusal",
          stop_details: refusalDetails({ recommended_model: "claude-opus-4-8" }),
        }),
        messageStop,
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({
      kind: "refusal",
      category: "cyber",
      detail: "the fallback model was too busy to run; the API suggests claude-opus-4-8",
      usage: [{ model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 300 }],
    });
  });

  it("settles on a refusal whose closing event was lost, rather than sending it again", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        messageDelta({ stop_reason: "refusal", stop_details: refusalDetails() }),
      ],
      failWith: new TypeError("terminated"),
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "refusal", category: "cyber" });
  });

  it("returns an answer cut off at max_tokens as truncated, not as a failure", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        textStart(0),
        textDelta(0, '{"a":'),
        blockStop(0),
        messageDelta({ stop_reason: "max_tokens" }),
        messageStop,
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "answer", text: '{"a":', truncated: true });
  });

  it("counts keep-alive pings as signs of life while the model thinks", async () => {
    const chunks = [
      messageStart(),
      ...hiddenThinking(0),
      ping,
      ping,
      ping,
      textStart(1),
      textDelta(1, '{"a":1}'),
      blockStop(1),
      messageDelta({ stop_reason: "end_turn" }),
      messageStop,
    ];
    const onEvent = vi.fn();

    await createAnthropicLlm({ apiKey: "test-key", fetch: fakeApi(() => ({ chunks })).fetch }).call(
      request({ onEvent }),
    );

    // Once when the response arrives, then once per chunk of its body.
    expect(onEvent).toHaveBeenCalledTimes(chunks.length + 1);
  });

  it("returns an overload reported in the middle of the stream as a server failure", async () => {
    const api = fakeApi(() => ({
      chunks: [
        messageStart(),
        textStart(0),
        textDelta(0, '{"a":'),
        event({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      ],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "failure", failure: "server" });
  });

  it("takes an error event it cannot read for the server's fault", async () => {
    const api = fakeApi(() => ({
      chunks: [messageStart(), "event: error\ndata: upstream connect error\n\n"],
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "failure", failure: "server" });
  });

  it("returns a rate limit with the wait the API asked for", async () => {
    const api = fakeApi(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Slow down" },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "3",
              "request-id": "req_429",
            },
          },
        ),
    );

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toEqual({
      kind: "failure",
      failure: "rate-limit",
      message: expect.any(String),
      requestId: "req_429",
      retryAfterMs: 3000,
    });
    // The wrapper waits and retries; the SDK sends nothing more itself.
    expect(api.sent).toHaveLength(1);
  });

  it("returns a server error after a single request, since the SDK's own retries are off", async () => {
    const api = fakeApi(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
          {
            status: 529,
            headers: { "content-type": "application/json", "request-id": "req_529" },
          },
        ),
    );

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "failure", failure: "server", requestId: "req_529" });
    expect(api.sent).toHaveLength(1);
  });

  it("returns a body that ends before the message does as a dropped connection, with its request ID", async () => {
    const api = fakeApi(() => ({ chunks: [messageStart(), textStart(0), textDelta(0, '{"a":')] }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({
      kind: "failure",
      failure: "connection",
      requestId: "req_stream",
    });
  });

  it("returns a body the network breaks partway as a dropped connection", async () => {
    const api = fakeApi(() => ({
      chunks: [messageStart(), textStart(0), textDelta(0, '{"a":')],
      failWith: new TypeError("terminated"),
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "failure", failure: "connection", message: "terminated" });
  });

  it("keeps a whole message whose connection broke only after it ended", async () => {
    const api = fakeApi(() => ({
      chunks: answerOf('{"a":1}'),
      failWith: new TypeError("terminated"),
    }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request(),
    );

    expect(reply).toMatchObject({ kind: "answer", text: '{"a":1}', truncated: false });
  });

  it("throws a bug that breaks the stream after the message ended, rather than hiding it", async () => {
    const chunks = [...answerOf('{"a":1}'), ping];
    let events = 0;
    const onEvent = () => {
      // The response, then each chunk: the last call is the ping after message_stop.
      if (++events === chunks.length + 1) throw new RangeError("a bug in the caller");
    };

    await expect(
      createAnthropicLlm({ apiKey: "test-key", fetch: fakeApi(() => ({ chunks })).fetch }).call(
        request({ onEvent }),
      ),
    ).rejects.toThrow("a bug in the caller");
  });

  it("throws a fault inside the stream that is not the network's, since that is a bug", async () => {
    const api = fakeApi(() => ({
      chunks: [messageStart(), textStart(0), textDelta(0, '{"a":1}')],
    }));
    let events = 0;
    const onEvent = () => {
      if (++events === 3) throw new RangeError("a bug in the caller");
    };

    await expect(
      createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(request({ onEvent })),
    ).rejects.toThrow("a bug in the caller");
  });

  it("throws a schema the API cannot take, before sending anything", async () => {
    const api = fakeApi(() => ({ chunks: answerOf("{}") }));

    await expect(
      createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
        request({ schema: z.object({ at: z.date() }) }),
      ),
    ).rejects.toThrow();
    expect(api.sent).toHaveLength(0);
  });

  it("returns a call its caller aborted as aborted", async () => {
    const controller = new AbortController();
    const api = fakeApi(() => ({ chunks: [messageStart(), textStart(0)], open: true }));

    const reply = await createAnthropicLlm({ apiKey: "test-key", fetch: api.fetch }).call(
      request({ signal: controller.signal, onEvent: () => controller.abort() }),
    );

    expect(reply).toMatchObject({ kind: "failure", failure: "aborted" });
  });

  it("counts input tokens with the same schema the call sends", async () => {
    const api = fakeApi(() => Response.json({ input_tokens: 1234, context_management: null }));

    const counted = await createAnthropicLlm({
      apiKey: "test-key",
      fetch: api.fetch,
    }).countInputTokens(request());

    expect(counted).toBe(1234);
    expect(api.sent[0]!.url.pathname).toBe("/v1/messages/count_tokens");
    expect(api.sent[0]!.body).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
  });
});

describe("outputFormat", () => {
  it("keeps the JSON schema and leaves out the SDK's parser", () => {
    const format = outputFormat(z.object({ a: z.number() }));

    expect(format).toEqual({
      type: "json_schema",
      schema: expect.objectContaining({ type: "object" }),
    });
    expect("parse" in format).toBe(false);
  });

  it("sends enum and const values, which the SDK's helper folds into descriptions, so the API constrains the model to them", () => {
    const format = outputFormat(
      z.object({
        kind: z.enum(["a", "b"]),
        fixed: z.literal("x"),
        list: z.array(z.object({ tag: z.enum(["c", "d"]) })),
        either: z.union([z.object({ u: z.enum(["e"]) }), z.object({ v: z.literal(1) })]),
      }),
    );
    const properties = (format.schema as { properties: Record<string, Record<string, unknown>> })
      .properties;

    expect(properties.kind).toMatchObject({ type: "string", enum: ["a", "b"] });
    expect(properties.fixed).toMatchObject({ const: "x" });
    expect(properties.list).toMatchObject({ items: { properties: { tag: { enum: ["c", "d"] } } } });
    expect(properties.either).toMatchObject({
      anyOf: [{ properties: { u: { enum: ["e"] } } }, { properties: { v: { const: 1 } } }],
    });
  });

  it("sends the values of an enum the schema uses twice, which the helper moves to $defs", () => {
    const mode = z.enum(["remote", "onsite"]);
    const format = outputFormat(z.object({ first: mode, second: mode }));

    expect(format.schema).toMatchObject({
      properties: { first: { $ref: "#/$defs/__schema0" }, second: { $ref: "#/$defs/__schema0" } },
      $defs: { __schema0: { type: "string", enum: ["remote", "onsite"] } },
    });
  });

  it("sends each enum value once, though the schema lists one twice", () => {
    const format = outputFormat(z.object({ mode: z.enum({ A: "x", B: "x", C: "y" }) }));

    expect(format.schema).toMatchObject({ properties: { mode: { enum: ["x", "y"] } } });
  });

  it("sends a discriminated union's and an intersection's values, which the helper reshapes", () => {
    const format = outputFormat(
      z.object({
        either: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("email"), tone: z.enum(["formal", "warm"]) }),
          z.object({ kind: z.literal("form") }),
        ]),
        both: z.intersection(z.object({ a: z.enum(["x"]) }), z.object({ b: z.literal(2) })),
      }),
    );

    expect(format.schema).toMatchObject({
      properties: {
        either: {
          anyOf: [
            { properties: { kind: { const: "email" }, tone: { enum: ["formal", "warm"] } } },
            { properties: { kind: { const: "form" } } },
          ],
        },
        // zod merges an intersection of two objects into one object.
        both: { properties: { a: { enum: ["x"] }, b: { const: 2 } } },
      },
    });
  });

  it("sends the values of a caseless field", () => {
    const format = outputFormat(z.object({ kind: caseless(["full_time", "part_time"]) }));

    expect(format.schema).toMatchObject({
      properties: { kind: { type: "string", enum: ["full_time", "part_time"] } },
    });
  });

  it("restores nothing onto a node that changed kind on one side only", () => {
    const from = {
      type: "object",
      properties: {
        referenced: { type: "string", enum: ["x"] },
        wrapped: { type: "string", enum: ["y"] },
        untyped: { type: "string", enum: ["z"] },
      },
    };
    // As a changed helper might write them: moved to $defs, wrapped in a union, or with no type.
    const to = {
      type: "object",
      properties: {
        referenced: { $ref: "#/$defs/A" },
        wrapped: { type: "string", anyOf: [{ type: "string" }, { type: "null" }] },
        untyped: { description: '{enum: ["z"]}' },
      },
    };
    const before = JSON.stringify(to);

    restoreMembers(from, to);

    expect(JSON.stringify(to)).toBe(before);
  });

  it("leaves values the helper already keeps, and restores each part of an intersection", () => {
    const from = {
      allOf: [
        { type: "string", enum: ["a", "b"] },
        { type: "string", const: "a" },
      ],
    };
    const to = { allOf: [{ type: "string", enum: ["b", "a"] }, { type: "string" }] };

    restoreMembers(from, to);

    expect(to).toEqual({
      allOf: [
        { type: "string", enum: ["b", "a"] },
        { type: "string", const: "a" },
      ],
    });
  });

  it("restores nothing where the helper's nodes no longer line up with the schema's", () => {
    const from = {
      type: "object",
      properties: {
        filtered: {
          anyOf: [
            { type: "string", enum: ["a"] },
            { type: "string", enum: ["b"] },
          ],
        },
        reordered: {
          anyOf: [
            { type: "string", enum: ["b"] },
            { type: "number", const: 1 },
          ],
        },
        renamed: { type: "object", properties: { kind: { type: "string", enum: ["c"] } } },
      },
    };
    // As a changed helper might write it: a branch dropped (which one?), two swapped, a property renamed.
    const to = {
      type: "object",
      properties: {
        filtered: { anyOf: [{ type: "string" }] },
        reordered: { anyOf: [{ type: "number" }, { type: "string" }] },
        renamed: { type: "object", properties: { sort: { type: "string" } } },
      },
    };
    const before = JSON.stringify(to);

    restoreMembers(from, to);

    expect(JSON.stringify(to)).toBe(before);
  });
});

describe("toMessages", () => {
  // Extraction spec, "Images sent to Claude": a sizing mistake fails loudly
  // instead of shifting the coordinates a model reports.
  it("sends text and base64 images as one user turn, each image refusing to be downscaled", () => {
    expect(
      toMessages({
        content: [
          { type: "text", text: "Read this." },
          { type: "image", mediaType: "image/webp", base64: "AAAA" },
        ],
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Read this." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/webp", data: "AAAA" },
            transformations: { oversized_image: "error" },
          },
        ],
      },
    ]);
  });
});

function message(overrides: Partial<BetaMessage>): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      iterations: null,
    },
    ...overrides,
  } as BetaMessage;
}

describe("fromMessage", () => {
  it("prices the top-level usage by the requested model, whatever ID the API names it by", () => {
    expect(
      fromMessage(message({ model: "claude-opus-5-5-20260801" }), "req_1", "claude-opus-5-5"),
    ).toMatchObject({
      model: "claude-opus-5-5-20260801",
      usage: [
        {
          model: "claude-opus-5-5",
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
  });

  it("prices each run of a two-hop fallback by its own model", () => {
    const reply = fromMessage(
      message({
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 1300,
          output_tokens: 9,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          iterations: [
            run("message", null, 1200, 0),
            run("message", "claude-opus-5", 1200, 3),
            run("fallback_message", "claude-opus-4-8", 1300, 9),
          ],
        } as unknown as BetaMessage["usage"],
      }),
      null,
      "claude-opus-5-5",
    );

    expect(reply).toMatchObject({
      usage: [
        { model: "claude-opus-5-5" },
        { model: "claude-opus-5" },
        { model: "claude-opus-4-8" },
      ],
    });
  });

  it("takes max_tokens and a full context window as a cut-off answer", () => {
    for (const stop_reason of ["max_tokens", "model_context_window_exceeded"] as const) {
      expect(
        fromMessage(message({ stop_reason }), null, "claude-opus-5-5"),
        stop_reason,
      ).toMatchObject({
        kind: "answer",
        truncated: true,
      });
    }
    expect(
      fromMessage(message({ stop_reason: "stop_sequence" }), null, "claude-opus-5-5"),
    ).toMatchObject({
      truncated: false,
    });
  });

  it("leaves any other ending to the wrapper's parse, with its usage, not calling it cut off", () => {
    for (const stop_reason of ["pause_turn", null] as const) {
      expect(
        fromMessage(message({ stop_reason }), "req_1", "claude-opus-5-5"),
        String(stop_reason),
      ).toMatchObject({
        kind: "answer",
        truncated: false,
        usage: [{ model: "claude-opus-5-5", outputTokens: 300 }],
      });
    }
  });
});

describe("fromError", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("sorts the SDK's errors into the wrapper's failure kinds", () => {
    const cases: [unknown, string][] = [
      [new Anthropic.RateLimitError(429, {}, "slow down", headers({})), "rate-limit"],
      [new Anthropic.InternalServerError(529, {}, "overloaded", headers({})), "server"],
      [new Anthropic.APIError(408, {}, "timed out", headers({})), "server"],
      [new Anthropic.APIConnectionError({ message: "socket hang up" }), "connection"],
      [new Anthropic.APIUserAbortError(), "aborted"],
      [new Anthropic.BadRequestError(400, {}, "bad", headers({})), "client"],
      [new Anthropic.AuthenticationError(401, {}, "no key", headers({})), "client"],
      [
        new Anthropic.APIError(undefined, {}, "bad request", undefined, "invalid_request_error"),
        "client",
      ],
    ];

    for (const [error, kind] of cases) {
      expect(fromError(error), kind).toMatchObject({ kind: "failure", failure: kind });
    }
  });

  it("follows the API's x-should-retry header over the status", () => {
    const retryable = new Anthropic.BadRequestError(
      400,
      {},
      "x",
      headers({ "x-should-retry": "true" }),
    );
    const final = new Anthropic.InternalServerError(
      500,
      {},
      "x",
      headers({ "x-should-retry": "false" }),
    );

    expect(fromError(retryable)).toMatchObject({ failure: "server" });
    expect(fromError(final)).toMatchObject({ failure: "client" });
  });

  it("takes a stream that broke under the network, and only that, as a dropped connection", () => {
    const broke = new Anthropic.AnthropicError("terminated");
    broke.cause = new ConnectionLost(new TypeError("terminated"));
    const bug = new Anthropic.AnthropicError(
      "Cannot read properties of undefined (reading 'type')",
    );
    bug.cause = new TypeError("Cannot read properties of undefined (reading 'type')");

    expect(fromError(broke, "req_7")).toMatchObject({ failure: "connection", requestId: "req_7" });
    expect(() => fromError(bug)).toThrow(bug);
  });

  it("does not pass on a wait for an error that is not worth retrying", () => {
    const error = new Anthropic.BadRequestError(400, {}, "bad", headers({ "retry-after": "3" }));

    expect(fromError(error)).toMatchObject({ retryAfterMs: null });
  });

  it("throws anything that is not the SDK's, since that is a bug", () => {
    expect(() => fromError(new TypeError("oops"))).toThrow(TypeError);
  });
});

describe("retryAfter", () => {
  it("reads milliseconds, seconds or an HTTP date, and nothing when absent", () => {
    expect(retryAfter(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfter(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(
      retryAfter(new Headers({ "retry-after": new Date(Date.now() + 60_000).toUTCString() })),
    ).toBeGreaterThan(50_000);
    expect(retryAfter(new Headers())).toBeNull();
    expect(retryAfter(undefined)).toBeNull();
  });
});
