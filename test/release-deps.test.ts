// A tag release is built from npm only (release.yml): the development pin
// of the SDK (sdk-ts.lock, link: dependencies) refuses it.

import { describe, expect, it } from "vitest";
import { releaseDepsProblems } from "../scripts/check-release-deps.mjs";

const npm = {
  dependencies: { "@openlfcp/core": "0.2.0", "@openlfcp/client": "0.2.0-beta.1", other: "^1.0.0" },
};

describe("release dependencies", () => {
  it("accept exact npm versions of the SDK", () => {
    expect(releaseDepsProblems({ pkg: npm, sdkLock: false })).toEqual([]);
  });

  it("refuse the development pin: sdk-ts.lock, link: or a range", () => {
    expect(
      releaseDepsProblems({
        pkg: {
          dependencies: {
            "@openlfcp/core": "link:../sdk-ts/packages/core",
            "@openlfcp/wire": "^0.2.0",
          },
        },
        sdkLock: true,
      }),
    ).toEqual([
      "sdk-ts.lock is present: the SDK is pinned to a commit, not npm",
      '@openlfcp/core is "link:../sdk-ts/packages/core", not an exact npm version',
      '@openlfcp/wire is "^0.2.0", not an exact npm version',
    ]);
  });
});
