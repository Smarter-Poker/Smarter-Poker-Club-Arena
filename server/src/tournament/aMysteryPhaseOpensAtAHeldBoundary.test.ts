import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  mysteryBountyFieldTooSmall,
  mysteryBountyThresholdReached,
} from './mysteryBountyActivation.js';

/*
 * Production 2026-09-11..30: 13 at-the-money mystery events whose bubble burst
 * at a final table never opened a single chest. The sweep that decides
 * activation runs after the busting hand, the next hand was already dealt, the
 * predicate said `hand_in_progress`, and nothing re-asked. These cases execute
 * the production hold/release methods and pin the sweep and park-edge wiring.
 */
const base = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const sweep = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const ast = ts.createSourceFile('manager.ts', base, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TournamentManagerBase'
);
const method = (name: string) => {
  const found = manager?.members.find(
    (node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && node.name.getText(ast) === name
  );
  if (!found) throw new Error(`production method ${name} missing`);
  return found.getText(ast);
};
const count = ast.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'countPaidPlaces'
);
if (!count) throw new Error('countPaidPlaces missing');
const compiled = ts.transpileModule(
  `${count.getText(ast)}
class Subject {
  ${method('mysteryActivationMayOpenOnBust')}
  ${method('holdMysteryActivationBoundary')}
  ${method('releaseMysteryActivationBoundary')}
}
return Subject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

function engine() {
  return { pauseAfterHand: vi.fn(), resumeDealing: vi.fn() };
}

function fixture(over: Record<string, unknown> = {}) {
  const Subject = new Function(
    'TournamentManagerBase',
    'mysteryBountyThresholdReached',
    'mysteryBountyFieldTooSmall',
    'reportError',
    compiled
  );
  const timers: Array<() => void> = [];
  const tables = [engine(), engine()];
  const Cls = Subject(
    { MYSTERY_ACTIVATION_HOLD_MS: 20000 },
    mysteryBountyThresholdReached,
    mysteryBountyFieldTooSmall,
    vi.fn()
  );
  const subject = Object.assign(new Cls(), {
    running: true,
    tournamentId: 'mystery-boundary',
    tournamentCache: {
      is_mystery_bounty: true,
      mystery_bounty_activation: 'at_the_money',
      mystery_bounty_activation_value: null,
      current_players: 24,
      payout_structure: [{ place: 1 }, { place: 2 }, { place: 3 }],
    },
    mysteryBountyStage: 'pending',
    mysteryPlayersRemainingHint: 4 as number | null,
    // Every mode reads the closed entry count now (2026-10-05): a field of 10
    // or fewer never opens chests, so the boundary needs to know it.
    mysteryTotalEntries: 24 as number | null,
    prizePoolFinalized: true,
    mysteryActivationBoundaryPending: false,
    mysteryActivationBoundaryTimer: null,
    mysteryActivationBoundaryEngines: new Set(),
    tableEngines: new Map(tables.map((e, i) => [`t${i}`, e])),
    onBreak: false,
    stageEndPause: null,
    addOnBreakActive: false,
    addOnBreakOwnsPause: false,
    handForHandActive: false,
    satelliteQualifierBoundaryPending: false,
    isCohortSatellite: vi.fn(() => false),
    advanceHandForHandBarrier: vi.fn(),
    setLifecycleTimeout: vi.fn((cb: () => void) => {
      timers.push(cb);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }),
    clearLifecycleTimeout: vi.fn(),
    ...over,
  });
  return { subject, tables, timers };
}

const bust = [{ stack: 0 }, { stack: 5000 }, { stack: 7000 }, { stack: 3000 }];

describe('the mystery phase opens at a boundary the engine holds', () => {
  it('a bust that bursts a final-table bubble holds every table before its next deal', () => {
    const f = fixture();
    expect(f.subject.mysteryActivationMayOpenOnBust(bust)).toBe(true);
    f.subject.holdMysteryActivationBoundary();
    expect(f.subject.mysteryActivationBoundaryPending).toBe(true);
    for (const table of f.tables) {
      expect(table.pauseAfterHand).toHaveBeenCalledWith(20000, { beforeNextHand: true });
    }
  });

  it('a bust far from the threshold, the final bust, or an open phase holds nothing', () => {
    expect(
      fixture({ mysteryPlayersRemainingHint: 12 }).subject.mysteryActivationMayOpenOnBust(bust)
    ).toBe(false);
    expect(
      fixture({ mysteryPlayersRemainingHint: 2 }).subject.mysteryActivationMayOpenOnBust(bust)
    ).toBe(false);
    expect(
      fixture({ mysteryBountyStage: 'active' }).subject.mysteryActivationMayOpenOnBust(bust)
    ).toBe(false);
    const plain = fixture();
    plain.subject.tournamentCache.is_mystery_bounty = false;
    expect(plain.subject.mysteryActivationMayOpenOnBust(bust)).toBe(false);
  });

  it('a mystery bounty of 10 or fewer entries never holds a boundary, in any mode (Dan 2026-10-05)', () => {
    for (const mode of ['at_the_money', 'percent_field', 'player_count'] as const) {
      for (const entries of [3, 7, 10]) {
        const f = fixture({ mysteryTotalEntries: entries });
        f.subject.tournamentCache.mystery_bounty_activation = mode;
        f.subject.tournamentCache.mystery_bounty_activation_value =
          mode === 'percent_field' ? 100 : mode === 'player_count' ? 9 : null;
        expect(f.subject.mysteryActivationMayOpenOnBust(bust)).toBe(false);
      }
      const eleven = fixture({ mysteryTotalEntries: 11 });
      eleven.subject.tournamentCache.mystery_bounty_activation = mode;
      eleven.subject.tournamentCache.mystery_bounty_activation_value =
        mode === 'percent_field' ? 100 : mode === 'player_count' ? 9 : null;
      expect(eleven.subject.mysteryActivationMayOpenOnBust(bust)).toBe(true);
    }
  });

  it('an unread entry count after the close holds, so the sweep reads it', () => {
    expect(
      fixture({ mysteryTotalEntries: null }).subject.mysteryActivationMayOpenOnBust(bust)
    ).toBe(true);
    expect(
      fixture({
        mysteryTotalEntries: null,
        prizePoolFinalized: false,
      }).subject.mysteryActivationMayOpenOnBust(bust)
    ).toBe(false);
  });

  it('an unknown count holds, so the verified count decides', () => {
    expect(
      fixture({ mysteryPlayersRemainingHint: null }).subject.mysteryActivationMayOpenOnBust(bust)
    ).toBe(true);
  });

  it('the release resumes exactly the tables it held', () => {
    const f = fixture();
    f.subject.holdMysteryActivationBoundary();
    f.subject.releaseMysteryActivationBoundary();
    expect(f.subject.mysteryActivationBoundaryPending).toBe(false);
    for (const table of f.tables) expect(table.resumeDealing).toHaveBeenCalledOnce();
    f.subject.releaseMysteryActivationBoundary();
    for (const table of f.tables) expect(table.resumeDealing).toHaveBeenCalledOnce();
  });

  it('under hand-for-hand the release hands the tables back to its barrier', () => {
    const f = fixture({ handForHandActive: true });
    f.subject.holdMysteryActivationBoundary();
    for (const table of f.tables) expect(table.pauseAfterHand).not.toHaveBeenCalled();
    f.subject.releaseMysteryActivationBoundary();
    expect(f.subject.advanceHandForHandBarrier).toHaveBeenCalledOnce();
    for (const table of f.tables) expect(table.resumeDealing).not.toHaveBeenCalled();
  });

  it('a break owns its tables: no hold is armed and nothing is resumed', () => {
    const f = fixture({ onBreak: true });
    f.subject.holdMysteryActivationBoundary();
    expect(f.subject.mysteryActivationBoundaryPending).toBe(false);
    for (const table of f.tables) expect(table.pauseAfterHand).not.toHaveBeenCalled();
  });

  it('the hold can never outlive its budget', () => {
    const f = fixture();
    f.subject.holdMysteryActivationBoundary();
    expect(f.timers).toHaveLength(1);
    f.timers[0]();
    expect(f.subject.mysteryActivationBoundaryPending).toBe(false);
    for (const table of f.tables) expect(table.resumeDealing).toHaveBeenCalledOnce();
  });

  it('the sweep keeps the hold only while a hand is in the air, and a park re-asks', () => {
    expect(base).toContain("return decision.reason === 'hand_in_progress';");
    expect(sweep).toMatch(
      /const awaitingBoundary = await this\.maybeActivateMysteryBounty\(remainingCount\);[\s\S]{0,300}if \(awaitingBoundary !== true\) this\.releaseMysteryActivationBoundary\(\);/
    );
    expect(sweep).toContain('this.mysteryPlayersRemainingHint = remainingCount;');
    expect(base).toMatch(
      /if \(this\.mysteryActivationBoundaryPending\)\s+this\.requestEliminationSweep\('mystery_activation_boundary'\);/
    );
    expect(base).toMatch(
      /if \(this\.mysteryActivationMayOpenOnBust\(finalStacks\)\) this\.holdMysteryActivationBoundary\(\);/
    );
    // Hand-for-hand's barrier may not deal through a held activation.
    expect(base).toMatch(
      /this\.satelliteQualifierBoundaryPending \|\|\s+this\.mysteryActivationBoundaryPending\s+\)\s+return;/
    );
  });
});
