import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { resolveSentryUpload } from '../../scripts/sentry-upload-policy';

const mocks = vi.hoisted(() => ({
  sentry: vi.fn((_options: unknown) => ({ name: 'observed-sentry-upload' })),
}));
vi.mock('@sentry/vite-plugin', () => ({ sentryVitePlugin: mocks.sentry }));
const originalDirectory = process.cwd();
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directories: string[] = [];
let fixture: string;
let head: string;

function git(args: string[], cwd = fixture): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
function temporary(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'ca-sentry-upload-'));
  directories.push(directory);
  return directory;
}
function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    CA_SENTRY_UPLOAD: '1',
    VITE_APP_VERSION: head,
    SENTRY_AUTH_TOKEN: 'synthetic-test-token',
    VITE_NATIVE: undefined,
    ...overrides,
  };
}
async function loadConfig(env = environment()) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  process.chdir(fixture);
  vi.resetModules();
  return (await import('../../vite.config')).default;
}

beforeEach(() => {
  fixture = temporary();
  git(['init', '-b', 'main']);
  writeFileSync(path.join(fixture, '.gitignore'), 'dist/\ndist-native/\n.entry-modules.json\n');
  writeFileSync(path.join(fixture, 'source.js'), 'export const version = 1;\n');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Source Map Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'source',
  ]);
  head = git(['rev-parse', 'HEAD']);
  mocks.sentry.mockClear();
});
afterEach(() => {
  process.chdir(originalDirectory);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Source map upload identity', () => {
  it('reproduces the old local token activation and keeps the actual Vite plugin disabled without opt-in', async () => {
    writeFileSync(path.join(fixture, 'source.js'), 'export const version = "dirty";\n');
    const env = environment({ CA_SENTRY_UPLOAD: undefined });
    expect(!!(env.NODE_ENV === 'production' && env.SENTRY_AUTH_TOKEN)).toBe(true);
    expect(resolveSentryUpload(env, fixture)).toEqual({
      enabled: false,
      reason: 'explicit-release-upload-not-enabled',
    });
    await loadConfig(env);
    expect(mocks.sentry).not.toHaveBeenCalled();
  });

  it('uses the actual publisher target for the clean web release and preserves upload behavior', async () => {
    const workflow = parse(
      readFileSync(path.join(repository, '.github/workflows/publish-club-arena.yml'), 'utf8')
    );
    const job = workflow.jobs['build-and-store'];
    const build = job.steps.find((step: { name?: string }) => step.name === 'Build Club Arena');
    const checkout = job.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/checkout@')
    );
    expect(build.env.CA_SENTRY_UPLOAD).toBe('1');
    expect(build.env.VITE_APP_VERSION).toBe(checkout.with.ref);
    expect(checkout.with['fetch-depth']).toBe(0);
    expect(build.env.VITE_APP_VERSION).toBe('${{ needs.publish-needed.outputs.target_sha }}');
    const resolution = workflow.jobs['publish-needed'].steps.find(
      (step: { id?: string }) => step.id === 'target'
    );
    expect(resolution.run).toContain('--jq .sha');
    await loadConfig(
      environment({ NODE_ENV: build.env.NODE_ENV, CA_SENTRY_UPLOAD: build.env.CA_SENTRY_UPLOAD })
    );
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
    const options = mocks.sentry.mock.calls[0][0] as unknown as {
      org: string;
      project: string;
      release: { name: string };
      sourcemaps: {
        assets: string;
        filesToDeleteAfterUpload: string[];
      };
      errorHandler: (error: Error) => void;
    };
    expect(options.release.name).toBe('club-arena@' + head);
    expect(options.org).toBe('smarter-software-inc');
    expect(options.project).toBe('javascript-react');
    expect(options.sourcemaps.assets).toBe('./dist/**');
    expect(options.sourcemaps.filesToDeleteAfterUpload).toEqual([
      './dist/**/*.js.map',
      './dist/**/*.css.map',
    ]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => options.errorHandler(new Error('Synthetic 403'))).not.toThrow();
    expect(warning).toHaveBeenCalledWith('[sentry-vite-plugin] Warning:', 'Synthetic 403');
  });

  it.each(['unstaged', 'staged', 'untracked'])(
    'refuses an explicitly requested upload with %s source changes',
    async (kind) => {
      writeFileSync(
        path.join(fixture, kind === 'untracked' ? 'new-source.js' : 'source.js'),
        'changed\n'
      );
      if (kind === 'staged') git(['add', 'source.js']);
      expect(resolveSentryUpload(environment(), fixture)).toEqual({
        enabled: false,
        reason: 'source-tree-is-dirty',
      });
      await loadConfig();
      expect(mocks.sentry).not.toHaveBeenCalled();
    }
  );

  it('allows naturally ignored generated build artifacts', () => {
    mkdirSync(path.join(fixture, 'dist'));
    writeFileSync(path.join(fixture, 'dist', 'bundle.js.map'), '{}');
    writeFileSync(path.join(fixture, '.entry-modules.json'), '{}');
    expect(resolveSentryUpload(environment(), fixture)).toEqual({
      enabled: true,
      release: 'club-arena@' + head,
      reason: 'verified-release',
    });
  });

  it('refuses stale web dist during an explicitly opted-in native build', async () => {
    mkdirSync(path.join(fixture, 'dist'));
    writeFileSync(path.join(fixture, 'dist', 'old-web.js.map'), '{}');
    const env = environment({ VITE_NATIVE: '1' });
    expect(resolveSentryUpload(env, fixture)).toEqual({
      enabled: false,
      reason: 'native-build-has-no-web-source-maps',
    });
    await loadConfig(env);
    expect(mocks.sentry).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '1.0.1', 'abcdef0'])(
    'does not substitute a package version for release identity %s',
    (version) => {
      expect(
        resolveSentryUpload(
          environment({ VITE_APP_VERSION: version, npm_package_version: '1.0.1' }),
          fixture
        ).enabled
      ).toBe(false);
    }
  );

  it('refuses a full SHA that does not identify the built checkout', async () => {
    const env = environment({ VITE_APP_VERSION: 'f'.repeat(40) });
    expect(resolveSentryUpload(env, fixture)).toEqual({
      enabled: false,
      reason: 'release-source-sha-mismatch',
    });
    await loadConfig(env);
    expect(mocks.sentry).not.toHaveBeenCalled();
  });

  it('refuses a real shallow checkout even if its HEAD matches', () => {
    const clone = temporary();
    git(['clone', '--depth=1', 'file://' + fixture, clone]);
    expect(git(['rev-parse', '--is-shallow-repository'], clone)).toBe('true');
    expect(resolveSentryUpload(environment(), clone)).toEqual({
      enabled: false,
      reason: 'complete-source-history-required',
    });
  });

  it('fails closed when Git cannot verify the source', () => {
    expect(resolveSentryUpload(environment(), path.join(fixture, 'missing'))).toEqual({
      enabled: false,
      reason: 'source-identity-could-not-be-verified',
    });
  });

  it.each([
    [{ NODE_ENV: 'development' }, 'not-a-production-build'],
    [{ SENTRY_AUTH_TOKEN: undefined }, 'upload-authentication-unavailable'],
    [{ CA_SENTRY_UPLOAD: 'true' }, 'explicit-release-upload-not-enabled'],
  ])('keeps the plugin disabled for %o', (override, reason) => {
    expect(resolveSentryUpload(environment(override), fixture)).toEqual({ enabled: false, reason });
  });
});
