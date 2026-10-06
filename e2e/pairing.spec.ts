import { readFileSync } from "node:fs";

import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

/**
 * QR pairing across two browsers (platform spec B3; B10, AC5 to AC8): a
 * laptop signed in through the test sign-in route, and a phone that learns
 * the token only from the QR code's link.
 */

// Rendered by src/app/(app)/test/data/page.testonly.tsx for live, approved sessions.
const MARKER = "jobkit-e2e-owner-data-marker";
// Everything the dev server prints (e2e/devServer.mjs).
const SERVER_LOG = ".data/e2e/server.log";

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every URL the browser requested, without its fragment, which never leaves the browser. */
  sent: string[];
}

test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/test/reset")).status()).toBe(204);
});

async function open(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  const sent: string[] = [];
  context.on("request", (request) => sent.push(request.url().split("#")[0]!));
  return { context, page: await context.newPage(), sent } satisfies Device;
}

async function laptop(browser: Browser): Promise<Device> {
  const device = await open(browser);
  await device.page.goto("/login");
  const status = await device.page.evaluate(
    async () => (await fetch("/api/test/signin", { method: "POST" })).status,
  );
  expect(status).toBe(204);
  return device;
}

function phone(browser: Browser): Promise<Device> {
  return open(browser, { ...devices["Pixel 7"] });
}

/** The laptop makes a code; the phone opens the QR code's link and shows its six digits. */
async function scan(from: Device, to: Device): Promise<{ token: string; code: string }> {
  await from.page.goto("/devices");
  const [made] = await Promise.all([
    from.page.waitForResponse((response) => response.url().endsWith("/api/pair/tokens")),
    from.page.getByRole("button", { name: "Pair a phone" }).click(),
  ]);
  const { url } = (await made.json()) as { url: string };
  await expect(from.page.getByRole("img", { name: "QR code that pairs a phone" })).toBeVisible();

  // What the phone's camera does with the QR code.
  await to.page.goto(url);
  const shown = to.page.getByLabel(/^Code \d( \d){5}$/);
  await expect(shown).toBeVisible();
  const code = (await shown.textContent())!.replace(/\D/g, "");
  return { token: new URL(url).hash.slice("#t=".length), code };
}

async function approve(from: Device, code: string): Promise<void> {
  await expect(from.page.getByText(/A phone is waiting/)).toBeVisible();
  await from.page.getByLabel("Code from the phone").fill(code);
  await from.page.getByRole("button", { name: "Approve" }).click();
}

test("pairs a phone, and the token never reaches a request URL or a server log line", async ({
  browser,
}) => {
  const owner = await laptop(browser);
  const mobile = await phone(browser);

  const { token, code } = await scan(owner, mobile);
  // The phone's page took the token out of its address bar at once.
  await expect(mobile.page).toHaveURL(/\/pair$/);
  await approve(owner, code);

  await expect(mobile.page).toHaveURL(/\/jobs$/);
  await expect(mobile.page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  await owner.page.reload();
  await expect(owner.page.getByText("Paired phone")).toBeVisible();
  for (const url of [...owner.sent, ...mobile.sent]) expect(url).not.toContain(token);
  expect(readFileSync(SERVER_LOG, "utf8")).not.toContain(token);
});

test("a phone waiting for approval gets none of the owner's data, from pages or payloads", async ({
  browser,
}) => {
  const owner = await laptop(browser);
  const mobile = await phone(browser);
  const { code } = await scan(owner, mobile);
  // The check below means something only if the page does show data to an approved session.
  await owner.page.goto("/test/data");
  await expect(owner.page.getByText(MARKER)).toBeVisible();

  for (const path of ["/jobs", "/test/data", "/devices"]) {
    await mobile.page.goto(path);
    await expect(mobile.page).toHaveURL(/\/pair$/);
    const bodies = await mobile.page.evaluate(async (target) => {
      const html = await (await fetch(target)).text();
      const payload = await (await fetch(target, { headers: { RSC: "1" } })).text();
      return [html, payload];
    }, path);
    for (const body of bodies) expect(body).not.toContain(MARKER);
  }
  // Only the waiting screen, with the phone's code still on it.
  await expect(mobile.page.getByLabel(/^Code /)).toBeVisible();

  await owner.page.goto("/devices");
  await approve(owner, code);
  await expect(mobile.page).toHaveURL(/\/jobs$/);
  await mobile.page.goto("/test/data");
  await expect(mobile.page.getByText(MARKER)).toBeVisible();
});

test("a paired phone cannot reach Devices, and once revoked it is sent to sign in", async ({
  browser,
}) => {
  const owner = await laptop(browser);
  const mobile = await phone(browser);
  const { code } = await scan(owner, mobile);
  await approve(owner, code);
  await expect(mobile.page).toHaveURL(/\/jobs$/);

  await expect(mobile.page.getByRole("link", { name: "Devices" })).toHaveCount(0);
  await mobile.page.goto("/devices");
  await expect(mobile.page).toHaveURL(/\/jobs$/);

  await owner.page.reload();
  owner.page.once("dialog", (dialog) => void dialog.accept());
  await owner.page.getByRole("button", { name: /^Revoke Android/ }).click();
  await expect(owner.page.getByText("Paired phone")).toHaveCount(0);

  await mobile.page.goto("/jobs");
  await expect(mobile.page).toHaveURL(/\/login$/);
});
