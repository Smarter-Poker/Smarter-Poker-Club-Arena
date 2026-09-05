/**
 * LAW: NO USE-BEFORE-DECLARE ON THE TABLE ROUTE (2026-09-05, P0)
 *
 * The second sweep (#3089) made `anyTurnLive` in MultiTablePage read
 * `parseTimed(t.decision)`, and `parseTimed` was a `const` declared further
 * down the component body. That read runs synchronously during render, before
 * the declaration is reached, so EVERY table opened on the published build
 * threw "Cannot access 'parseTimed' before initialization" into the error
 * boundary. tsc does not flag a use-before-declare inside a nested callback,
 * no unit test renders the container, and it reached production.
 *
 * ESLint's `no-use-before-define` catches the shape. It cannot tell a read
 * that happens during render (a crash) from one inside a callback that runs
 * later (fine), so this is a RATCHET: every existing occurrence on the three
 * table-route files is listed below as an allowed baseline, and a NEW name
 * fails. To add one you must have read the code and be sure the reference is
 * deferred - and the honest fix is usually to move a pure helper above the
 * component, where there is nothing to be before.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = resolve(__dirname, '..');
const FILES = [
  'src/pages/MultiTablePage.tsx',
  'src/pages/TablePage.tsx',
  'src/components/table/TableModalsLayer.tsx',
];

/** Names referenced before their declaration inside a DEFERRED callback, per file. */
const BASELINE: Record<string, string[]> = {
  'src/pages/MultiTablePage.tsx': ['goToLobby', 'sitOutStartedMessage'],
  'src/pages/TablePage.tsx': [
    'bustRebuyOpenRef',
    'clearEarlyTimers',
    'collectingChipSeatsRef',
    'exitIfBustedRef',
    'handleForceLeaveTable',
    'handleInsuranceDeclineForHand',
    'handleTournamentAddOn',
    'handleTournamentRebuy',
    'headsUpAnnouncedRef',
    'heroActedFenceRef',
    'heroCardFetchRef',
    'heroSeatRef',
    'peakStackRef',
    'rabbitExpiryTimerRef',
    'rabbitFloorTimerRef',
    'rabbitRevealClearTimerRef',
    'resetTimer',
    'seatAcquiredAtRef',
    'seatPositions',
    'setDecisionDeadline',
    'setShowCashier',
    'setShowHandHistory',
    'setShowLeaderboard',
    'setShowSessionStats',
    'setShowSettings',
    'showActionError',
    'tableStateRef',
    'takeSavedHandRef',
    'totalBuyInRef',
    'tournamentFormatRef',
  ],
  'src/components/table/TableModalsLayer.tsx': [],
};

describe('LAW: no use-before-declare on the table route', () => {
  it('names used before their declaration are only the baselined, deferred ones', async () => {
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: resolve(ROOT, 'eslint.config.js'),
      overrideConfig: {
        rules: {
          '@typescript-eslint/no-use-before-define': [
            'error',
            { functions: false, classes: false, variables: true },
          ],
        },
      },
    });
    const results = await eslint.lintFiles(FILES.map((f) => resolve(ROOT, f)));
    const offenders: string[] = [];
    for (const r of results) {
      const rel = r.filePath.slice(ROOT.length + 1);
      const allowed = new Set(BASELINE[rel] ?? []);
      for (const m of r.messages) {
        if (m.ruleId !== '@typescript-eslint/no-use-before-define') continue;
        const name = /'([^']+)'/.exec(m.message)?.[1] ?? m.message;
        if (!allowed.has(name)) offenders.push(`${rel}:${m.line} ${name}`);
      }
    }
    expect(
      offenders,
      'A name is read before its declaration. If the read happens during render this is the parseTimed crash again; move the helper above the component. If it is genuinely inside a deferred callback, add it to BASELINE with your eyes open.'
    ).toEqual([]);
  }, 60_000);

  it('the helper that crashed the table lives above the component', () => {
    const src = readFileSync(resolve(ROOT, 'src/pages/MultiTablePage.tsx'), 'utf8');
    const helper = src.indexOf('export function parseTimed(');
    const component = src.indexOf('export default function MultiTablePage');
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(component);
  });
});
