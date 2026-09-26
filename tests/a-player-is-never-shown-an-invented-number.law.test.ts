/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A PLAYER IS NEVER SHOWN AN INVENTED NUMBER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Audit 2026-09-08, finding CL-1, the worst item in it: the "Detailed
 * Analytics" panel a player opens at the table (SessionAnalytics, mounted by
 * TableModalsLayer) showed FIVE separate invented figures as that player's own
 * session record - per-position hands and win rates from Math.random(),
 * per-position net chips from (random - 0.45) x P&L / 7, action frequencies
 * that were pure random, and five "biggest pots" rolled from 500 + random x
 * 3000 with won/lost decided by coin flip. CL-38 found a second generator,
 * SessionReplay.generateMockActions, one import away from showing invented
 * hand history as a real replay.
 *
 * Dan's standing rule (CLAUDE.md 10.11 / 10.12): a defect is fixed at its
 * root and stopped from happening again. The root here is a render surface
 * that manufactures data, so the law is about render surfaces:
 *
 *   1. A file under src/components or src/pages may call Math.random() ONLY
 *      if it is listed below with the non-data reason for it (animation
 *      geometry, a client-side identifier, retry jitter, or a user-requested
 *      random pick). A number a player READS may not come from it. Anything
 *      not listed fails here; add it to the list only with a reason that is
 *      one of those four, in the same commit, and say so in the PR.
 *   2. The allowlist has no ghosts: a listed file must exist and must still
 *      call Math.random(), so the list stays a true inventory.
 *   3. No render surface carries a sample-data generator or a mock/sample/
 *      fake/dummy data constant. A component that has no real data renders
 *      an honest empty or unavailable state, never a plausible one.
 *   4. SessionAnalytics stays fed by SessionStatsService alone, and
 *      SessionReplay (the second generator) stays deleted.
 *
 * IF THIS FILE GOES RED, YOUR CHANGE IS THE BUG. Do not widen the patterns,
 * do not add a category to the allowlist that lets a displayed value through.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SURFACES = ['src/components', 'src/pages'];

type Reason = 'animation' | 'identifier' | 'jitter' | 'user-requested-pick';

/** Every file under a render surface that may call Math.random(), and why. */
const ALLOWED: Record<string, Reason> = {
  'src/components/agent/AgentPromoPanel.tsx': 'identifier', // uuid v4 fallback for an idempotency key
  'src/components/common/MilestoneToast.tsx': 'identifier', // toast instance id
  'src/components/customization/AvatarCustomizer.tsx': 'identifier', // mutation instance id
  'src/components/customization/AvatarGallery.tsx': 'identifier', // mutation instance id
  'src/components/crash/CrashCurve.tsx': 'animation', // wake particle scatter behind the jet; the multiplier and the crash point come from the server
  'src/components/effects/ConfettiEffect.tsx': 'animation',
  'src/components/effects/DiamondRainEffect.tsx': 'animation',
  'src/components/gamification/ConfettiEffect.tsx': 'animation',
  'src/components/gamification/LuckyDrawWheel.tsx': 'animation', // spin count only; the winner comes from the server
  'src/components/home/FloatingOrbs.tsx': 'animation',
  'src/components/modals/CompleteProfileModal.tsx': 'user-requested-pick', // suggested display name the player may keep or change
  'src/components/table/BBJCelebration.tsx': 'animation',
  'src/components/table/ChipAnimation.tsx': 'animation',
  'src/components/table/ConfettiCanvas.tsx': 'animation',
  'src/components/table/ParticleSystem.tsx': 'animation',
  'src/components/table/ThemeSettingsModal.tsx': 'user-requested-pick', // "randomize my look" among assets the player owns
  'src/components/table/ThrowAnimation.tsx': 'animation',
  'src/components/table/TournamentWinnerOverlay.tsx': 'animation',
  'src/components/tournament/CoinShower.tsx': 'animation',
  'src/components/wallet/WalletCashierModal.tsx': 'identifier', // uuid v4 fallback for an idempotency key
  'src/pages/CashierPage.tsx': 'identifier', // uuid v4 fallback for an idempotency key
  'src/pages/CashierTradePage.tsx': 'identifier', // uuid v4 fallback for an idempotency key
  'src/pages/MemberManagementPage.tsx': 'identifier', // request key fallback
  'src/pages/TablePage.tsx': 'jitter', // reconnect jitter and a uuid v4 fallback
  'src/pages/tournament/TournamentDetails.tsx': 'identifier', // request key
};

