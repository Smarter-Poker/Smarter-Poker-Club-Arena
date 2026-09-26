/**
 * ===========================================================================
 *  LAW: A DELIBERATELY PUBLIC READER IS RECORDED WHERE EVERY AUDIT READS IT
 * ===========================================================================
 *
 * WHAT HAPPENED. Migration 20260919153418
 * (public_bonus_replay_has_an_explicitly_public_reader) made
 * fn_shared_bonus_replay executable by anon on purpose: it is the reader
 * behind the public bonus replay link. It wrote that decision down in two of
 * the places that audit the anonymous surface - `anonPublicSurface` in
 * scripts/ci/definer-authorization.allowlist.json (the repository gate) and
 * the live table ca_browser_definer_allowlist - and in neither of the two
 * that compare against production:
 *
 *   reviewedAnonReaders in scripts/ci/definer-exposure-baseline.json, read
 *     hourly by scripts/ci/audit-live-definer-exposure.mjs;
 *   docs/security/anon-executable-definers.json, read by
 *     scripts/ci/check-anon-definer-grants.mjs.
 *
 * So Schema Integrity Audit, job "No unaccounted DEFINER writer is reachable
 * from a browser", failed on every run from 2026-09-19 17:25 UTC with "A NEW
 * FUNCTION ANSWERS A CALLER WITH NO ACCOUNT" - an alarm about a decision that
 * had already been taken, which is the kind of alarm that teaches people to
 * stop reading it. Its issue said the same thing every hour for three days.
 *
 * THE RULE. The lists nest, by function name:
 *
 *   anonPublicSurface          the gate: a signed-out caller may run it
 *     inside reviewedAnonReaders   the live audit: it answers somebody with
 *                                  no account, on purpose, and only reads
 *     inside anon-executable-definers.json   the whole anonymous surface
 *
 * A writer can never be in the first list legitimately - the live audit's
 * anon_writers question has no allowlist at all - so everything the gate lets
 * a signed-out caller run is a reader the live audit must also expect. The
 * decision is written in all three in the same change, or the change fails
 * here instead of in production an hour after it merges.
 *
 * AND THE REASON STAYS TRUE. fn_shared_bonus_replay is baselined, not
 * revoked, because a signed-out page calls it. If that page ever moves behind
 * a login, the baseline is forgiving a grant nothing needs: the test below
 * fails, and the answer is to revoke EXECUTE FROM PUBLIC, anon - not to edit
 * the test.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));

const GATE = json('scripts/ci/definer-authorization.allowlist.json');
const LIVE = json('scripts/ci/definer-exposure-baseline.json');
const SURFACE = json('docs/security/anon-executable-definers.json');

const gatePublic = Object.keys(GATE.anonPublicSurface ?? {});
const liveReaders = Object.keys(LIVE.reviewedAnonReaders ?? {});
/** The manifest lists signatures; the other two list names. Compare names. */
const surfaceNames = new Set(
  (SURFACE.allowed as Array<{ fn: string }>).map((e) => e.fn.slice(0, e.fn.indexOf('(')))
);

/** Comments out, strings kept: the assertions below are about routes and RPC
 *  names, which live in string literals. `https://` is not a comment. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('a deliberately public reader is recorded where every audit reads it', () => {
  it('the gate list is not empty, so the nesting below is measuring something', () => {
    expect(gatePublic.length).toBeGreaterThan(0);
    expect(liveReaders.length).toBeGreaterThan(0);
    expect(surfaceNames.size).toBeGreaterThan(0);
  });

  it('every function the gate lets a signed-out caller run is expected by the live audit', () => {
    const missing = gatePublic.filter((name) => !liveReaders.includes(name));
    expect(
      missing,
      'these are in anonPublicSurface (scripts/ci/definer-authorization.allowlist.json) but not ' +
        'in reviewedAnonReaders (scripts/ci/definer-exposure-baseline.json), so the hourly live ' +
        'audit will fail on a decision that was already made. Record it in both, saying what a ' +
        'caller with no account can learn from it.'
    ).toEqual([]);
  });

  it('every function the live audit accepts as anon-readable is on the anonymous-surface manifest', () => {
    const missing = liveReaders.filter((name) => !surfaceNames.has(name));
    expect(
      missing,
      'these are baselined as anon-readable but absent from docs/security/anon-executable-definers.json, ' +
        'so check-anon-definer-grants.mjs reports them as unaccounted'
    ).toEqual([]);
  });

  it('fn_shared_bonus_replay is in all three, and its reason names the signed-out caller', () => {
    expect(gatePublic).toContain('fn_shared_bonus_replay');
    expect(liveReaders).toContain('fn_shared_bonus_replay');
    expect(
      (SURFACE.allowed as Array<{ fn: string; reason: string }>).find(
        (e) => e.fn === 'fn_shared_bonus_replay(p_share_id uuid)'
      )?.reason
    ).toBe('public-read');

    const why = LIVE.reviewedAnonReaders.fn_shared_bonus_replay as string;
    expect(why.length).toBeGreaterThan(150);
    expect(why).toContain('MUST answer before login');
    expect(why).toContain('src/pages/share/SharedBonusReplayPage.tsx');
    expect(why).toContain('src/services/DiamondReplayService.ts');
    // What a caller with no account can learn, stated, not implied.
    expect(why).toContain('no user id, club id, bonus id, wallet balance or seed');
  });
});

describe('and the reason it is baselined rather than revoked stays true', () => {
  const APP = read('src/App.tsx');
  const PAGE = code(read('src/pages/share/SharedBonusReplayPage.tsx'));
  const SERVICE = code(read('src/services/DiamondReplayService.ts'));

  it('the share page is routed with the public routes, outside every auth guard', () => {
    // Bounded by the app's own two banners, so the window is the structure
    // it names and grows with it.
    const publicRoutes = code(
      sliceBetween(APP, 'PUBLIC ROUTES (No Auth Required)', 'PROTECTED ROUTES (Auth Required)')
    );
    expect(publicRoutes).toMatch(
      /<Route\s+path="\/bonus-replay\/:shareId"\s+element=\{\s*<SharedBonusReplayPage\s*\/>\s*\}\s*\/>/
    );
    // It is not also routed somewhere a login is required.
    const everywhere = code(APP).match(/path="\/bonus-replay\/:shareId"/g) ?? [];
    expect(everywhere).toHaveLength(1);
  });

  it('the page reads the shared replay, and the shared read is this function', () => {
    expect(PAGE).toMatch(/DiamondReplayService\.read\(\s*shareId[^,]*,\s*true\s*\)/);
    expect(SERVICE).toMatch(/shared\s*\?\s*'fn_shared_bonus_replay'/);
  });
});
