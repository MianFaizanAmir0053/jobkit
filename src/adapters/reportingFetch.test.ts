import { describe, expect, it, vi } from "vitest";

import { recordedBody } from "./recordedBody";
import { ConnectionLost, type Fetch, reportingChunks } from "./reportingFetch";

const URL_ = "https://api.example.test/";
const aborted = () => new DOMException("This operation was aborted", "AbortError");

describe("reportingChunks", () => {
  it("reports the response and each chunk of its body, and passes the body on unchanged", async () => {
    const chunks = ["event: ping\n\n", "event: ping\n\n", "data: done\n\n"];
    const fetch: Fetch = async () => new Response(recordedBody(chunks), { status: 200 });
    const onChunk = vi.fn();

    const response = await reportingChunks(fetch, onChunk)(URL_);

    expect(await response.text()).toBe(chunks.join(""));
    expect(onChunk).toHaveBeenCalledTimes(chunks.length + 1);
  });

  it("keeps an error response's status, headers and body for the SDK to read", async () => {
    const fetch: Fetch = async () =>
      new Response('{"error":"slow down"}', { status: 429, headers: { "retry-after": "3" } });

    const response = await reportingChunks(fetch, () => undefined)(URL_);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe('{"error":"slow down"}');
  });

  it("marks an error response whose body breaks while it is read as ConnectionLost", async () => {
    const fetch: Fetch = async () =>
      new Response(recordedBody(['{"error":'], { failWith: new TypeError("terminated") }), {
        status: 503,
      });

    const response = await reportingChunks(fetch, () => undefined)(URL_);

    await expect(response.json()).rejects.toBeInstanceOf(ConnectionLost);
  });

  it("keeps the status and headers of a streamed response", async () => {
    const fetch: Fetch = async () =>
      new Response(recordedBody([]), { status: 200, headers: { "request-id": "req_1" } });

    const response = await reportingChunks(fetch, () => undefined)(URL_);

    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toBe("req_1");
  });

  it("marks a request the network could not send as ConnectionLost, keeping the cause", async () => {
    const cause = new TypeError("fetch failed");
    const fetch: Fetch = async () => {
      throw cause;
    };

    const sent = reportingChunks(fetch, () => undefined)(URL_);

    await expect(sent).rejects.toBeInstanceOf(ConnectionLost);
    await expect(sent).rejects.toMatchObject({ message: "fetch failed", cause });
  });

  it("marks a body the network breaks partway as ConnectionLost", async () => {
    const fetch: Fetch = async () =>
      new Response(recordedBody(["data: 1\n\n"], { failWith: new TypeError("terminated") }), { status: 200 });

    const response = await reportingChunks(fetch, () => undefined)(URL_);

    await expect(response.text()).rejects.toBeInstanceOf(ConnectionLost);
  });

  it("lets an abort through untouched, for the SDK to recognise", async () => {
    const refused: Fetch = async () => {
      throw aborted();
    };
    const stopped = new AbortController();
    const open: Fetch = async () =>
      new Response(recordedBody(["data: 1\n\n"], { openUntil: stopped.signal }), { status: 200 });

    await expect(reportingChunks(refused, () => undefined)(URL_)).rejects.toMatchObject({
      name: "AbortError",
    });
    const response = await reportingChunks(open, () => undefined)(URL_);
    const reading = response.text();
    stopped.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
});