/**
 * Names that only ever exist to manufacture data for a screen. Matched on
 * code with comments stripped, so a comment explaining why one was removed
 * is fine. "sampleHands" and the like are NOT matched: a sample SIZE is a real
 * statistic (statsIntelligenceBrief counts the hands behind a read).
 */
const GENERATOR_RE =
  /\b(?:generate(?:Mock|Fake|Sample|Dummy|Placeholder)\w*|(?:mock|fake|dummy|placeholder)(?:Data|Stats|Actions|Hands|Players|Pots|Session|History|Results)\w*|sampleData\w*|(?:MOCK|FAKE|SAMPLE|DUMMY)_[A-Z0-9_]+)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isSource(file: string): boolean {
  return (
    /\.(tsx?|jsx?)$/.test(file) &&
    !/\.(test|spec)\.[tj]sx?$/.test(file) &&
    !/__tests__|__mocks__|__fixtures__|\.stories\./.test(file)
  );
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const surfaceFiles = SURFACES.flatMap((s) => walk(join(ROOT, s)))
  .filter(isSource)
  .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  .sort();

const usesRandom = (rel: string) =>
  /Math\.random\(/.test(stripComments(readFileSync(join(ROOT, rel), 'utf8')));

describe('a player is never shown an invented number', () => {
  it('no render surface calls Math.random() unless listed with a non-data reason', () => {
    const offenders = surfaceFiles.filter((f) => !(f in ALLOWED) && usesRandom(f));
    expect(
      offenders,
      `These files under src/components or src/pages call Math.random() and are not on ` +
        `the allowlist in ${relative(ROOT, __filename)}. A value a player reads must come ` +
        `from a record (the engine, Postgres, SessionStatsService). If the call is for ` +
        `animation geometry, a client-side identifier, retry jitter or a pick the player ` +
        `asked for, add the file to ALLOWED with that reason in the same commit.`
    ).toEqual([]);
  });

  it('the allowlist is a true inventory: every listed file exists and still uses Math.random()', () => {
    const ghosts = Object.keys(ALLOWED).filter((f) => !existsSync(join(ROOT, f)));
    expect(ghosts, 'listed files that no longer exist: remove them from ALLOWED').toEqual([]);
    const stale = Object.keys(ALLOWED).filter((f) => existsSync(join(ROOT, f)) && !usesRandom(f));
    expect(
      stale,
      'listed files that no longer call Math.random(): remove them from ALLOWED'
    ).toEqual([]);
  });

  it('every allowlist reason is one of the four non-data reasons', () => {
    const valid: Reason[] = ['animation', 'identifier', 'jitter', 'user-requested-pick'];
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(valid, `${file}: "${reason}" is not a non-data reason`).toContain(reason);
    }
  });

  it('no render surface carries a sample-data generator or a mock data constant', () => {
    const offenders: string[] = [];
    for (const f of surfaceFiles) {
      const code = stripComments(readFileSync(join(ROOT, f), 'utf8'));
      const m = GENERATOR_RE.exec(code);
      if (m) offenders.push(`${f}: ${m[0]}`);
    }
    expect(
      offenders,
      `A component with no real data renders an honest empty or unavailable state. It ` +
        `never manufactures a plausible one.`
    ).toEqual([]);
  });

  it('SessionAnalytics is fed by SessionStatsService alone', () => {
    const file = 'src/components/table/SessionAnalytics.tsx';
    const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    expect(code).toContain("from '../../services/SessionStatsService'");
    expect(code).not.toMatch(/Math\.random\(/);
    expect(code).not.toMatch(/Date\.now\(\)/);
    // The three invented tabs do not come back under their old names.
    expect(code).not.toMatch(/positionStats|actionFreqs|bigPots/);
    // It is still mounted where the player reaches it.
    const layer = readFileSync(join(ROOT, 'src/components/table/TableModalsLayer.tsx'), 'utf8');
    expect(layer).toContain('<SessionAnalytics');
  });

  it('the SessionReplay mock-action generator stays deleted', () => {
    expect(existsSync(join(ROOT, 'src/components/replay/SessionReplay.tsx'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/components/replay/SessionReplay.css'))).toBe(false);
  });
});
