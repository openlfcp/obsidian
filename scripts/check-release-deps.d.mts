// Types of scripts/check-release-deps.mjs for the tests.

export function releaseDepsProblems(input: {
  pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    pnpm?: { overrides?: Record<string, string> };
  };
  sdkLock: boolean;
}): string[];
