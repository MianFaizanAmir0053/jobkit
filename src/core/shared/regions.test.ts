import { describe, expect, it } from "vitest";

import { isPlaceCode, placeCode, placeContains, placeName } from "./regions";

describe("placeCode", () => {
  it.each([
    ["UK", "GB"],
    ["United Kingdom", "GB"],
    ["U.K.", "GB"],
    ["London", "GB"],
    ["Germany", "DE"],
    ["DE", "DE"],
    ["Europe", "EUROPE"],
    ["European Union", "EU"],
    ["USA", "US"],
    ["United States of America", "US"],
    ["U.S.", "US"],
    ["Dubai", "AE"],
    ["UAE", "AE"],
    ["KSA", "SA"],
    ["Lahore", "PK"],
    ["Cote d'Ivoire", "CI"],
    ["Côte d’Ivoire", "CI"],
    ["Türkiye", "TR"],
    ["Turkey", "TR"],
    ["the Netherlands", "NL"],
    ["Worldwide", "WORLDWIDE"],
    ["Anywhere", "WORLDWIDE"],
    ["the Gulf", "GCC"],
    ["Asia-Pacific", "APAC"],
  ])("maps %j to %j", (text, code) => {
    expect(placeCode(text)).toBe(code);
  });

  it("looks a name up whole, never as part of another", () => {
    expect(placeCode("US only")).toBeNull();
    expect(placeCode("Atlantis")).toBeNull();
  });
});

describe("isPlaceCode and placeName", () => {
  it("knows every country and region code, by name", () => {
    expect(isPlaceCode("PK")).toBe(true);
    expect(isPlaceCode("EU")).toBe(true);
    expect(isPlaceCode("XX")).toBe(false);
    expect(placeName("GB")).toBe("United Kingdom");
    expect(placeName("XX")).toBe("XX");
  });
});

describe("placeContains", () => {
  it("answers for countries and regions, and says when a region's membership is unclear", () => {
    expect(placeContains("EU", "DE")).toBe(true);
    expect(placeContains("EU", "GB")).toBe(false);
    expect(placeContains("EUROPE", "GB")).toBe(true);
    expect(placeContains("GCC", "AE")).toBe(true);
    expect(placeContains("SOUTH_ASIA", "PK")).toBe(true);
    expect(placeContains("WORLDWIDE", "PK")).toBe(true);
    expect(placeContains("PK", "PK")).toBe(true);
    expect(placeContains("US", "PK")).toBe(false);
    expect(placeContains("EMEA", "PK")).toBe("unknown");
    expect(placeContains("ATLANTIS", "PK")).toBe(false);
  });
});
