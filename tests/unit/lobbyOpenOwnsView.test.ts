import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import { sliceCall, sliceEnclosingBlock } from '../helpers/sourceWindow';

const page = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');

/** Execute the maintained page callbacks with a deferred preference read. */
function callbacks() {
  const viewPrefsTouched = { current: false };
  const selected = { current: null as string | null };
  const panel = { current: false };
  const tab = { current: 'ALL' };
  let deliver!: (prefs: { tab: string }) => void;
  const scope = {
    viewPrefsTouched,
    viewPrefsOwner: { current: 'club' },
    resolvedClubId: 'club',
    currentUser: { id: 'viewer' },
    cancelled: false,
    setViewPrefs: vi.fn(),
    applyView: (prefs: { tab: string }) => {
      tab.current = prefs.tab;
    },
    saveViewPrefs: vi.fn(),
    useCallback: (fn: unknown) => fn,
    haptic: { selection: vi.fn() },
    browseJourney: { current: { start: Date.now(), selected: false } },
    capture: vi.fn(),
    setSelectedId: (id: string) => {
      selected.current = id;
    },
    setPanelOpen: (open: boolean) => {
      panel.current = open;
    },
    preloadRoute: vi.fn(),
    warmTable: vi.fn(),
    openTournamentLobby: vi.fn(),
    tableService: { resolveTournamentLiveTable: vi.fn().mockResolvedValue(null) },
  };
  Object.defineProperties(scope, {
    panelOpen: { get: () => panel.current },
    selectedId: { get: () => selected.current },
    selectedEntry: {
      configurable: true,
      get: () => (tab.current === 'ALL' && selected.current ? { id: selected.current } : null),
    },
  });
  const execute = (source: string, result: string) => {
    const js = transpileModule(source, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    return new Function('scope', `with(scope) { ${js}; return ${result}; }`)(scope);
  };
  const open = execute(
    `const openEntry = ${sliceCall(page.slice(page.indexOf('const openEntry =')), 'useCallback(')};`,
    'openEntry'
  );
  const remote = sliceEnclosingBlock(page, 'if (cancelled || !remote) return;');
  // This is the actual async completion body, not a copy of its guards.
  const accept = execute(`const accept = (remote) => ${remote};`, 'accept');
  const receive = new Promise<{ tab: string }>((done) => {
    deliver = done;
  }).then(accept);
  const pendingGameRef = { current: 'nlh-game' as string | null };
  Object.assign(scope, {
    urlSyncEnabled: true,
    pendingGameRef,
    lobbyEntries: [{ id: 'nlh-game' }],
  });
  const reopen = () =>
    execute(sliceEnclosingBlock(page, 'const id = pendingGameRef.current;'), 'undefined');
  const closeMissing = () =>
    execute(
      sliceEnclosingBlock(page, 'if (panelOpen && selectedId && !selectedEntry)'),
      'undefined'
    );
  return {
    closeMissing,
    scope,
    open,
    reopen,
    tab,
    selected,
    panel,
    receive,
    deliver: (value: { tab: string }) => deliver(value),
  };
}

describe('a game selection owns the lobby view while preferences arrive', () => {
  it('keeps an explicitly opened cash card when a late saved tab would hide its row', async () => {
    const t = callbacks();
    t.open({ id: 'nlh-game', kind: 'cash' });
    t.deliver({ tab: 'OMAHA' });
    await t.receive;
    t.closeMissing();
    expect(t.tab.current).toBe('ALL');
    expect(t.selected.current).toBe('nlh-game');
    expect(t.panel.current).toBe(true);
    expect(t.scope.warmTable).toHaveBeenCalledWith('nlh-game');
  });

  it('keeps a game opened from a shared link when saved preferences arrive later', async () => {
    const t = callbacks();
    t.reopen();
    t.deliver({ tab: 'OMAHA' });
    await t.receive;
    t.closeMissing();
    expect(t.tab.current).toBe('ALL');
    expect(t.selected.current).toBe('nlh-game');
    expect(t.panel.current).toBe(true);
  });

  it('still closes a selected card when its row is removed', () => {
    const t = callbacks();
    t.open({ id: 'removed-game', kind: 'cash' });
    Object.defineProperty(t.scope, 'selectedEntry', { get: () => null });
    t.closeMissing();
    expect(t.panel.current).toBe(false);
  });

  it('still restores a saved view before the viewer makes a selection', async () => {
    const t = callbacks();
    t.deliver({ tab: 'OMAHA' });
    await t.receive;
    expect(t.tab.current).toBe('OMAHA');
    expect(t.panel.current).toBe(false);
  });
});
