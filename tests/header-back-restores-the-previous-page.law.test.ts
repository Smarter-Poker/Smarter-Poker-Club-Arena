import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rememberLobbyPage, restoreLobbyPage } from '../src/utils/lobbyPageHistory';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('header Back restores the previous visible page', () => {
  it('restores Shark after selector and another club without consulting saved club preferences', () => {
    const shark = { id: 'lobby:1', lobbyClubId: 'shark-club' };
    const selector = { ...rememberLobbyPage(shark, 'deep-stack-society'), lobbyClubId: null };
    const deep = {
      ...rememberLobbyPage(selector, 'deep-stack-society'),
      lobbyClubId: 'deep-stack-society',
    };
    const previous = restoreLobbyPage(deep)!;
    expect(previous.lobbyClubId).toBeNull();
    expect(restoreLobbyPage(previous)?.lobbyClubId).toBe('shark-club');
    expect(restoreLobbyPage(restoreLobbyPage(previous)!)).toBeNull();
  });

  it('preserves mixed arena/tournament history, including Watch query strings', () => {
    const main = {
      id: 'lobby:1',
      lobbyClubId: 'shark-club',
      lobbyTournamentId: 'main',
      lobbyTournamentStack: [{ tournamentId: 'main', search: '?watch=1' }],
    };
    const other = {
      ...rememberLobbyPage(main, 'shark-club'),
      lobbyClubId: 'other',
      lobbyTournamentId: undefined,
      lobbyTournamentStack: undefined,
    };
    expect(restoreLobbyPage(other)).toMatchObject(main);
  });

  it('freezes the club actually displayed instead of re-resolving a mutable home club on Back', () => {
    const page = rememberLobbyPage({ id: 'lobby:1' }, 'shark-club');
    expect(restoreLobbyPage({ ...page, lobbyClubId: 'other' })?.lobbyClubId).toBe('shark-club');
  });

  it('wires root lobby Back to the exact tab opened from before browser history', () => {
    const multi = read('src/pages/MultiTablePage.tsx');
    const back = multi.slice(
      multi.indexOf('const goBackInTab ='),
      multi.indexOf('const handleOpenLobbyTab =')
    );
    expect(back).toContain('lobbyReturnTabRef.current.get(cur.id)');
    expect(back.indexOf('setActiveIndex(returnIndex)')).toBeLessThan(
      back.indexOf('window.history.back()')
    );
    expect(back).not.toContain('resolveLobbyClubId');
    expect(multi).toContain('lobbyReturnTabRef.current.set(current.id, previous.id)');
  });

  it('executes the real root Back handler and returns to its originating table', () => {
    const source = read('src/pages/MultiTablePage.tsx');
    const match = source.match(
      /const goBackInTab = useCallback\((\(\) => \{[\s\S]*?\n {2}\}), \[[^\]]*\]\);/
    );
    expect(match).not.toBeNull();
    const setActiveIndex = vi.fn();
    const browserBack = vi.fn();
    const navigate = vi.fn();
    const tabs = [
      { id: 'shark-table', kind: 'table' },
      { id: 'lobby:1', kind: 'lobby' },
    ];
    const run = new Function(
      'tablesRef',
      'activeIndexRef',
      'lobbyReturnTabRef',
      'setActiveIndex',
      'setTables',
      'restoreLobbyPage',
      'popLobbyTournament',
      'isLobbyTab',
      'isTableTab',
      'navigate',
      'tableQuery',
      'window',
      `return (${match![1]});`
    )(
      { current: tabs },
      { current: 1 },
      { current: new Map([['lobby:1', 'shark-table']]) },
      setActiveIndex,
      vi.fn(),
      restoreLobbyPage,
      vi.fn(),
      (tab: { kind: string }) => tab.kind === 'lobby',
      (tab: { kind: string }) => tab.kind === 'table',
      navigate,
      () => '',
      { history: { back: browserBack } }
    );
    run();
    expect(setActiveIndex).toHaveBeenCalledWith(0);
    expect(navigate).toHaveBeenCalledWith('/table/shark-table', { replace: true });
    expect(browserBack).not.toHaveBeenCalled();
  });

  it('records the exact visible origin and clears it on entry from an outside page', () => {
    const source = read('src/pages/MultiTablePage.tsx');
    const region = source.slice(source.indexOf('const lobbyReturnTabRef ='));
    const callback = region.match(
      /useLayoutEffect\((\(\) => \{[\s\S]*?\n {2}\}), \[visibleTabId, hidden\]\);/
    )![1];
    const refs = {
      tabs: {
        current: [
          { id: 'shark', kind: 'table' },
          { id: 'lobby:1', kind: 'lobby' },
        ],
      },
      active: { current: 0 },
      pending: { current: null as number | null },
      previous: { current: null },
      returns: { current: new Map() },
    };
    const effect = (hidden: boolean) =>
      new Function(
        'tablesRef',
        'activeIndexRef',
        'pendingTabIndexRef',
        'previousVisibleTabRef',
        'lobbyReturnTabRef',
        'hidden',
        'isLobbyTab',
        `return (${callback});`
      )(
        refs.tabs,
        refs.active,
        refs.pending,
        refs.previous,
        refs.returns,
        hidden,
        (tab: { kind: string }) => tab.kind === 'lobby'
      )();
    effect(false);
    refs.active.current = 1;
    effect(false);
    expect(refs.returns.current.get('lobby:1')).toBe('shark');
    effect(true);
    // The host table is only a pre-paint route placeholder, never a visible page.
    refs.active.current = 0;
    refs.pending.current = 1;
    effect(false);
    refs.pending.current = null;
    refs.active.current = 1;
    effect(false);
    expect(refs.returns.current.has('lobby:1')).toBe(false);
  });

  it('preserves the outside page when the pinned strip opens a tab', () => {
    const multi = read('src/pages/MultiTablePage.tsx');
    const reveal = multi.slice(
      multi.indexOf('const revealPageTabOffRoute ='),
      multi.indexOf('/** One counter')
    );
    expect(reveal).toContain('navigate(`/table/${host.id}${tableQuery(host)}`);');
    expect(reveal).not.toContain('replace: true');
    const select = multi.slice(
      multi.indexOf('const handleTabSelect ='),
      multi.indexOf('// ─── Batch 3: quick-join sheet')
    );
    expect(select).toContain('if (hidden) navigate(`/table/${target.id}${tableQuery(target)}`);');
    expect(select).toContain(
      'else navigate(`/table/${target.id}${tableQuery(target)}`, { replace: true });'
    );
    expect(select).toContain('navigate(`/table/${host.id}${tableQuery(host)}`);');
  });

  it('numeric Back from an embedded page uses the same navigation owner', () => {
    const context = read('src/context/InTabLobbyContext.tsx');
    expect(context).toContain('if (to === -1) inTab.goBack()');
  });
});
