/**
 * LAW: every operator CLI under server/scripts is type-checked by CI.
 *
 * server/tsconfig.json has rootDir src, so server/scripts/*.ts were compiled
 * by nothing: the Hold'em live measure CLI (2026-10-30) shipped type-checked
 * by hand, like the five scripts before it. server/tsconfig.scripts.json now
 * covers them and the Server Engine job runs it. The qualification vitest
 * files under scripts/qualification are excluded by name with their baseline
 * recorded in the config; nothing else may be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const config = JSON.parse(readFileSync(join(ROOT, 'server', 'tsconfig.scripts.json'), 'utf8'));
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('server scripts are type-checked', () => {
  it('covers scripts/**/*.ts with only the recorded qualification baseline excluded', () => {
    expect(config.extends).toBe('./tsconfig.json');
    expect(config.compilerOptions.noEmit).toBe(true);
    expect(config.compilerOptions.rootDir).toBe('.');
    expect(config.include).toContain('scripts/**/*.ts');
    expect(config.exclude).toEqual(['node_modules', 'dist', 'scripts/qualification/**']);
    expect(String(config['// why'])).toMatch(/pre-existing/);
  });

  it('is run by the Server Engine job right after the server compile', () => {
    const at = ci.indexOf('- name: TypeScript Check (server)\n        run: npx tsc --noEmit\n');
    expect(at).toBeGreaterThan(0);
    const next = ci.indexOf('- name: TypeScript Check (server scripts)', at);
    expect(next).toBeGreaterThan(at);
    // The step itself: from its name to the next step.
    const step = sliceBetween(ci.slice(next), '- name: TypeScript Check (server scripts)', '\n      - name: ');
    expect(step).toContain('run: npx tsc -p tsconfig.scripts.json --noEmit');
    // Inside the same job: no other job heading between the two steps.
    expect(ci.slice(at, next)).not.toMatch(/\n  [a-z_]+:\n/);
  });
});
