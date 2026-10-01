/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE MULTI-TABLE WALK PLAYS ONLY WHERE NOTHING IS REAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decided by Claude on Dan's delegation of 2026-09-30 (docs/DIAMOND-RULINGS.md
 * Ruling 23). e2e-live/multitable-walk.mjs buys in at cash tables and plays.
 * It used to do that at the cheapest open table in Club JAQK, a real club,
 * as whatever account the operator supplied. It is retired from production
 * play: it starts only as a test identity (an address ending in .invalid) at a
 * club flagged as a test club (tagged `test-club`), and refuses before a
 * browser opens otherwise. Its sweeper, cleanup-seats.mjs, stands up only the
 * same test identity.
 *
 * Nothing here opens a browser or reaches production: the guards are exercised
 * with a fake fetch and temporary state files.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Refusal,
  isTestIdentity,
  requireTestClub,
  requireTestIdentity,
} from '../e2e-live/lib/test-only.mjs';

const ROOT = join(__dirname, '..');
const walk = readFileSync(join(ROOT, 'e2e-live', 'multitable-walk.mjs'), 'utf8');
const sweeper = readFileSync(join(ROOT, 'e2e-live', 'cleanup-seats.mjs'), 'utf8');
const readme = readFileSync(join(ROOT, 'e2e-live', 'README.md'), 'utf8');

function stateWith(email: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'walk-state-'));
  const file = join(dir, 'auth.json');
  const origins = email
    ? [
        {
          origin: 'https://smarter.poker',
          localStorage: [
            { name: 'smarter-poker-auth', value: JSON.stringify({ user: { email } }) },
          ],
        },
      ]
    : [];
  writeFileSync(file, JSON.stringify({ cookies: [], origins }));
  return file;
}

function clubFetch(row: Record<string, unknown> | null, status = 200) {
  return async () =>
    ({
      ok: status === 200,
      status,
      json: async () => (row ? [row] : []),
    }) as Response;
}

const TEST_CLUB = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Walk Test Club',
  slug: 'walk-test-club',
  tags: ['test-club'],
  asset: 'chips',
  lifecycle_status: 'active',
};

describe('LAW: the multi-table walk plays only where nothing is real', () => {
  it('a test identity is an address under the reserved .invalid domain, and nothing else', () => {
    expect(isTestIdentity('ca-customization-cert-postdeploy-1@example.invalid')).toBe(true);
    expect(isTestIdentity('club-create-cert-1@smarter-poker.invalid')).toBe(true);
    expect(isTestIdentity('daniel@smarter.poker')).toBe(false);
    expect(isTestIdentity('someone@example.com')).toBe(false);
    expect(isTestIdentity('invalid@smarter.poker')).toBe(false);
    expect(isTestIdentity('')).toBe(false);
    expect(isTestIdentity(undefined)).toBe(false);
  });

  it('refuses a real account, named or found in the saved browser state, and refuses to guess', () => {
    expect(() =>
      requireTestIdentity({ email: 'daniel@smarter.poker', authPath: stateWith(null) })
    ).toThrow(Refusal);
    expect(() =>
      requireTestIdentity({ email: '', authPath: stateWith('someone@smarter.poker') })
    ).toThrow(/not a test identity/);
    expect(() =>
      requireTestIdentity({ email: 'a@example.invalid', authPath: stateWith('b@example.invalid') })
    ).toThrow(/different accounts/);
    expect(() => requireTestIdentity({ email: '', authPath: stateWith(null) })).toThrow(
      /refusing to guess an account/
    );
    expect(requireTestIdentity({ email: 'a@example.invalid', authPath: stateWith(null) })).toBe(
      'a@example.invalid'
    );
    expect(requireTestIdentity({ email: '', authPath: stateWith('a@example.invalid') })).toBe(
      'a@example.invalid'
    );
  });

  it('plays only a club flagged as a test club, never a real estate, a Diamond club or a retired one', async () => {
    const ask = (row: Record<string, unknown> | null, club = 'walk-test-club', status = 200) =>
      requireTestClub({
        club,
        anonKey: 'anon',
        supabaseUrl: 'https://x',
        fetchImpl: clubFetch(row, status),
      });
    await expect(ask(TEST_CLUB)).resolves.toMatchObject({ id: TEST_CLUB.id });
    await expect(ask({ ...TEST_CLUB, tags: [] })).rejects.toThrow(/not flagged as a test club/);
    await expect(ask({ ...TEST_CLUB, tags: null })).rejects.toThrow(/not flagged as a test club/);
    await expect(
      ask({ ...TEST_CLUB, id: 'a0000000-0000-0000-0000-000000000001', name: 'Club JAQK' })
    ).rejects.toThrow(/is a real club/);
    await expect(
      ask({ ...TEST_CLUB, id: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4', name: 'SHARK CLUB' })
    ).rejects.toThrow(/is a real club/);
    await expect(ask({ ...TEST_CLUB, asset: 'diamonds' })).rejects.toThrow(/chip tables only/);
    await expect(ask({ ...TEST_CLUB, lifecycle_status: 'retired' })).rejects.toThrow(/retired/);
    await expect(ask(null)).rejects.toThrow(/no single club/);
    await expect(ask(TEST_CLUB, 'walk-test-club', 500)).rejects.toThrow(/could not be read/);
    await expect(ask(TEST_CLUB, '')).rejects.toThrow(/no test club is named/);
    await expect(
      requireTestClub({ club: 'walk-test-club', anonKey: '', fetchImpl: clubFetch(TEST_CLUB) })
    ).rejects.toThrow(/cannot be checked/);
  });

  it('the walk checks both before a browser opens, checks the page before a seat, and names no real club', () => {
    const launch = walk.indexOf('chromium.launch(');
    expect(walk.indexOf('requireTestIdentity({ authPath: AUTH })')).toBeGreaterThan(-1);
    expect(walk.indexOf('requireTestIdentity({ authPath: AUTH })')).toBeLessThan(launch);
    expect(walk.indexOf('await requireTestClub()')).toBeLessThan(launch);
    expect(walk).toMatch(
      /if \(e instanceof Refusal\) \{ console\.log\(`REFUSED: \$\{e\.message\}`\); process\.exit\(2\); \}/
    );
    const pageCheck = walk.indexOf('await requirePageIdentity(page, IDENTITY);');
    expect(pageCheck).toBeGreaterThan(launch);
    expect(pageCheck).toBeLessThan(walk.indexOf('buy-in-modal__confirm'));
    expect(walk).not.toMatch(/CLUB JAQK|SHARK CLUB/i);
    expect(walk).toContain('/hub/club-arena/clubs/${CLUB.slug||CLUB.id}');
  });

  it('the sweeper stands up only the test identity', () => {
    const launch = sweeper.indexOf('chromium.launch(');
    expect(sweeper.indexOf('requireTestIdentity({ authPath: AUTH })')).toBeLessThan(launch);
    expect(sweeper.indexOf('await requirePageIdentity(page, IDENTITY);')).toBeLessThan(
      sweeper.indexOf('leaveAllSeats(page')
    );
  });

  it('the README says how to run it safely and that it never plays a real club', () => {
    expect(readme).toContain('E2E_TEST_CLUB');
    expect(readme).toContain('test-club');
    expect(readme).toContain('.invalid');
    expect(readme).toMatch(/refuses/i);
  });
});
