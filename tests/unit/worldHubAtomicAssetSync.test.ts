import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const syncScript = join(
  repositoryRoot,
  'scripts/sync-club-arena-dist-retaining-previous-assets.sh'
);
const workflowPath = join(repositoryRoot, '.github/workflows/build-for-world-hub.yml');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'club-arena-asset-sync-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root: string, relativePath: string, value: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function read(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('atomic World Hub asset synchronization', () => {
  it('publishes current output, retains one manifested generation, and prunes older files', () => {
    const fixture = temporaryDirectory();
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');

    write(source, 'index.html', 'new shell');
    write(source, 'assets/new/current.js', 'new current');
    write(source, 'assets/shared.js', 'new shared');
    write(source, 'deploy-asset-manifest.txt', 'new/current.js\nshared.js\n');

    write(target, 'index.html', 'old shell');
    write(target, 'assets/old/only.js', 'old only');
    write(target, 'assets/shared.js', 'old shared');
    write(target, 'assets/ancient.js', 'ancient');
    write(target, 'deploy-asset-manifest.txt', 'old/only.js\nshared.js\n');

    execFileSync('bash', [syncScript, source, target]);

    expect(read(target, 'index.html')).toBe('new shell');
    expect(read(target, 'assets/new/current.js')).toBe('new current');
    expect(read(target, 'assets/shared.js')).toBe('new shared');
    expect(read(target, 'assets/old/only.js')).toBe('old only');
    expect(() => read(target, 'assets/ancient.js')).toThrow();
    expect(read(target, 'deploy-asset-manifest.txt')).toBe('new/current.js\nshared.js\n');
  });

  it('bootstraps the immediately deployed generation when no prior manifest exists', () => {
    const fixture = temporaryDirectory();
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');

    write(source, 'index.html', 'new shell');
    write(source, 'assets/new.js', 'new asset');
    write(source, 'deploy-asset-manifest.txt', 'new.js\n');
    write(target, 'index.html', 'old shell');
    write(target, 'obsolete.html', 'delete me');
    write(target, 'assets/old.js', 'old asset');

    execFileSync('bash', [syncScript, source, target]);

    expect(read(target, 'assets/new.js')).toBe('new asset');
    expect(read(target, 'assets/old.js')).toBe('old asset');
    expect(() => read(target, 'obsolete.html')).toThrow();
  });

  it('does not rotate away retained assets when the same build is republished', () => {
    const fixture = temporaryDirectory();
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');

    write(source, 'index.html', 'rebuilt shell');
    write(source, 'assets/current.js', 'current asset');
    write(source, 'deploy-asset-manifest.txt', 'current.js\n');
    write(target, 'index.html', 'deployed shell');
    write(target, 'assets/current.js', 'current asset');
    write(target, 'assets/previous.js', 'previous asset');
    write(target, 'deploy-asset-manifest.txt', 'current.js\n');

    execFileSync('bash', [syncScript, source, target]);

    expect(read(target, 'index.html')).toBe('rebuilt shell');
    expect(read(target, 'assets/current.js')).toBe('current asset');
    expect(read(target, 'assets/previous.js')).toBe('previous asset');
  });

  it('rejects a traversal path before changing the deployed tree', () => {
    const fixture = temporaryDirectory();
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');

    write(source, 'index.html', 'new shell');
    write(source, 'deploy-asset-manifest.txt', 'new.js\n');
    write(target, 'index.html', 'old shell');
    write(target, 'deploy-asset-manifest.txt', '../outside.js\n');

    expect(() => execFileSync('bash', [syncScript, source, target])).toThrow();
    expect(read(target, 'index.html')).toBe('old shell');
  });

  it('wires the bounded sync exactly once after provenance has been checked', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const scriptCalls = workflow.match(
      /bash \.\.\/club-arena-source\/scripts\/sync-club-arena-dist-retaining-previous-assets\.sh/g
    );

    expect(workflow).toContain('dist/deploy-asset-manifest.txt');
    expect(workflow).toContain('- name: Checkout Club Arena publish support');
    expect(scriptCalls).toHaveLength(1);
    expect(workflow).not.toMatch(/^\s*rsync\s+.*--delete/m);
    expect(workflow).not.toContain('- name: Sync dist/ to World Hub');
  });
});
