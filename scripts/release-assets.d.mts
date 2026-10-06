// Types of scripts/release-assets.mjs for the tests.

export function releaseProblems(files: {
  tag: string | null;
  manifest: { version?: string; minAppVersion?: string };
  pkg: { version?: string };
  versions: Record<string, string>;
}): string[];
