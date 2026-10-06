import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

async function headersFor(source: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === source);
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe("the response headers in next.config.ts", () => {
  it("stop other sites framing any page, such as the Devices page's Approve button", async () => {
    expect(await headersFor("/(.*)")).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });

  it("serve the service worker as JavaScript that is never cached stale", async () => {
    expect(await headersFor("/sw.js")).toMatchObject({
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'",
    });
  });
});
