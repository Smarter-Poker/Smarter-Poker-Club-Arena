/**
 * THE LIVE CERTIFICATE MUST NOT BE ABLE TO REPORT NOTHING.
 *
 * tests/e2e/production-table-management.spec.ts is the only layer that sees
 * the real Table Management surfaces on the real site. On the 2026-09-29
 * deploy it reported nothing at all and the publish still looked certified:
 *
 *   - it aimed every test at E2E_CLUB_ID, which belongs to a union, so the
 *     board can never render there; and
 *   - it turned that refusal into `test.skip`, so four of five tests said
 *     nothing and the run's anti-skip guard (which only asks for one executed
 *     test per file) was satisfied by the one that remained.
 *
 * A certificate that can silently certify nothing is worse than no
 * certificate, because it is trusted. These are the three properties that
 * stop it happening again, checked against the spec's own source so a merge
 * cannot quietly undo them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SPEC = resolve(__dirname, '../e2e/production-table-management.spec.ts');
const source = readFileSync(SPEC, 'utf8');

describe('the live Table Management certificate cannot go blind', () => {
  it('certifies the board on the standalone reserved club, not the union member one', () => {
    // The board scope is the template (standalone) club...
    expect(source).toMatch(/const STANDALONE_CLUB =[\s\S]*?E2E_TEMPLATE_CLUB_ID/);
    expect(source).toMatch(/const BOARD = `clubs\/\$\{STANDALONE_CLUB\}\/table-management`/);
    // ...and E2E_CLUB_ID is used only for the refusal certificate.
    expect(source).toMatch(/const UNION_MEMBER_CLUB =[\s\S]*?E2E_CLUB_ID/);
    expect(source).toMatch(/clubs\/\$\{UNION_MEMBER_CLUB\}\/table-management/);
  });

  it('skips only for being signed out, never for a refusal', () => {
    const skips = source.match(/test\.skip\(/g) ?? [];
    expect(
      skips.length,
      'every skip in this spec must be the signed-out one; a refusal is a verdict, not an absence'
    ).toBe(1);
    expect(source).toMatch(/test\.skip\([\s\S]*?signed out/);
    // The old shape: a refusal probe wired straight into a skip.
    expect(source).not.toMatch(/test\.skip\(\s*await\s+refused/);
  });

  it('waits on the page reaching an outcome, not on a clock', () => {
    // The 2026-09-29 failure: sleep 1200ms, then wait for the access-check
    // copy to DETACH - already true on a cold load, so the probe read an
    // empty page.
    expect(source).not.toMatch(/waitForTimeout\(1200\)/);
    expect(source).not.toMatch(/state: 'detached'/);
    // Every board assertion goes through the guard that makes drift fatal.
    const boardPaths = source.match(/mustSeeBoard\(/g) ?? [];
    expect(boardPaths.length).toBeGreaterThanOrEqual(5);
    expect(source).toMatch(/function mustSeeBoard\([\s\S]*?\.toBe\('board'\)/);
  });

  it('gives the nine-surface phone sweep an explicit sequential budget', () => {
    expect(source).toContain('const MOBILE_SURFACE_COUNT = 9');
    expect(source).toContain(
      'MOBILE_SURFACE_COUNT * (ROUTE_NAVIGATION_TIMEOUT_MS + ROUTE_OUTCOME_TIMEOUT_MS) + 15_000'
    );
    expect(source).toMatch(
      /no surface scrolls sideways[\s\S]*?setTimeout\(MOBILE_SWEEP_TIMEOUT_MS\)/
    );
  });
});
