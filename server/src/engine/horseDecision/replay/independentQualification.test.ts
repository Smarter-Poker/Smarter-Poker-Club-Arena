import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  independentContestablePot,
  independentDepthBracket,
  independentMZone,
  independentTournamentPosition,
  qualifyHorseDecisionIndependently,
} from './independentQualification.js';
import { reconstructHorseReplayInput } from './reconstruct.js';
import { PHASE6C_FIXTURE_IDS as IDS, phase6cFixtureRecord } from './fixtures/index.js';

type Input = Parameters<typeof qualifyHorseDecisionIndependently>[0];
function inputFor(id: string): Input {
  const input = reconstructHorseReplayInput(phase6cFixtureRecord(id));
  return structuredClone({
    player: input.request.player,
    gameState: input.request.gameState,
    opts: (input.request.opts as Record<string, unknown> | undefined) ?? null,
    attribution: input.original.tournamentPreflopAttribution ?? null,
  }) as unknown as Input;
}
const seat = (
  seat: number,
  stack: number,
  bet: number,
  invested: number,
  extra: Partial<Input['player']> = {}
): Input['player'] => ({
  seat,
  user_id: `u${seat}`,
  stack,
  bet,
  totalInvested: invested,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  ...extra,
});

describe('Phase 6C independent verifier does not import the production policy modules', () => {
  it('imports nothing from HorseLogic, HorsePreflop, HorseTournamentPreflop, HorsePhase6Attribution or PokerEngine', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'independentQualification.ts'),
      'utf8'
    );
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./verdict.js']);
  });
});

describe('Phase 6C independent qualification of a journaled decision', () => {
  it('agrees with a natural atlas-evaluated tournament preflop decision on every check', () => {
    const q = qualifyHorseDecisionIndependently(inputFor(IDS.tournamentAtlasEvaluated));
    expect(q.pot_odds.status).toBe('agreed');
    expect(q.m_state.status).toBe('agreed');
    expect(q.ante_mode.status).toBe('agreed');
    expect(q.atlas_coordinate.status).toBe('agreed');
    expect(q.route.status).toBe('agreed');
    expect(q.admissibleRoutes).toEqual(['intent_engine']);
    expect((q.atlas_coordinate.expected as { policy: { cell: string } }).policy.cell).toBe(
      'phase6-v1:nlh:deterministic_baseline:5:CO:HJ:big_blind:multiway_all_in:20-25@0.07853333333333339:velocity=0.216'
    );
  });

  it('agrees with a labeled-fallback tournament decision and names the fallback cell', () => {
    const q = qualifyHorseDecisionIndependently(inputFor(IDS.tournamentLabeledFallback));
    expect(q.atlas_coordinate.status).toBe('agreed');
    expect(q.m_state.status).toBe('agreed');
    expect((q.atlas_coordinate.expected as { policy: { source: string } }).policy.source).toBe(
      'labeled_fallback'
    );
  });

  it('finds the chart open-jam route admissible where the journal took it', () => {
    const q = qualifyHorseDecisionIndependently(inputFor(IDS.tournamentChartOpenJam));
    expect(q.admissibleRoutes).toContain('chart_open_jam');
    expect(q.route.status).toBe('agreed');
  });

  it('disagrees when the claimed atlas coordinate names another branch', () => {
    const input = inputFor(IDS.tournamentAtlasEvaluated);
    input.attribution!.lookup!.coordinate.branch = 'unopened';
    const q = qualifyHorseDecisionIndependently(input);
    expect(q.atlas_coordinate.status).toBe('disagreed');
  });

  it('disagrees when the journaled M state does not follow from the blinds and stack', () => {
    const input = inputFor(IDS.tournamentAtlasEvaluated);
    input.gameState.tournament!.m!.effectiveM += 0.5;
    const q = qualifyHorseDecisionIndependently(input);
    expect(q.m_state.status).toBe('disagreed');
  });

  it('disagrees when the declared ante mode contradicts the posted ante', () => {
    const input = inputFor(IDS.tournamentAtlasEvaluated);
    input.gameState.bigBlindAnte = false;
    input.gameState.ante = 0;
    const q = qualifyHorseDecisionIndependently(input);
    expect(q.ante_mode.status).toBe('disagreed');
  });

  it('disagrees when the canonical toCall or contestable pot is not what the seats imply', () => {
    const input = inputFor(IDS.tournamentAtlasEvaluated);
    input.gameState.toCall = (input.gameState.toCall ?? 0) + 1;
    expect(qualifyHorseDecisionIndependently(input).pot_odds.status).toBe('disagreed');
    const other = inputFor(IDS.cashNlhPreflop);
    other.gameState.contestablePot = (other.gameState.contestablePot ?? 0) + 5;
    expect(qualifyHorseDecisionIndependently(other).pot_odds.status).toBe('disagreed');
  });

  it('disagrees when the claimed route is not admissible for the snapshot', () => {
    const input = inputFor(IDS.tournamentAtlasEvaluated);
    input.attribution!.route = 'chart_bb_defend';
    expect(qualifyHorseDecisionIndependently(input).route.status).toBe('disagreed');
  });

  it('marks tournament-only checks not applicable outside a tournament and postflop', () => {
    const cash = qualifyHorseDecisionIndependently(inputFor(IDS.cashNlhPreflop));
    expect(cash.m_state.status).toBe('not_applicable');
    expect(cash.ante_mode.status).toBe('not_applicable');
    expect(cash.atlas_coordinate.status).toBe('not_applicable');
    expect(cash.route.status).toBe('agreed');
    expect(cash.pot_odds.status).toBe('agreed');
    const river = qualifyHorseDecisionIndependently(inputFor(IDS.cashNlhRiver));
    expect(river.route.status).toBe('not_applicable');
    expect(river.atlas_coordinate.status).toBe('not_applicable');
    expect(river.pot_odds.status).toBe('agreed');
  });
});

