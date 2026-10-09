/** The fetch a provider SDK calls; tests answer with recorded streams instead of the network. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The platform's fetch, looked up on each call. */
export const networkFetch: Fetch = (input, init) => globalThis.fetch(input, init);

/**
 * The network failed under a request: it could not be sent, or its response
 * broke off. The adapters count this, and only this, as a dropped
 * connection, so an error from anywhere else surfaces as the bug it is.
 */
export class ConnectionLost extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ConnectionLost";
  }
}

/**
 * Fetch that reports the response and every chunk of its body, so the
 * wrapper's idle timer hears every sign of life (platform spec B4): the SDKs
 * drop keep-alive pings, which would otherwise make a model that thinks
 * silently look like a dead connection. It also marks network failures as
 * ConnectionLost. An abort passes through untouched, for the SDK to
 * recognise as one. `onChunk` must not throw.
 */
export function reportingChunks(fetch: Fetch, onChunk: () => void): Fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      throw isAbort(error) ? error : new ConnectionLost(error);
    }
    onChunk();
    if (response.status >= 400) return settledError(response);
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          controller.error(isAbort(error) ? error : new ConnectionLost(error));
          return;
        }
        if (read.done) return controller.close();
        onChunk();
        controller.enqueue(read.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * An error response read whole here, so the SDK always gets its status, and
 * the error is sorted by it: a body that breaks off is replaced by a short
 * JSON error, rather than becoming a dropped connection that would get a
 * 4xx sent again.
 */
async function settledError(response: Response): Promise<Response> {
  let body: ArrayBuffer | string;
  try {
    body = await response.arrayBuffer();
  } catch (error) {
    if (isAbort(error)) throw error;
    body = JSON.stringify({ error: { code: response.status, message: "The error response broke off." } });
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
