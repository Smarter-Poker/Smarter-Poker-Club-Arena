/**
 * A TABLE WITH ONE PLAYER IS STILL THE BALANCER'S PROBLEM (2026-09-10).
 *
 * `checkTableBalance` took its table list from `this.tableEngines`, which holds
 * only tables that are DEALING. A table cannot deal to one player, so a table
 * down to its last player has no engine; with no engine the balancer never saw
 * it; and so nobody ever moved that player to join anybody. The table stayed at
 * one player for ever and the event could not deal another hand.
 *
 * Both gates read the same wrong thing:
 *
 *     if (this.tableEngines.size <= 1) return;          // the break step
 *     if (this.tableEngines.size > 1) { ... }           // the rebalance step
 *
 * MEASURED ON PRODUCTION 2026-09-10: thirty-five RUNNING events were in that
 * state - two or more funded players, and no single table holding two of them.
 * The worst was a $100 Freeroll with 36 funded players on 36 tables, one each,
 * frozen since 10:04. Not slow: structurally unable to deal a hand, every one
 * of them holding prize money, some for more than fourteen hours.
 *
 * THE RULE: the balancer works on the tables that HOLD PLAYERS, read from the
 * database, not on the tables that happen to be dealing.
 * `loadBalancerTables` already sources every field it needs from the database
 * and consults `tableEngines` only for a button seat, which defaults to 0 - an
 * engineless table was always representable, it was simply never in the list.
 *
 * An unreadable answer is UNKNOWN, never "balanced": both gates re-arm the
 * balance redrive and return rather than concluding anything.
 *
 * docs/changelog/2026-09-10-a-table-with-one-player-is-still-the-balancers-problem.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod } from './helpers/sourceWindow';

const MANAGER = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManager.ts'),
  'utf8'
);
const BASE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe("a table with one player is still the balancer's problem", () => {
  it('the balancer no longer decides anything from the engine count', () => {
    const balance = sliceMethod(MANAGER, 'protected async checkTableBalance');
    expect(balance).not.toContain('this.tableEngines.size <= 1');
    expect(balance).not.toContain('this.tableEngines.size > 1');
    // and it never sources its table list from the engines either
    expect(balance).not.toContain("[...this.tableEngines.keys()], 'balanceInitial'");
    expect(balance).not.toContain("[...this.tableEngines.keys()],\n        'balanceFresh'");
  });

  it('both steps take the tables that hold players, from the database', () => {
    const balance = sliceMethod(MANAGER, 'protected async checkTableBalance');
    expect(balance).toContain(
      'const liveTableIds = await this.liveTournamentTableIdsWithPlayers();'
    );
    expect(balance).toContain(
      'const freshTableIds = await this.liveTournamentTableIdsWithPlayers();'
    );
    expect(balance).toContain("this.loadBalancerTables(liveTableIds, 'balanceInitial')");
    expect(balance).toContain("this.loadBalancerTables(freshTableIds, 'balanceFresh')");
  });

  it('an unreadable table list is UNKNOWN, never balanced', () => {
    const balance = sliceMethod(MANAGER, 'protected async checkTableBalance');
    // both gates must re-arm and return rather than fall through
    const nulls = balance.match(/TableIds === null/g) ?? [];
    expect(nulls.length, 'both steps must handle an unreadable list').toBe(2);
    expect(balance).toContain('UNKNOWN is not "balanced"');
  });

  it('the reader asks for live tables that still hold a seated player', () => {
    const reader = sliceMethod(BASE, 'protected async liveTournamentTableIdsWithPlayers');
    expect(reader).toContain("in('status', ['running', 'waiting'])");
    expect(reader).toContain("is('left_at', null)");
    // it returns ids, and an unreadable read is null rather than an empty list
    expect(reader).toContain('return null;');
    expect(reader).toContain('return ids.filter((id) => holding.has(id));');
  });

  it('the final-table gate still asks the same question, through the same reader', () => {
    const counter = sliceMethod(BASE, 'protected async countLiveTablesWithPlayers');
    expect(counter).toContain('await this.liveTournamentTableIdsWithPlayers()');
    // null still means UNKNOWN, which every caller treats as "not yet"
    expect(counter).toContain('ids === null ? null : ids.length');
  });
});