describe('Phase 6C restated Phase 6 arithmetic', () => {
  it('names the Harrington zone with half an M of hysteresis on the crossed boundary only', () => {
    expect(independentMZone(4.9, null)).toBe('red');
    expect(independentMZone(5.2, 'red')).toBe('red');
    expect(independentMZone(5.5, 'red')).toBe('orange');
    expect(independentMZone(9.7, 'yellow')).toBe('yellow');
    expect(independentMZone(9.4, 'yellow')).toBe('orange');
    expect(independentMZone(45, 'red')).toBe('blue');
    expect(independentMZone(0, 'green')).toBe('dead');
  });

  it('interpolates depth on the published anchors and clamps outside them', () => {
    expect(independentDepthBracket(20)).toEqual({ lower: 20, upper: 20, weight: 0 });
    expect(independentDepthBracket(22.5)).toEqual({ lower: 20, upper: 25, weight: 0.5 });
    expect(independentDepthBracket(1)).toEqual({ lower: 2, upper: 2, weight: 0 });
    expect(independentDepthBracket(250)).toEqual({ lower: 100, upper: 100, weight: 0 });
  });

  it('names tournament positions clockwise from the dealer', () => {
    expect(independentTournamentPosition(1, 2, [1, 2, 3, 6, 8])).toBe('CO');
    expect(independentTournamentPosition(8, 2, [1, 2, 3, 6, 8])).toBe('HJ');
    expect(independentTournamentPosition(3, 2, [1, 2, 3, 6, 8])).toBe('SB');
    expect(independentTournamentPosition(2, 2, [1, 2, 3, 6, 8])).toBe('BTN');
    expect(independentTournamentPosition(4, 4, [4, 7])).toBe('SB');
    expect(independentTournamentPosition(9, undefined, [4, 9])).toBe('MP');
  });

  it('prices the contestable pot as what hero can win after calling', () => {
    const hero = seat(1, 50, 0, 0);
    const players = [
      hero,
      seat(2, 0, 30, 30, { is_all_in: true }),
      seat(3, 100, 30, 30),
      seat(4, 100, 0, 5, { is_folded: true }),
    ];
    // Hero calls 30: three-way level 30 x 3 = 90 plus the folded 5 = 95 in
    // pots hero can win, minus hero's own 30.
    expect(independentContestablePot(players, hero, 30)).toBe(65);
    const short = seat(1, 10, 0, 0);
    // Short hero can only call 10: 10 x 3 + 5 orphan-free folded chips = 35, minus 10.
    expect(independentContestablePot([short, ...players.slice(1)], short, 30)).toBe(25);
  });
});
