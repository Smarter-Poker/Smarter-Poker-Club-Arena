import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { sliceMethod } from '../helpers/sourceWindow';
import { awaitTournamentResultEnrichment } from '../../src/utils/tournamentResultEnrichment';
import { TOURNAMENT_CHAMPION_DISPLAY_MS } from '../../src/utils/tournamentChampion';
import { readPersistedTournamentFormatContract } from '../../server/src/tournament/tournamentEntryCapacity';

const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const compile = (name: string) =>
  ts.transpileModule(sliceMethod(source, name), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
const actual =
  compile('async function announceSpectatorChampion') +
  compile('async function exitFromDurableCompletion()');
const formats = ['mtt-v1', 'mtt-v2', 'sng-v1', 'spin-v1', 'seat-first-satellite-v1'] as const;
const roles = ['champion', 'runner-up', 'spectator', 'guest'] as const;

function client(role: (typeof roles)[number], satellite = false, terminal = true) {
  const own =
    role === 'champion'
      ? { status: 'winner', position: satellite ? null : 1, prize: 50 }
      : role === 'runner-up'
        ? { status: 'eliminated', position: 2, prize: 20 }
        : null;
  const champion = satellite ? null : { user_id: 'champion', username: 'Alice', prize: 50 };
  const qualifiers = [
    { user_id: 'champion', username: 'Alice', prize: 50 },
    { user_id: 'other', username: 'Bob', prize: 50 },
  ];
  const supabase = {
    from(name: string) {
      let ownQuery = false;
      const q = {
        select: () => q,
        eq: (key: string) => {
          if (key === 'user_id') ownQuery = true;
          return q;
        },
        is: () => q,
        order: () => q,
        maybeSingle: async () => ({ data: ownQuery ? own : champion, error: null }),
        range: async () =>
          name === 'table_seats'
            ? { data: [], count: 0, error: null }
            : { data: qualifiers, count: 2, error: null },
      };
      return q;
    },
  };
  const announce = vi.fn(),
    close = vi.fn(),
    result = vi.fn(),
    retry = vi.fn(),
    report = vi.fn();
  const factory = new Function(
    'supabase',
    'setTournamentWinner',
    'masterBus',
    'navigate',
    'publishResult',
    'scheduleDurableCompletionRetry',
    'reportError',
    'awaitTournamentResultEnrichment',
    'TOURNAMENT_CHAMPION_DISPLAY_MS',
    `
    let isMounted=true,exitStarted=${terminal},championAnnouncementInFlight=false,terminalCelebrationStarted=false,terminalCompletionWitnessed=${terminal};
    let durableCompletionHandled=false,durableCompletionLookupInFlight=false,durableParticipantWitnessed=false;
    let durableCompletionFailureReported=false,durableCompletionRetryTimer=null,committedSatelliteQualification=null;
    const tableId='finished', embeddedTableId='finished', durableTournamentId='event',durableTournamentName='Final';
    const userId=${JSON.stringify(role === 'guest' ? 'guest' : role)};
    const loadedSatelliteTarget=${satellite ? "'target'" : 'null'};
    const formatGameTitle=(s)=>s,lobbyClubIdRef={current:'club'};
    // Reproduce the final-hand race: an elimination exit was already armed.
    const tournamentExitTimerRef={current:${terminal} ? setTimeout(()=>masterBus.emit('premature-close'),2500) : null};
    const goToLobbyWithResult=(position,prize,delay)=>{
      if(exitStarted || (terminalCompletionWitnessed&&!terminalCelebrationStarted))return;
      exitStarted=true;
      tournamentExitTimerRef.current=setTimeout(()=>publishResult({position,prize}),delay);
    };
    const readMySatelliteQualifierResult=async()=>({qualified:true,amount:50,position:null,deliveryKind:'ticket'});
    ${actual}
    return {run:exitFromDurableCompletion,complete:()=>{terminalCompletionWitnessed=true;return exitFromDurableCompletion()},dispose:()=>{isMounted=false;clearTimeout(tournamentExitTimerRef.current)}};
  `
  );
  return {
    announce,
    close,
    result,
    retry,
    report,
    ...factory(
      supabase,
      announce,
      { emit: close },
      vi.fn(),
      result,
      retry,
      report,
      awaitTournamentResultEnrichment,
      TOURNAMENT_CHAMPION_DISPLAY_MS
    ),
  };
}
afterEach(() => vi.useRealTimers());

describe('Every persisted tournament format shares the terminal celebration', () => {
  for (const format of formats)
    for (const role of roles) {
      it(`${format}: ${role} announces before closing at 20 seconds and retains only their own result`, async () => {
        vi.useFakeTimers();
        expect(readPersistedTournamentFormatContract({ format_contract: format })).toBe(format);
        const c = client(role, format === 'seat-first-satellite-v1');
        await c.run();
        await c.run();
        expect(c.announce).toHaveBeenCalledOnce();
        if (format === 'seat-first-satellite-v1')
          expect(c.announce.mock.calls[0][0].qualifiers).toHaveLength(2);
        else
          expect(c.announce).toHaveBeenCalledWith(
            expect.objectContaining({ championName: 'Alice', prize: 50 })
          );
        await vi.advanceTimersByTimeAsync(19_999);
        expect(c.close).not.toHaveBeenCalled();
        expect(c.result).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        if (role === 'champion' || role === 'runner-up') {
          expect(c.result).toHaveBeenCalledExactlyOnceWith({
            position: role === 'runner-up' ? 2 : format === 'seat-first-satellite-v1' ? 0 : 1,
            prize: role === 'runner-up' ? 20 : 50,
          });
          expect(c.close).not.toHaveBeenCalled();
        } else {
          expect(c.close).toHaveBeenCalledExactlyOnceWith('TABLE_MENU_ACTION', {
            tableId: 'finished',
            action: 'CLOSE_TABLE_TAB',
          });
          expect(c.result).not.toHaveBeenCalled();
        }
        expect(c.retry).not.toHaveBeenCalled();
        expect(c.report).not.toHaveBeenCalled();
      });
    }
  it('restores an individual bust while the tournament is still running without inventing a champion or waiting 20 seconds', async () => {
    vi.useFakeTimers();
    const c = client('runner-up', false, false);
    await c.run();
    expect(c.announce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2499);
    expect(c.result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(c.result).toHaveBeenCalledExactlyOnceWith({ position: 2, prize: 20 });
  });
  it('lets actual completion supersede an already recovered individual result before its short exit', async () => {
    vi.useFakeTimers();
    const c = client('runner-up', false, false);
    await c.run();
    await vi.advanceTimersByTimeAsync(1000);
    await c.complete();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(c.result).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(c.announce).toHaveBeenCalledOnce();
    expect(c.result).toHaveBeenCalledExactlyOnceWith({ position: 2, prize: 20 });
  });
  it('keeps the matrix exhaustive and executes it in the required client and publisher suites', () => {
    const owner = ts.createSourceFile(
      'formats.ts',
      readFileSync('server/src/tournament/tournamentEntryCapacity.ts', 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const declaration = owner.statements.find(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) && node.name.text === 'TournamentFormatContract'
    );
    expect(declaration && ts.isUnionTypeNode(declaration.type)).toBe(true);
    const declared = (declaration!.type as ts.UnionTypeNode).types.map((node) =>
      ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? node.literal.text : 'UNKNOWN'
    );
    expect([...formats].sort()).toEqual(declared.sort());
    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/publish-club-arena.yml',
    ]) {
      expect(readFileSync(workflow, 'utf8')).toMatch(/run: npx vitest run tests\/ --shard=/);
    }
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain(
      'name: Client Unit Tests (vitest)'
    );
  });
  it('routes every committed terminal event through the same recovery, without a game or bounty exclusion', () => {
    for (const [event, next] of [
      ['satellite_qualifiers', 'final_table_deal'],
      ['final_table_deal', 'tournament_winner'],
      ['tournament_winner', 'late_reg_closed'],
    ]) {
      const from = source.indexOf(`data?.type === '${event}'`),
        to = source.indexOf(`data?.type === '${next}'`, from);
      expect(from).toBeGreaterThan(-1);
      expect(source.slice(from, to)).toContain('void exitFromDurableCompletion()');
      expect(source.slice(from, to)).toContain('terminalCompletionWitnessed = true');
    }
    expect(actual).not.toMatch(
      /tournamentFormatRef|is_horse|is_mystery_bounty|is_bounty|game_type/
    );
    expect(source).toContain('if (terminalCelebrationStarted) return;');
  });
});
