// Execute the actual page callbacks and read-completion block with a deferred
// response. No database, synthetic tournament, React replacement or copied reducer.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { inClubScope } from '../../src/utils/clubScope';
import { mergeFastRows } from '../../src/pages/ClubHomePage';
import {
  reconcileTournamentLobbyRead,
  type TournamentLobbyChange,
} from '../../src/utils/tournamentLobbyRead';

const source = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
const parsed = ts.createSourceFile(
  'ClubHomePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
function exactlyOne(predicate: (node: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (found.length !== 1)
    throw new Error(`Expected one production source block, found ${found.length}`);
  return found[0];
}
function initializer(name: string): string {
  const node = exactlyOne(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(parsed) === name
  ) as ts.VariableDeclaration;
  if (!node.initializer) throw new Error(`Missing production initializer: ${name}`);
  return node.initializer.getText(parsed);
}
const completion = exactlyOne(
  (node) =>
    ts.isIfStatement(node) &&
    node.expression.getText(parsed).replace(/\s/g, '') ===
      '!clubTournamentResult.error&&Array.isArray(clubTournamentResult.data)'
);
const emit = (text: string) =>
  ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
type Row = { id: string; status: string; club_id: string; current_players?: number };
const club = '00000000-0000-4000-8000-000000000001';
const row = (id: string, status = 'RUNNING'): Row => ({ id, status, club_id: club });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function model(initial: Row[]) {
  const state = {
    rows: initial,
    current: true,
    revision: { current: 0 },
    changes: { current: new Map<string, TournamentLobbyChange<Row>>() },
    pending: { current: false },
    painted: { current: false },
    errors: [] as unknown[],
  };
  const setTournaments = (next: Row[] | ((old: Row[]) => Row[])) => {
    state.rows = typeof next === 'function' ? next(state.rows) : next;
  };
  const handle = new Function(
    'isCurrent',
    'inClubScope',
    'rtScope',
    'setTournaments',
    'tournamentRevisionRef',
    'tournamentReadChangesRef',
    emit(
      `const LOBBY_TOURNAMENT_STATUSES = ${initializer('LOBBY_TOURNAMENT_STATUSES')}; const belongsInTournamentList = ${initializer('belongsInTournamentList')}; const handle = ${initializer('handleTournamentChange')};`
    ) + '\nreturn handle;'
  )(
    () => state.current,
    inClubScope,
    { clubId: club },
    setTournaments,
    state.revision,
    state.changes
  ) as (payload: { eventType: string; new?: Row; old?: { id: string } }) => void;
  const finish = (
    rows: Row[],
    revision: number,
    confirmed: boolean,
    enrich: (rows: Row[]) => Promise<Row[]>
  ) =>
    new Function(
      'clubTournamentResult',
      'withDiamondSpinCeilings',
      'getIsMounted',
      'listsPaintedRef',
      'tournamentScopeConfirmed',
      'tournamentRevisionAtRead',
      'tournamentRevisionRef',
      'tournamentReadChangesRef',
      'reloadPendingRef',
      'setTournaments',
      'reportError',
      'unionId',
      'reconcileTournamentLobbyRead',
      emit(
        `async function apply() { let tournamentsRead = false; ${completion.getText(parsed)}; return tournamentsRead; }`
      ) + '\nreturn apply();'
    )(
      { data: rows, error: null },
      enrich,
      () => true,
      state.painted,
      confirmed,
      revision,
      state.revision,
      state.changes,
      state.pending,
      setTournaments,
      (error: unknown) => state.errors.push(error),
      null,
      reconcileTournamentLobbyRead
    ) as Promise<boolean>;
  const read = (confirmed = true, enrich = async (rows: Row[]) => rows) => {
    const revision = state.revision.current;
    const response = deferred<Row[]>();
    const done = response.promise.then((rows) => finish(rows, revision, confirmed, enrich));
    return { response, done };
  };
  const fastPaint = (rows: Row[], revision: number) => {
    const fast = exactlyOne(
      (node) =>
        ts.isIfStatement(node) &&
        node.expression.getText(parsed).replace(/\s/g, '') === 'Array.isArray(home.tournaments)'
    );
    new Function(
      'home',
      'setTournaments',
      'mergeFastRows',
      'reconcileTournamentLobbyRead',
      'tournamentReadChangesRef',
      'fastTournamentRevisionAtRead',
      emit(fast.getText(parsed))
    )(
      { tournaments: rows },
      setTournaments,
      mergeFastRows,
      reconcileTournamentLobbyRead,
      state.changes,
      revision
    );
  };
  return { state, handle, read, fastPaint };
}

describe('tournament list reads cannot undo newer realtime results', () => {
  it.each(['CANCELLED', 'COMPLETED'])(
    'keeps a %s event removed when an older nonempty response finishes',
    async (status) => {
      const m = model([row('old')]);
      const pending = m.read();
      m.handle({ eventType: 'UPDATE', new: row('old', status) });
      expect(m.state.rows).toEqual([]);
      pending.response.resolve([row('old')]);
      expect(await pending.done).toBe(true);
      expect(m.state.rows).toEqual([]);
      expect(m.state.pending.current).toBe(false);
    }
  );

  it('keeps Running after an older Registering response finishes', async () => {
    const m = model([row('live', 'REGISTERING')]);
    const pending = m.read();
    m.handle({ eventType: 'UPDATE', new: row('live') });
    pending.response.resolve([row('live', 'REGISTERING')]);
    expect(await pending.done).toBe(true);
    expect(m.state.rows[0].status).toBe('RUNNING');
    expect(m.state.pending.current).toBe(false);
  });

  it('does not restore a deleted event from a delayed response', async () => {
    const m = model([row('deleted')]);
    const pending = m.read();
    m.handle({ eventType: 'DELETE', old: { id: 'deleted' } });
    pending.response.resolve([row('deleted')]);
    await pending.done;
    expect(m.state.rows).toEqual([]);
    expect(m.state.pending.current).toBe(false);
  });

  it('also protects cancellation during asynchronous row enrichment', async () => {
    const m = model([row('old')]);
    const enriching = deferred<Row[]>();
    const pending = m.read(true, () => enriching.promise);
    pending.response.resolve([row('old')]);
    await Promise.resolve();
    m.handle({ eventType: 'UPDATE', new: row('old', 'CANCELLED') });
    enriching.resolve([row('old')]);
    await pending.done;
    expect(m.state.rows).toEqual([]);
    expect(m.state.pending.current).toBe(false);
  });

  it('keeps a new realtime event against an older empty response', async () => {
    const m = model([]);
    const pending = m.read();
    m.handle({ eventType: 'INSERT', new: row('new', 'REGISTERING') });
    pending.response.resolve([]);
    expect(await pending.done).toBe(true);
    expect(m.state.rows.map((r) => r.id)).toEqual(['new']);
    expect(m.state.pending.current).toBe(false);
  });

  it('still accepts confirmed empty reads without a newer event', async () => {
    const m = model([row('gone')]);
    const pending = m.read();
    pending.response.resolve([]);
    expect(await pending.done).toBe(true);
    expect(m.state.rows).toEqual([]);
    expect(m.state.pending.current).toBe(false);
  });

  it('does not infer absence from an unconfirmed scope', async () => {
    const m = model([row('kept')]);
    const pending = m.read(false);
    pending.response.resolve([]);
    expect(await pending.done).toBe(false);
    expect(m.state.rows.map((r) => r.id)).toEqual(['kept']);
    expect(m.state.errors).toHaveLength(1);
  });

  it('accepts an ordinary nonempty read and ignores stale subscription callbacks', async () => {
    const m = model([]);
    const pending = m.read();
    m.state.current = false;
    m.handle({ eventType: 'INSERT', new: row('stale') });
    pending.response.resolve([row('current')]);
    expect(await pending.done).toBe(true);
    expect(m.state.rows.map((r) => r.id)).toEqual(['current']);
    expect(m.state.revision.current).toBe(0);
  });

  it('also prevents the narrow first-paint response resurrecting a canceled row', () => {
    const m = model([row('old')]);
    const revision = m.state.revision.current;
    m.handle({ eventType: 'UPDATE', new: row('old', 'CANCELLED') });
    m.fastPaint([row('old')], revision);
    expect(m.state.rows).toEqual([]);
  });

  it('paints unrelated rows during ongoing realtime changes without another read', async () => {
    const m = model([row('live')]);
    const pending = m.read();
    for (const current_players of [1, 2, 3]) {
      m.handle({ eventType: 'UPDATE', new: { ...row('live'), current_players } });
    }
    pending.response.resolve([{ ...row('live'), current_players: 0 }, row('fresh')]);
    expect(await pending.done).toBe(true);
    expect(m.state.rows.find((r) => r.id === 'live')?.current_players).toBe(3);
    expect(m.state.rows.some((r) => r.id === 'fresh')).toBe(true);
    expect(m.state.pending.current).toBe(false);
  });

  it('does not replay a change that predates a fresh authoritative read', () => {
    const changes = new Map([['live', { revision: 1, row: row('live', 'REGISTERING') }]]);
    expect(reconcileTournamentLobbyRead([row('live')], changes, 1)[0].status).toBe('RUNNING');
  });

  it('a duplicate INSERT cannot downgrade a row already present in the read', () => {
    const changes = new Map([
      ['live', { revision: 2, row: row('live', 'REGISTERING'), insertOnly: true }],
    ]);
    expect(reconcileTournamentLobbyRead([row('live')], changes, 1)[0].status).toBe('RUNNING');
  });

  it('an UPDATE cannot insert a row the authoritative read excluded', () => {
    const changes = new Map([['gone', { revision: 2, row: row('gone') }]]);
    expect(reconcileTournamentLobbyRead([], changes, 1)).toEqual([]);
  });

  it('a late duplicate INSERT cannot restore a canceled event even briefly', async () => {
    const m = model([row('old')]);
    const pending = m.read();
    m.handle({ eventType: 'UPDATE', new: row('old', 'CANCELLED') });
    m.handle({ eventType: 'INSERT', new: row('old', 'REGISTERING') });
    expect(m.state.rows).toEqual([]);
    pending.response.resolve([row('old')]);
    await pending.done;
    expect(m.state.rows).toEqual([]);
  });

  it('a late duplicate UPDATE cannot undo a cancellation received during the read', async () => {
    const m = model([row('old')]);
    const pending = m.read();
    m.handle({ eventType: 'UPDATE', new: row('old', 'CANCELLED') });
    m.handle({ eventType: 'UPDATE', new: row('old') });
    pending.response.resolve([row('old')]);
    await pending.done;
    expect(m.state.rows).toEqual([]);
    m.fastPaint([row('old')], 0);
    expect(m.state.rows).toEqual([]);
  });
});
