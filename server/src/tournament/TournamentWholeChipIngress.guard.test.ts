import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  canonicalTournamentBlindStructure,
  cashHandCapChips,
  isWholeTournamentChip,
  readWholeTournamentChip,
  TOURNAMENT_MAX_WHOLE_CHIPS,
  tournamentConfigChipError,
} from '../engine/TournamentChipIntegrity.js';

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function classMethod(
  source: string,
  fileName: string,
  className: string,
  methodName: string
): string {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const owner = tree.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === className
  );
  if (!owner) throw new Error(`${className} class missing from ${fileName}`);
  const method = owner.members.find(
    (node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && node.name.getText(tree) === methodName
  );
  if (!method) throw new Error(`${className}.${methodName} method missing from ${fileName}`);
  return method.getText(tree);
}

describe('persisted tournament configuration stays in the whole-chip denomination', () => {
  const healthy = {
    starting_chips: 1000,
    rebuy_chips: 0,
    addon_chips: null,
    blind_structure: [
      { smallBlind: 0, bigBlind: 20, ante: 0 },
      { sb: '15', bb: '30', ante: '5' },
      { isBreak: true },
    ],
  };

  it('preserves the schema default 0/null grant fallback and accepted blind aliases', () => {
    expect(tournamentConfigChipError(healthy)).toBeNull();
    expect(tournamentConfigChipError({ ...healthy, addon_chips: 0 })).toBeNull();
    expect(canonicalTournamentBlindStructure(healthy.blind_structure)).toEqual({
      ok: true,
      levels: [
        { smallBlind: 0, bigBlind: 20, ante: 0 },
        { sb: '15', bb: '30', ante: 5, smallBlind: 15, bigBlind: 30 },
        { isBreak: true },
      ],
    });
  });

  it('accepts cumulative stacks above int32 while enforcing the numeric(15,2) whole domain', () => {
    expect(readWholeTournamentChip(2_147_483_648)).toBe(2_147_483_648);
    expect(readWholeTournamentChip('9999999999999')).toBe(TOURNAMENT_MAX_WHOLE_CHIPS);
    expect(isWholeTournamentChip(TOURNAMENT_MAX_WHOLE_CHIPS)).toBe(true);
    expect(readWholeTournamentChip('10000000000000')).toBeNull();
    expect(readWholeTournamentChip(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(readWholeTournamentChip(-1)).toBeNull();
  });

  it.each([
    ['fractional starting stack', { ...healthy, starting_chips: 1000.5 }],
    ['negative rebuy grant', { ...healthy, rebuy_chips: -1 }],
    ['fractional add-on grant', { ...healthy, addon_chips: 10.5 }],
    ['non-array structure', { ...healthy, blind_structure: '{}' }],
    ['empty structure', { ...healthy, blind_structure: [] }],
    ['all-break structure', { ...healthy, blind_structure: [{ isBreak: true }] }],
    ['scalar level', { ...healthy, blind_structure: [7] }],
    ['missing small blind', { ...healthy, blind_structure: [{ bigBlind: 20 }] }],
    [
      'fractional small blind',
      { ...healthy, blind_structure: [{ smallBlind: 0.5, bigBlind: 20 }] },
    ],
    ['zero big blind', { ...healthy, blind_structure: [{ smallBlind: 0, bigBlind: 0 }] }],
    [
      'fractional ante',
      { ...healthy, blind_structure: [{ smallBlind: 10, bigBlind: 20, ante: 1.5 }] },
    ],
  ])('refuses %s without rounding', (_name, input) => {
    expect(tournamentConfigChipError(input)).not.toBeNull();
  });

  it('ignores copied cash cap flags on tournaments but preserves cash decimal caps', () => {
    expect(cashHandCapChips(true, true, 2.25, 2)).toBe(0);
    expect(cashHandCapChips(false, true, 2.25, 2)).toBe(4.5);
  });
});

describe('manager launch, recovery and ranking refuse before mutation', () => {
  const base = read('./TournamentManagerBase.ts');
  const manager = read('./TournamentManager.ts');
  const recovery = read('./tournamentRecovery.ts');
  const turns = read('../engine/ServerTableEngineTurns.ts');

  it('has no remaining floor coercion on launch, late seating or recovery ranks', () => {
    expect(base).not.toMatch(/Math\.floor\(Number\(row\.chips\)/);
    expect(manager).not.toMatch(/Math\.floor\(Number\(player\.chips\)/);
    expect(recovery).not.toMatch(/Math\.floor\(Number\(alive\[/);
    expect(base).not.toMatch(/Math\.max\(0, Number\(r\.rebuys\)/);
  });

  it('canonicalizes accepted aliases before either launch or resume caches the row', () => {
    for (const marker of ['const launchBlindStructure', 'const resumeBlindStructure']) {
      const normalized = base.indexOf(marker);
      const suffix = base.slice(normalized, normalized + 1_000);
      const assigned = suffix.indexOf('tournament.blind_structure =');
      const cached = suffix.indexOf('this.tournamentCache = tournament');
      expect(normalized).toBeGreaterThan(-1);
      expect(assigned).toBeGreaterThan(-1);
      expect(cached).toBeGreaterThan(assigned);
    }
  });

  it('validates the complete launch roster before its first supply or seating authority', () => {
    const roster = base.indexOf('const invalidLaunchStack = (regRows ?? []).find');
    const refusal = base.indexOf('Tournament.launch_roster_fractional_chips_refused', roster);
    const ledgerIssue = base.indexOf('await this.issueTournamentLaunchStacks(', roster);
    const tableConstruction = base.indexOf('await this.createTablesAndSeatPlayers(', roster);
    expect(roster).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(roster);
    expect(ledgerIssue).toBeGreaterThan(refusal);
    expect(tableConstruction).toBeGreaterThan(ledgerIssue);
    expect(base).not.toContain(".update({ status: 'playing', chips:");
  });

  it('lets the atomic launch-seat authority derive and validate the stack', () => {
    const method = classMethod(
      base,
      'TournamentManagerBase.ts',
      'TournamentManagerBase',
      'createTablesAndSeatPlayers'
    );
    const assignmentAt = method.indexOf('assignTournamentPlayerSeatAtomically({');
    const assignmentEnd = method.indexOf('});', assignmentAt);
    const assignment = method.slice(assignmentAt, assignmentEnd);
    expect(assignmentAt).toBeGreaterThan(-1);
    expect(assignmentEnd).toBeGreaterThan(assignmentAt);
    expect(method.match(/assignTournamentPlayerSeatAtomically\(\{/g)).toHaveLength(1);
    expect(assignment).toContain('tournamentId: this.tournamentId');
    expect(assignment).toContain('userId: toSeat[i].user_id');
    expect(assignment).not.toContain('chips');
    expect(method).not.toMatch(/\.from\('table_seats'\)[\s\S]{0,160}\.(?:insert|update|upsert)\(/);
    expect(manager).not.toContain('assignTournamentPlayerSeatAtomically');
  });

  it('routes both human and horse cap calculations through the cash-only boundary', () => {
    expect(turns.match(/cashHandCapChips\(/g)).toHaveLength(2);
    expect(turns).not.toMatch(/cap_enabled === true && capBB/);
    expect(turns).not.toMatch(/cap_enabled === true && horseCapBB/);
  });

  it('never ranks a recovered multi-player finish from chip stacks', () => {
    expect(recovery).toContain('recovery will not invent a multi-player finish from stacks');
    expect(recovery).toContain('requestTournamentTerminalReceipt(');
    expect(recovery).not.toMatch(/sort\([\s\S]{0,160}\.chips/);
    expect(recovery).not.toContain("'fn_apply_prize_guarantee'");
    expect(recovery).not.toContain('settleTournamentPlacesAtomically(');
  });
});
