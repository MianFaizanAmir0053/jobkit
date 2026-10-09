import { afterEach, describe, expect, it, vi } from "vitest";

import { register } from "./instrumentation";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("register", () => {
  it("stops the dev server when it finds one of the app's keys", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GEMINI_API_KEY", "app-key-value-0123");

    expect(() => register()).toThrow(/^This local server refuses to start: .*GEMINI_API_KEY is set/);
  });

  it("stops a local production build that is not set up as production", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JOBKIT_ENV", "development");
    vi.stubEnv("GEMINI_API_KEY", "app-key-value-0123");

    expect(() => register()).toThrow(/GEMINI_API_KEY is set/);
  });

  it("stops the dev server even when a pulled .env file carries Vercel's own variables", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("JOBKIT_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "app-key-value-0123");

    expect(() => register()).toThrow(/GEMINI_API_KEY is set/);
  });

  it("leaves a Vercel deployment to the container, which names a wrong JOBKIT_ENV instead", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("JOBKIT_ENV", "");
    vi.stubEnv("GEMINI_API_KEY", "app-key-value-0123");

    expect(() => register()).not.toThrow();
  });

  it("lets the production server start with the app's keys, which it needs", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JOBKIT_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "app-key-value-0123");

    expect(() => register()).not.toThrow();
  });
});
