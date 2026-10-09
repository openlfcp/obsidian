// Types of scripts/release-assets.mjs for the tests.

export function releaseProblems(files: {
  tag: string | null;
  manifest: { version?: string; minAppVersion?: string };
  pkg: { version?: string };
  versions: Record<string, string>;
}): string[];

export const BETA_TAG: RegExp;

export function betaProblems(files: {
  tag: string | null;
  manifest: Record<string, unknown> & { version?: string };
  beta: (Record<string, unknown> & { version?: string }) | null;
}): string[];
