import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  serverPreActionFor,
  syncPreActionToEngine,
  type PreActionChoice,
  type PreActionReply,
  type PreActionSyncRefs,
} from '../src/lib/preActionSync';
import { lightningFoldOnTurn } from '../src/lightning/lightningActions';
import { sliceStatement } from './helpers/sourceWindow';

const HAND = '11111111-1111-4111-8111-111111111111';
const NEXT_HAND = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  hand_id: HAND,
  stage: 'preflop',
  current_player: 'peer',
  current_bet: 8,
  players: [{ user_id: 'hero', seat: 3, bet: 0, is_folded: false }],
};

function syncHarness(hand = HAND) {
  let currentHand = hand;
  const refs: PreActionSyncRefs = {
    hadPreActionRef: { current: false },
    lastArmedPreActionRef: { current: null },
    preActionCanCheckRef: { current: false },
    preActionCallAmountRef: { current: 8 },
    preActionFoldOnTurnHandRef: { current: HAND },
    preActionHeldByEngineRef: { current: null },
    preActionSendSeqRef: { current: 0 },
    lightningRoomRef: { current: {} },
  };
  const send = vi.fn(async (): Promise<PreActionReply> => ({ success: true }));
  const set = vi.fn();
  const run = (preAction: PreActionChoice | null = 'fold') =>
    syncPreActionToEngine({
      tableId: 'pool',
      preAction,
      refs,
      handNumber: () => 7,
      lightningArmHandId: () => currentHand,
      serverSetPreAction: send,
      setPreAction: set,
      toastError: vi.fn(),
      reportError: vi.fn(),
      retry: async (fn) => fn(),
    });
  return {
    refs,
    send,
    set,
    run,
    changeHand: (next: string) => {
      currentHand = next;
    },
  };
}

describe('Lightning preflop Fold waits for its own turn', () => {
  it('uses the existing queued check/fold contract without claiming checking is free', () => {
    expect(serverPreActionFor('fold', false, true)).toBe('auto_check_fold');
    expect(serverPreActionFor('fold', false)).toBe('auto_fold');
    expect(serverPreActionFor('fold', true)).toBe('auto_check_fold');
  });
  it('captures the authoritative hand, stage, actor and amount, including the free keyboard shortcut', () => {
    expect(lightningFoldOnTurn(snapshot, 'hero', 'fast_fold')).toEqual({ handId: HAND, toCall: 8 });
    expect(lightningFoldOnTurn({ ...snapshot, current_bet: 0 }, 'hero', 'fast_fold')).toEqual({
      handId: HAND,
      toCall: 0,
    });
    expect(lightningFoldOnTurn({ ...snapshot, current_player: null }, 'hero', 'fast_fold')).toEqual(
      { handId: HAND, toCall: 8 }
    );
    expect(
      lightningFoldOnTurn({ ...snapshot, current_player: 'hero' }, 'hero', 'fast_fold')
    ).toBeNull();
    expect(lightningFoldOnTurn(snapshot, 'hero', 'fold_watch')).toBeNull();
    for (const stage of ['flop', 'turn', 'river']) {
      expect(lightningFoldOnTurn({ ...snapshot, stage }, 'hero', 'fast_fold')).toEqual({
        handId: HAND,
        toCall: 8,
      });
      expect(
        lightningFoldOnTurn(
          { ...snapshot, stage, lightning: { fold_on_turn: true } },
          'hero',
          'fast_fold'
        )
      ).toBeNull();
      expect(
        lightningFoldOnTurn(
          { ...snapshot, stage, current_bet: 0, lightning: { fold_on_turn: true } },
          'hero',
          'fast_fold'
        )
      ).toEqual({ handId: HAND, toCall: 0 });
    }
    expect(lightningFoldOnTurn({ ...snapshot, stage: 'waiting' }, 'hero', 'fast_fold')).toBeNull();
    expect(
      lightningFoldOnTurn({ ...snapshot, lightning: { fold_on_turn: true } }, 'hero', 'fast_fold')
    ).toBeNull();
  });
  it('refuses incomplete preflop state instead of falling through to early release', () => {
    for (const bad of [
      { ...snapshot, hand_id: undefined },
      { ...snapshot, players: [] },
      { ...snapshot, current_bet: undefined },
      { ...snapshot, players: [{ user_id: 'hero' }] },
    ])
      expect(lightningFoldOnTurn(bad, 'hero', 'fast_fold')).toHaveProperty('error');
  });
  it('sends one hand-bound queued request while preserving the real positive price', () => {
    const t = syncHarness();
    t.run();
    expect(t.send).toHaveBeenCalledExactlyOnceWith('pool', 'auto_check_fold', undefined, HAND);
    expect(t.refs.preActionCanCheckRef.current).toBe(false);
  });
  it('does not turn an old queued fold into an immediate fold in another hand', () => {
    const t = syncHarness(NEXT_HAND);
    t.run();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.set).toHaveBeenCalledWith(null);
  });
  it('engine echoes and restored choices never send another request', () => {
    const t = syncHarness();
    t.refs.preActionHeldByEngineRef.current = 'fold';
    t.run();
    expect(t.send).not.toHaveBeenCalled();
  });
  it('an undelivered clear retains intent for an engine echo without locally rearming Lightning', async () => {
    const t = syncHarness();
    t.run();
    await Promise.resolve();
    t.send.mockResolvedValueOnce({ success: false, error: 'Server unreachable' });
    t.run(null);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(t.set).not.toHaveBeenCalledWith('fold');
    expect(t.refs.preActionFoldOnTurnHandRef.current).toBe(HAND);
    t.refs.preActionHeldByEngineRef.current = 'fold';
    t.run(); // Show an authoritative engine echo, never re-arm it.
    expect(t.send).toHaveBeenCalledTimes(2);
    t.changeHand(NEXT_HAND);
    t.run();
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.set).toHaveBeenLastCalledWith(null);
  });
  it('does not alter the non-Lightning Fold mapping', () => {
    const t = syncHarness();
    t.refs.lightningRoomRef.current = null;
    t.run();
    expect(t.send).toHaveBeenCalledExactlyOnceWith('pool', 'auto_fold', undefined, HAND);
  });
  it('the button and keyboard use the same guard before the fast-fold request', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    const start = page.indexOf('const handleLightningFold = useCallback(');
    const end = page.indexOf('lightningHotkeysRef.current =', start);
    const handler = page.slice(start, end);
    expect(
      handler.indexOf('lightningFoldOnTurn(engineSnapshotRef.current, userId, kind)')
    ).toBeLessThan(handler.indexOf('await sendLightningFold('));
    expect(handler).toMatch(/if \(queued\) \{[\s\S]*?setPreAction\('fold'\);\s*return;/);
    expect(sliceStatement(page, 'lightningHotkeysRef.current =')).toContain(
      "() => void handleLightningFold('fast_fold')"
    );
    expect(page).toContain('if (next !== null) preActionFoldOnTurnHandRef.current = null;');
  });
});
