import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const out = mkdtempSync(join(tmpdir(), 'throwable-preview-test-'));
const script = resolve('scripts/dev/preview-throwable.mjs');
function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15000 });
}
afterAll(() => rmSync(out, { recursive: true, force: true }));
describe('throwable darkroom commands', () => {
  it('accepts space-separated selection and produces unique SVG IDs', () => {
    const result = run('--only', 'beer,trophy', out, '--html-only');
    expect(result.status, result.stderr).toBe(0);
    const html = readFileSync(join(out, 'harness.html'), 'utf8');
    expect(html).toContain('data-id="beer"');
    expect(html).toContain('data-id="trophy"');
    expect(html).not.toContain('data-id="rocket"');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    const cuts = html
      .split('<div class="cell"')
      .slice(1)
      .filter((c) => c.includes('<em>cut</em>'));
    expect(cuts.length).toBe(2);
    for (const cut of cuts) expect(cut).not.toContain('<svg');
  });
  it('supports the documented items alias', () => {
    const result = run(out, '--items=rocket', '--html-only');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rigs:    rocket');
  });
  it('keeps the cash bundle visible before its fade and holds bills until the burst', () => {
    const result = run(out, '--items=cash_stack', '--html-only');
    expect(result.status, result.stderr).toBe(0);
    const html = readFileSync(join(out, 'harness.html'), 'utf8');
    const fadeRule = html.match(/\.thr-cash_stack__bundle-fade\s*\{([^}]+)\}/)?.[1];
    expect(fadeRule).toMatch(/opacity:\s*1\s*;/);
    const delays = [
      ...html.matchAll(
        /class="thr-cash_stack__bill" style="animation-delay:calc\((\d+(?:\.\d+)?)s/g
      ),
    ].map((m) => Number(m[1]) * 1000);
    expect(delays.length).toBeGreaterThan(0);
    // Landing is 333 ms, burst is 700 ms from launch. A bill before
    // +367 ms steals the settle beat and used to mask the invisible bundle.
    expect(Math.min(...delays)).toBe(367);
    expect(Math.max(...delays)).toBeLessThan(2700);
  });
  it('rejects mixed known and unknown IDs', () => {
    const result = run(out, '--items=beer,does_not_exist', '--html-only');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown rig(s): does_not_exist');
  });
  it('fails required screenshots when the browser cannot launch', () => {
    const result = run(out, '--items=beer', '--shots', '--executable-path=/does/not/exist');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Screenshot capture failed');
  });
});
