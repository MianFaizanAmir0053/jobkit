import { afterEach, describe, expect, it } from "vitest";

import { SHARE_TARGET_ON, setShareTargetForTests, shareTargetOn } from "./shareTarget";

/* The share target's switch (intake spec, "Share-target switch"). */

afterEach(() => {
  setShareTargetForTests(undefined);
});

describe("shareTargetOn", () => {
  it("follows the switch the phone's test set, unless the test server sets it", () => {
    expect(shareTargetOn()).toBe(SHARE_TARGET_ON);

    setShareTargetForTests(!SHARE_TARGET_ON);
    expect(shareTargetOn()).toBe(!SHARE_TARGET_ON);

    setShareTargetForTests(undefined);
    expect(shareTargetOn()).toBe(SHARE_TARGET_ON);
  });
});
