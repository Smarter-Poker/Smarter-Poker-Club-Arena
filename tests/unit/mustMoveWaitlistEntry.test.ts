import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sliceCall, sliceMethod } from '../helpers/sourceWindow';

const source = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const handler = sliceMethod(source, 'const handleOpenWaitlist = useCallback(() => {');

describe('the full Must-Move table reaches its game entry door', () => {
  it.each(['game-1', null])('routes cluster=%s to the appropriate existing lobby', (clusterId) => {
    const body = handler.slice(handler.indexOf('{') + 1, handler.lastIndexOf('}'));
    const loadWaitlist = vi.fn();
    const setShowWaitList = vi.fn();
    const setShowMustMoveLobby = vi.fn();
    const open = new Function(
      'tableState',
      'loadWaitlist',
      'setShowWaitList',
      'setShowMustMoveLobby',
      body
    );
    open({ clusterId }, loadWaitlist, setShowWaitList, setShowMustMoveLobby);
    if (clusterId) {
      expect(setShowMustMoveLobby).toHaveBeenCalledExactlyOnceWith(true);
      expect(loadWaitlist).not.toHaveBeenCalled();
      expect(setShowWaitList).not.toHaveBeenCalled();
    } else {
      expect(loadWaitlist).toHaveBeenCalledOnce();
      expect(setShowWaitList).toHaveBeenCalledExactlyOnceWith(true);
      expect(setShowMustMoveLobby).not.toHaveBeenCalled();
    }
  });

  it('refreshes the handler when the game changes and keeps the footer connected', () => {
    expect(source).toContain('}, [loadWaitlist, tableState.clusterId]);');
    expect(source).toMatch(
      /className="spectator-footer-bar__cta"\s+onClick=\{handleOpenWaitlist\}/
    );
  });
});

describe('the club card and detail panel use the whole game queue', () => {
  const home = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
  // Execute the actual callback wired to the detail panel, including the old
  // ordinary-table callback on the regression baseline.
  const wired = home.match(/onWaitlistToggle=\{(handle\w+)\}/)![1];
  const callback = sliceCall(home, `const ${wired} = useCallback(`);
  const body = callback.slice(callback.indexOf('{') + 1, callback.lastIndexOf('}'));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  it.each([
    { cluster_id: 'game', cluster_must_move: true, joining: true, game: true },
    { cluster_id: 'game', cluster_must_move: undefined, joining: true, game: true },
    { cluster_id: null, joining: true, game: false },
    { cluster_id: 'game', cluster_must_move: false, joining: true, game: false },
    { cluster_id: 'game', cluster_must_move: true, joining: false, game: false },
  ])('routes the card action by its actual parent (%j)', async (entry) => {
    const handleJoinTable = vi.fn();
    const ordinaryJoin = vi.fn().mockResolvedValue({ id: 'entry' });
    const ordinaryLeave = vi.fn().mockResolvedValue(true);
    const handleWaitlistToggle = vi.fn((id, joining) =>
      joining ? ordinaryJoin(id) : ordinaryLeave(id)
    );
    const context = {
      tableId: 'table',
      joining: entry.joining,
      tablesRef: { current: [{ id: 'table', ...entry }] },
      handleJoinTable,
      handleWaitlistToggle,
      waitlistActionBusyRef: { current: false },
      currentUserId: 'player',
      toast: { error: vi.fn(), success: vi.fn() },
      setWaitlistActionBusy: vi.fn(),
      haptic: { selection: vi.fn() },
      setWaitlistedTableIds: vi.fn(),
      waitlistService: {
        joinWaitlist: ordinaryJoin,
        getPosition: vi.fn().mockResolvedValue(null),
        leave: ordinaryLeave,
      },
      reportError: vi.fn(),
    };
    await new AsyncFunction(...Object.keys(context), body)(...Object.values(context));
    if (entry.game) {
      expect(handleJoinTable).toHaveBeenCalledExactlyOnceWith('table');
      expect(ordinaryJoin).not.toHaveBeenCalled();
      expect(handleWaitlistToggle).not.toHaveBeenCalled();
    } else {
      expect(handleJoinTable).not.toHaveBeenCalled();
      expect(entry.joining ? ordinaryJoin : ordinaryLeave).toHaveBeenCalledExactlyOnceWith('table');
    }
  });

  it('both club entry surfaces call this same route', () => {
    expect(wired).toBe('handleLobbyWaitlistToggle');
    expect(home).toMatch(
      /onWaitlistToggle: \(tableId: string, joining: boolean\) =>\s*handleLobbyWaitlistToggle\(tableId, joining\)/
    );
  });
});

describe('a club game join belongs to its opening', () => {
  const home = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
  const handler = sliceCall(home, 'const handleJoinTable = useCallback(');
  const body = handler.slice(handler.indexOf('{') + 1, handler.lastIndexOf('}'));
  const setup = () => {
    let resolve!: (value: unknown) => void;
    const reply = new Promise((done) => {
      resolve = done;
    });
    const context = {
      tableId: 'main',
      tablesRef: { current: [{ id: 'main', cluster_id: 'game' }] },
      gameEntryScope: { active: true, busy: false },
      haptic: { medium: vi.fn() },
      setPanelOpen: vi.fn(),
      joinCashGame: vi.fn().mockReturnValue(reply),
      warmTable: vi.fn(),
      navigate: vi.fn(),
      toast: { info: vi.fn(), warning: vi.fn() },
      waitlistedText: () => 'Queue Place',
      reportError: vi.fn(),
      joinGameRefusalText: () => 'Refused',
    };
    const join = () => new Function(...Object.keys(context), body)(...Object.values(context));
    const settle = async (value: unknown) => {
      resolve(value);
      await reply;
      await Promise.resolve();
    };
    return { context, join, settle };
  };
  it('does not navigate or notify after the initiating club or account has gone', async () => {
    const { context, join, settle } = setup();
    join();
    context.gameEntryScope.active = false;
    await settle({ ok: true, action: 'seat', table_id: 'feeder' });
    expect(context.navigate).not.toHaveBeenCalled();
    expect(context.warmTable).not.toHaveBeenCalled();
    expect(context.toast.info).not.toHaveBeenCalled();
  });
  it('sends one request for a double tap and keeps the server destination', async () => {
    const { context, join, settle } = setup();
    join();
    join();
    expect(context.joinCashGame).toHaveBeenCalledExactlyOnceWith('game');
    await settle({ ok: true, action: 'seat', table_id: 'feeder' });
    expect(context.navigate).toHaveBeenCalledExactlyOnceWith('/table/feeder');
    expect(context.gameEntryScope.busy).toBe(false);
  });
  it('a confirmed queue place still opens the game for watching', async () => {
    const { context, join, settle } = setup();
    join();
    await settle({ ok: true, action: 'waitlisted', position: 2 });
    expect(context.toast.info).toHaveBeenCalledWith('Queue Place');
    expect(context.navigate).toHaveBeenCalledExactlyOnceWith('/table/main');
  });
  it('the callback is replaced and retired for club, account, and unmount changes', () => {
    expect(home).toMatch(/const gameEntryScope = useMemo\([\s\S]*?\[clubId, currentUserId\]\)/);
    expect(sliceCall(home, 'useEffect(() => {\n    gameEntryScope.active = true;')).toContain(
      'gameEntryScope.active = false'
    );
    expect(handler).toContain('[navigate, toast, gameEntryScope]');
  });
});
