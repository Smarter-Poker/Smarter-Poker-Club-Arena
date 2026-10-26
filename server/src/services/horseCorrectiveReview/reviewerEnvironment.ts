/** Explicit child environments prevent a purpose-only signing key or database
 * credential from leaking to local Git and configured GitHub metadata tools. */
const COMMON = ['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL'] as const;
const GITHUB = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;
export function correctiveReviewerChildEnvironment(
  kind: 'git' | 'github',
  environment: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of kind === 'github' ? [...COMMON, ...GITHUB] : COMMON) {
    const value = environment[name];
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}
