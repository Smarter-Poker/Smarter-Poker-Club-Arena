import { execFileSync } from 'node:child_process';

export type SentryUploadDecision =
  | { enabled: true; release: string; reason: 'verified-release' }
  | { enabled: false; reason: string };

/**
 * A token configures authentication, not permission for every local build to
 * upload. Check the exact source tree before the Sentry plugin is instantiated.
 * No network calls, credential reads from disk, or Git mutations occur here.
 */
export function resolveSentryUpload(
  env: Record<string, string | undefined>,
  cwd = process.cwd()
): SentryUploadDecision {
  const disabled = (reason: string): SentryUploadDecision => ({ enabled: false, reason });
  if (env.CA_SENTRY_UPLOAD !== '1') return disabled('explicit-release-upload-not-enabled');
  if (env.NODE_ENV !== 'production') return disabled('not-a-production-build');
  // Native builds emit dist-native without maps. Never upload stale ./dist
  // left by a previous web build, even with an explicit upload opt-in.
  if (env.VITE_NATIVE === '1') return disabled('native-build-has-no-web-source-maps');
  if (!env.SENTRY_AUTH_TOKEN) return disabled('upload-authentication-unavailable');
  const version = env.VITE_APP_VERSION;
  if (!version || !/^[0-9a-f]{40}$/.test(version))
    return disabled('full-release-source-sha-required');
  try {
    // Git hooks export repository-local state that overrides cwd. Follow Git's
    // documented foreign-worktree boundary so identity belongs to this build.
    const gitEnv = { ...process.env };
    const localNames = execFileSync('git', ['rev-parse', '--local-env-vars'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/);
    for (const name of localNames) delete gitEnv[name];
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
      return disabled('complete-source-history-required');
    }
    if (git(['rev-parse', 'HEAD']) !== version) return disabled('release-source-sha-mismatch');
    if (git(['status', '--porcelain', '--untracked-files=normal']) !== '') {
      return disabled('source-tree-is-dirty');
    }
  } catch {
    return disabled('source-identity-could-not-be-verified');
  }
  return { enabled: true, release: 'club-arena@' + version, reason: 'verified-release' };
}
