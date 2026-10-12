/**
 * LIGHTNING PHASE 12 (client): the render acknowledgement behind the
 * "hand creation -> first client render" latency leg, the Lightning hotkeys
 * and fold cue the capability row declares, and the first-hand path.
 *
 *   - RENDER_ACK carries a hand id and a bounded delta, never a card; it is
 *     sent once per hand, after the hand is painted, on the table socket.
 *   - HOTKEYS (spec HOTKEYS): safe modifier combinations only - Shift+F is
 *     LIGHTNING FOLD, Shift+V is FOLD & WATCH - running the fold strip's own
 *     handler (the engine validates every fold), only where the platform row
 *     offers hotkeys; plain F is untouched.
 *   - SOUND (spec SOUND SYSTEM): an accepted LIGHTNING FOLD / FOLD & WATCH
 *     plays the fold cue through the priority gate, on the table in front only.
 *   - JOIN -> HAND: the hand-off follows the chair the moment the pool session
 *     exists; it never waits on the Cluster's felt metadata.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { sliceEnclosingBlock, sliceMethod } from '../helpers/sourceWindow';
import {
  LIGHTNING_RENDER_ACK_MAX_DELTA_MS,
  lightningRenderAckFrame,
  scheduleLightningRenderAck,
} from '../../src/lightning/lightningRenderAck';
import { useTableKeyboard, type UseTableKeyboardOptions } from '../../src/hooks/useTableKeyboard';
import {
  LIGHTNING_CAPABILITY_MAP,
  lightningCapabilities,
} from '../../src/lightning/lightningCapabilities';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const HAND = '44444444-4444-4444-8444-444444444444';
const ROOM = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.useRealTimers();
});

describe('the render acknowledgement (hand creation → first client render)', () => {
  it('is a hand id and a bounded whole-millisecond delta, nothing else, never a card', () => {
    const f = lightningRenderAckFrame(ROOM, HAND, 12.6);
    expect(f).toEqual({ type: 'RENDER_ACK', tableId: ROOM, hand_id: HAND, d: 13 });
    expect(Object.keys(f).sort()).toEqual(['d', 'hand_id', 'tableId', 'type']);
    expect(JSON.stringify(f)).not.toMatch(/card|hole|rank|suit|seat|stack|amount/i);
    expect(lightningRenderAckFrame(ROOM, HAND, -5).d).toBe(0);
    expect(lightningRenderAckFrame(ROOM, HAND, 1e9).d).toBe(LIGHTNING_RENDER_ACK_MAX_DELTA_MS);
    expect(lightningRenderAckFrame(ROOM, HAND, Number.NaN).d).toBe(0);
  });

  it('acknowledges once, after the next painted frame; a cancelled hand sends nothing', async () => {
    const send = vi.fn();
    let t = 100;
    const cancel = scheduleLightningRenderAck(HAND, send, () => t);
    t = 117;
    await new Promise((r) => setTimeout(r, 40));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(HAND, 17);
    cancel();
    const never = vi.fn();
    const stop = scheduleLightningRenderAck(HAND, never);
    stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(never).not.toHaveBeenCalled();
  });

  it('the socket client sends RENDER_ACK only on an open socket, with the hand id and the delta only', () => {
    const src = read('src/services/EngineStateClient.ts');
    const body = sliceMethod(src, 'sendRenderAck(handId: string, deltaMs: number): void {');
    expect(body).toContain('this.ws?.readyState !== 1');
    expect(body).toMatch(
      /JSON\.stringify\(\s*\{ type: 'RENDER_ACK', tableId: this\.opts\.tableId, hand_id: handId, d \}\s*\)/
    );
    expect(body).not.toMatch(/card|hole|seat|stack/i);
    expect(read('src/hooks/useEngineTableState.ts')).toContain(
      'clientRef.current?.sendRenderAck(handId, deltaMs)'
    );
  });

  it('a Lightning room acknowledges each hand once, on its own socket', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('sendRenderAck: sendEngineRenderAck,');
    expect(page).toMatch(
      /const lightningRenderHandId = lightningRoom\s*\?\s*lightningHandId\(engineSnapshot as LightningSnapshotFields\)\s*:\s*null;/
    );
    const effect = sliceEnclosingBlock(
      page,
      'scheduleLightningRenderAck(lightningRenderHandId',
      0,
      1
    );
    expect(effect).toContain('lightningRenderAckedRef.current === lightningRenderHandId');
    expect(effect).toContain('sendEngineRenderAck(handId, deltaMs)');
  });
});

describe('Lightning hotkeys (spec HOTKEYS): safe modifiers, the strip’s own handler', () => {
  function mount(extra: Partial<UseTableKeyboardOptions>) {
    const opts: UseTableKeyboardOptions = {
      isActive: true,
      isHeroTurn: true,
      isSpectator: false,
      isModalOpen: false,
      isSizingOpen: false,
      onFold: vi.fn(),
      onCallCheck: vi.fn(),
      ...extra,
    };
    const hook = renderHook(() => useTableKeyboard(opts));
    return { opts, unmount: hook.unmount };
  }
  const press = (key: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

  it('Shift+F is LIGHTNING FOLD and Shift+V is FOLD & WATCH; neither is also a plain fold or call', () => {
    const onLightningFold = vi.fn();
    const onLightningFoldWatch = vi.fn();
    const { opts, unmount } = mount({ onLightningFold, onLightningFoldWatch });
    press('F', { shiftKey: true });
    press('V', { shiftKey: true });
    expect(onLightningFold).toHaveBeenCalledTimes(1);
    expect(onLightningFoldWatch).toHaveBeenCalledTimes(1);
    expect(opts.onFold).not.toHaveBeenCalled();
    // The single-letter row is unchanged.
    press('f');
    expect(opts.onFold).toHaveBeenCalledTimes(1);
    expect(onLightningFold).toHaveBeenCalledTimes(1);
    // Never with another modifier, never on a table the player is not looking at.
    press('F', { shiftKey: true, ctrlKey: true });
    expect(onLightningFold).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('before the turn too (the engine decides), never while a dialog owns the keyboard', () => {
    const onLightningFold = vi.fn();
    const a = mount({ isHeroTurn: false, onLightningFold });
    press('F', { shiftKey: true });
    expect(onLightningFold).toHaveBeenCalledTimes(1);
    a.unmount();
    const b = mount({ isModalOpen: true, onLightningFold });
    press('F', { shiftKey: true });
    expect(onLightningFold).toHaveBeenCalledTimes(1);
    b.unmount();
    const c = mount({ isActive: false, onLightningFold });
    press('F', { shiftKey: true });
    expect(onLightningFold).toHaveBeenCalledTimes(1);
    c.unmount();
  });

  it('outside a Lightning room nothing changes: Shift+F is still an ordinary F', () => {
    const { opts, unmount } = mount({});
    press('F', { shiftKey: true });
    expect(opts.onFold).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('the capability row is honoured: desktop offers hotkeys, handhelds do not; the page gates on it', () => {
    expect(LIGHTNING_CAPABILITY_MAP.desktop.hotkeys).toBe(true);
    expect(lightningCapabilities('mobile_web').hotkeys).toBe(false);
    expect(lightningCapabilities('ios').hotkeys).toBe(false);
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/lightningHotkeysRef\.current = lightningCaps\.hotkeys\s*\?/);
    expect(page).toContain(
      "fold: lightningFold.fastFold ? () => void handleLightningFold('fast_fold') : null,"
    );
    expect(page).toContain('lightningCaps.fold_and_watch && lightningFold.foldWatch');
    expect(page).toMatch(
      /onLightningFold: lightningRoom \? \(\) => lightningHotkeysRef\.current\.fold\?\.\(\) : undefined,/
    );
  });
});

describe('the fold cue (spec SOUND SYSTEM)', () => {
  it('an accepted LIGHTNING FOLD plays the fold cue, gated on the row, the switch and the table in front', () => {
    const page = read('src/pages/TablePage.tsx');
    const handler = sliceEnclosingBlock(
      page,
      'await sendLightningFold(tableId, userId, kind)',
      0,
      1
    );
    expect(handler).toMatch(
      /lightningCaps\.sound &&\s*soundService\.isEnabled\(\) &&\s*\(isActive \|\| !isMultiTable\)\s*\)\s*\{\s*soundService\.playFold\(\);/
    );
    expect(LIGHTNING_CAPABILITY_MAP.desktop.sound).toBe(true);
    expect(lightningCapabilities('android').sound).toBe(true);
  });
});

describe('JOIN → HAND: no avoidable round trip, no technical loading text', () => {
  it('the hand-off follows the chair at once; the felt metadata is never waited for there', () => {
    const src = read('src/lightning/useLightningAnchorHandoff.ts');
    const found = sliceEnclosingBlock(src, 'followRef.current(poolSessionId);', 0, 1);
    expect(found).not.toMatch(/await/);
    expect(found).toContain('registerLightningPoolSession({ poolSessionId, clusterId, meta });');
  });

  it('no Lightning surface says what the machinery is doing', () => {
    const files = [
      'src/lightning/useLightningAnchorHandoff.ts',
      'src/lightning/lightningRenderAck.ts',
      'src/pages/LightningEntryPage.tsx',
      'src/components/table/LightningJoining.tsx',
      'src/components/table/LightningNextHand.tsx',
      'src/lightning/lightningHand.ts',
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(
        /finding table|matching server|epoch init|matcher init|connecting to matcher/i
      );
    }
  });
});
