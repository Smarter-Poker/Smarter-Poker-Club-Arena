import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const manager = read('server/src/tournament/TournamentManager.ts');
const base = read('server/src/tournament/TournamentManagerBase.ts');

const body = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThan(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('a break abandoned by a retired lease generation can still end', () => {
  // 2026-09-18: 153 operations parked and never finished. 54 of them were the
  // last open table of their event, held custody, and satisfied every
  // precondition of the no-start continuation - but the continuation was
  // reachable from exactly one place, table engine admission, and the managers
  // that could have run it had already started. Discovery found each of them
  // hundreds of times over three days and could do nothing with any of them.
  it('offers the no-start continuation from the discovery path, not only from admission', () => {
    const recover = body(
      manager,
      'protected async recoverTournamentBreak(',
      'protected async continueAbandonedNoStartPark('
    );
    // A park with no provable destination must not simply return. On the last
    // open table that is the terminal case, not a capacity shortage.
    expect(recover).toContain('await this.continueAbandonedNoStartPark(current);');
    const parked = recover.indexOf('prepareParkedTournamentBreak');
    const offered = recover.indexOf('continueAbandonedNoStartPark');
    expect(parked).toBeGreaterThan(0);
    expect(offered).toBeGreaterThan(parked);
  });

  it('reaches the continuation without a current-generation hand permit', () => {
    const abandoned = body(
      manager,
      'protected async continueAbandonedNoStartPark(',
      '/** Local custody only;'
    );
    // The whole point: this path exists for an operation whose origin
    // generation is retired, so it can never consult a permit binding.
    expect(abandoned).not.toContain('bindStoppedOriginalBreak');
    expect(abandoned).not.toContain('getF06RecoverablePermit');
    expect(abandoned).not.toContain('stoppedOriginalBreaks');
    // It delegates to the one audited continuation, which re-proves the scope.
    expect(abandoned).toContain('await this.continueExcludedNoStartTable(');
    // And it refuses anything it has not read off the operation itself.
    for (const guard of [
      "state.state !== 'park_requested'",
      'state.terminal_handoff_required',
      'state.members.length',
      '!state.custody_id',
      'ownsTournamentTableEngine',
    ])
      expect(abandoned, guard).toContain(guard);
  });

  it('does not weaken the permit binding that guards an ordinary retirement', () => {
    const bind = body(
      manager,
      'private bindStoppedOriginalBreak(',
      'private readonly pendingTournamentBreakCustodyIds'
    );
    // Relaxing this was the tempting fix and it would have let a stale permit
    // drive a terminal transition. The generation check stays exactly as it was.
    expect(bind).toContain('b.lease_generation !== this.getTournamentLeaseGeneration()');
    expect(bind).toContain('b.lifecycle !== state.lifecycle');
  });

  it('keeps one continuation implementation, still re-proving the last-table scope', () => {
    const excluded = body(
      manager,
      'protected async continueExcludedNoStartTable(',
      'protected async retireTournamentBreak('
    );
    expect(excluded).toContain('openTables.length !== 1');
    expect(excluded).toContain("state.state !== 'park_requested'");
    expect(excluded).toContain('!state.custody_id');
    expect(excluded).toContain('continueNoStartLastTable(state)');
    // Admission keeps its own call; the discovery path is an addition, not a move.
    expect(base).toContain('await this.continueExcludedNoStartTable(tableId, engine, current)');
  });
});
