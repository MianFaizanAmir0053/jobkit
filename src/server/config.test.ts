import { describe, expect, it } from "vitest";

import { readAppConfig } from "./config";

const production = {
  JOBKIT_ENV: "production",
  APP_ORIGIN: "https://jobkit.example.com",
  OWNER_EMAIL: "owner@example.com",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
};

describe("readAppConfig", () => {
  it("reads the production values", () => {
    expect(readAppConfig(production)).toEqual({
      appOrigin: "https://jobkit.example.com",
      ownerEmail: "owner@example.com",
      google: { clientId: "client-id", clientSecret: "client-secret" },
    });
  });

  it("defaults to the local origin outside production, with Google left unset", () => {
    expect(readAppConfig({ JOBKIT_ENV: "development" })).toEqual({
      appOrigin: "http://localhost:3000",
      ownerEmail: "",
      google: { clientId: "", clientSecret: "" },
    });
  });

  it("refuses to run production without its origin or Google client", () => {
    expect(() => readAppConfig({ ...production, APP_ORIGIN: "" })).toThrow(/APP_ORIGIN/);
    expect(() => readAppConfig({ ...production, GOOGLE_CLIENT_SECRET: "" })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
  });

  it("refuses an origin with a path or trailing slash, and plain http in production", () => {
    expect(() =>
      readAppConfig({ ...production, APP_ORIGIN: "https://jobkit.example.com/" }),
    ).toThrow(/APP_ORIGIN/);
    expect(() => readAppConfig({ ...production, APP_ORIGIN: "http://jobkit.example.com" })).toThrow(
      /https/,
    );
  });

  it("on a Vercel deployment, refuses anything but production instead of relaxing its checks", () => {
    const deployed = { ...production, VERCEL: "1", VERCEL_ENV: "production" };

    expect(() => readAppConfig({ ...deployed, JOBKIT_ENV: "test" })).toThrow(/Vercel production deployment/);
    expect(readAppConfig(deployed).appOrigin).toBe("https://jobkit.example.com");
    // A local file from `vercel env pull` carries VERCEL=1 too, with VERCEL_ENV=development.
    expect(
      readAppConfig({ VERCEL: "1", VERCEL_ENV: "development", JOBKIT_ENV: "development" }).appOrigin,
    ).toBe("http://localhost:3000");
  });
});
