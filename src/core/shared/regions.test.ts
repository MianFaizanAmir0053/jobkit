import { describe, expect, it } from "vitest";

import {
  isCountryCode,
  isPlaceCode,
  isUnclearRegion,
  placeCode,
  placeContains,
  placeName,
} from "./regions";

describe("placeCode", () => {
  it.each([
    ["UK", "GB"],
    ["United Kingdom", "GB"],
    ["U.K.", "GB"],
    ["London", "GB"],
    ["Germany", "DE"],
    ["Europe", "EUROPE"],
    ["European Union", "EU"],
    ["EU", "EU"],
    ["USA", "US"],
    ["US", "US"],
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

  it.each([
    ["US only", "US"],
    ["UK only", "GB"],
    ["the UAE", "AE"],
    ["Remote US", "US"],
    ["Remote, UK only", "GB"],
    ["US-based", "US"],
  ])("reads past the words around a place: %j is %j", (text, code) => {
    expect(placeCode(text)).toBe(code);
  });

  it("looks a name up whole, never as part of another", () => {
    expect(placeCode("US and Canada")).toBeNull();
    expect(placeCode("Atlantis")).toBeNull();
    expect(placeCode("Remote")).toBeNull();
  });

  it("does not read a bare country code as a place, since CA, IN and IT are also states and words", () => {
    for (const text of ["DE", "CA", "IN", "IT", "GA", "LA", "QA", "AI"])
      expect(placeCode(text)).toBeNull();
  });

  it("knows no place for a name two places share", () => {
    expect(placeCode("Hyderabad")).toBeNull();
    expect(placeCode("Georgia")).toBeNull();
    expect(placeCode("Tbilisi")).toBe("GE");
    expect(placeName("GE")).toBe("Georgia");
  });
});

describe("isPlaceCode, isCountryCode and placeName", () => {
  it("knows every country and region code, by name", () => {
    expect(isPlaceCode("PK")).toBe(true);
    expect(isPlaceCode("EU")).toBe(true);
    expect(isPlaceCode("XX")).toBe(false);
    expect(placeName("GB")).toBe("United Kingdom");
    expect(placeName("XX")).toBe("XX");
  });

  it("tells countries from regions, and clear regions from unclear ones", () => {
    expect(isCountryCode("PK")).toBe(true);
    expect(isCountryCode("EU")).toBe(false);
    expect(isCountryCode("WORLDWIDE")).toBe(false);
    expect(isCountryCode("XX")).toBe(false);
    expect(isUnclearRegion("EMEA")).toBe(true);
    expect(isUnclearRegion("EU")).toBe(false);
    expect(isUnclearRegion("PK")).toBe(false);
  });

  it("knows MENAP, which includes Pakistan, apart from MENA, whose countries are unclear", () => {
    expect(placeCode("MENAP")).toBe("MENAP");
    expect(placeContains("MENAP", "PK")).toBe(true);
    expect(placeContains("MENA", "PK")).toBe("unknown");
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
  });

  it("says unknown, not no, for a place or country the table does not know", () => {
    expect(placeContains("ATLANTIS", "PK")).toBe("unknown");
    expect(placeContains("unknown", "PK")).toBe("unknown");
    expect(placeContains("PK", "pk")).toBe("unknown");
  });

  it("takes a region in when it holds every member of it", () => {
    expect(placeContains("EU", "EU")).toBe(true);
    expect(placeContains("EEA", "EU")).toBe(true);
    expect(placeContains("EUROPE", "EU")).toBe(true);
    expect(placeContains("WORLDWIDE", "EU")).toBe(true);
    expect(placeContains("EU", "EUROPE")).toBe(false);
    expect(placeContains("PK", "SOUTH_ASIA")).toBe(false);
    expect(placeContains("EMEA", "EU")).toBe("unknown");
    expect(placeContains("EU", "EMEA")).toBe("unknown");
  });
});
