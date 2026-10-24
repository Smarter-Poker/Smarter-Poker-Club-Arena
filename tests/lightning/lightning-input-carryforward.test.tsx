import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useTableKeyboard } from '../../src/hooks/useTableKeyboard';
import { lightningShortcut, lightningShortcutRoom } from '../../src/lightning/lightningShortcuts';
import { createLightningMilestoneTracker } from '../../src/lightning/lightningMilestone';
import { readLightningPrefs, writeLightningPrefs } from '../../src/lightning/lightningPrefs';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const key = (extra: Partial<KeyboardEvent> = {}) => ({
  key: 'N',
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  ...extra,
});
const decision = (room: string, deadline: number) => ({
  poolSessionId: room,
  handId: room,
  street: 'preflop',
  deadlineAt: deadline,
});

describe('manual Lightning navigation', () => {
  it('configures both safe profiles and refuses ordinary, held, IME and browser keys', () => {
    expect(lightningShortcut(key(), 'shift')).toBe('nextUrgent');
    expect(lightningShortcut(key({ altKey: true }), 'alt_shift')).toBe('nextUrgent');
    for (const extra of [
      { shiftKey: false },
      { repeat: true },
      { isComposing: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ])
      expect(lightningShortcut(key(extra), 'shift')).toBeNull();
    expect(lightningShortcut(key(), 'off')).toBeNull();
  });
  it('uses server deadlines, mounted rooms and the user chosen current room', () => {
    const owed = [
      decision('b', 200),
      decision('a', 150),
      decision('expired', 10),
      decision('closed', 120),
    ];
    expect(lightningShortcutRoom('nextUrgent', ['a', 'b', 'c'], 'a', owed, 100)).toBe('b');
    expect(lightningShortcutRoom('nextUrgent', ['a', 'b', 'c'], 'b', owed, 100)).toBe('a');
    expect(lightningShortcutRoom('focus', ['a', 'b', 'c'], 'b', owed, 100)).toBe('b');
    expect(lightningShortcutRoom('focus', ['a', 'b', 'c'], 'c', owed, 100)).toBe('a');
    expect(lightningShortcutRoom('focus', ['a'], 'a', owed, 250)).toBeNull();
    expect(lightningShortcutRoom('previous', ['a', 'b', 'c'], 'a', owed, 100)).toBe('c');
    expect(lightningShortcutRoom('previous', [], null, owed, 100)).toBeNull();
  });
  it('the real table listener runs one strip callback and honors preferences and guards', () => {
    const fold = vi.fn(),
      ordinaryFold = vi.fn();
    function Keyboard({ active = true, modal = false }: { active?: boolean; modal?: boolean }) {
      useTableKeyboard({
        isActive: active,
        isHeroTurn: true,
        isSpectator: false,
        isModalOpen: modal,
        isSizingOpen: false,
        onLightningFold: fold,
        onFold: ordinaryFold,
      });
      return <input aria-label="Chat" />;
    }
    const view = render(<Keyboard />);
    fireEvent.keyDown(window, key({ key: 'F' }));
    expect(fold).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, key({ key: 'F', repeat: true }));
    fireEvent.keyDown(screen.getByLabelText('Chat'), key({ key: 'F' }));
    view.rerender(<Keyboard modal />);
    fireEvent.keyDown(window, key({ key: 'F' }));
    view.rerender(<Keyboard active={false} />);
    fireEvent.keyDown(window, key({ key: 'F' }));
    view.rerender(<Keyboard />);
    writeLightningPrefs({ shortcutModifier: 'alt_shift' });
    fireEvent.keyDown(window, key({ key: 'F' }));
    fireEvent.keyDown(window, key({ key: 'F', altKey: true }));
    expect(fold).toHaveBeenCalledTimes(2);
    writeLightningPrefs({ shortcutModifier: 'off' });
    fireEvent.keyDown(window, key({ key: 'F' }));
    expect(fold).toHaveBeenCalledTimes(2);
    expect(ordinaryFold).not.toHaveBeenCalled();
  });
});

describe('optional event-owned milestone', () => {
  it('fires once at a configured boundary, ignores snapshots and replay, resets a different room', () => {
    const tracker = createLightningMilestoneTracker();
    const event = (n: number, room = 'a') => ({
      type: 'hand_started',
      table_id: room,
      hand_number: n,
      timestamp: 1000 + n,
    });
    expect(tracker.note('a', { type: 'snapshot', hand_number: 100, timestamp: 1 }, 100)).toBe(
      false
    );
    for (let n = 1; n < 100; n++) expect(tracker.note('a', event(n), 100)).toBe(false);
    expect(tracker.note('a', event(100), 100)).toBe(true);
    for (let n = 1; n <= 100; n++) expect(tracker.note('a', event(n), 100)).toBe(false);
    // A stale event from the old room cannot seed the replacement visit.
    expect(tracker.note('b', event(100), 100)).toBe(false);
    expect(tracker.note('b', event(100, 'b'), 100)).toBe(false);
    for (let n = 101; n <= 200; n++) expect(tracker.note('b', event(n, 'b'), 0)).toBe(false);
    expect(tracker.note('b', { type: 'hand_started' }, 100)).toBe(false);
  });
  it('the maintained hand event and low-priority, muted sound are connected', () => {
    const table = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    const sound = readFileSync(resolve(__dirname, '../../src/services/SoundService.ts'), 'utf8');
    const branch = table.slice(
      table.indexOf("case 'HAND_STARTED':"),
      table.indexOf("case 'BLINDS_POSTED':")
    );
    expect(branch).toContain('lightningMilestoneRef.current.note');
    expect(branch).toContain('pendingLightningDecisions().some');
    expect(branch).toContain('!document.hidden');
    expect(branch).toContain('ambientSoundsAllowed');
    expect(table).toContain('const ambientSoundsAllowed = (!isMultiTable || isActive) && !muted');
    expect(branch).toContain('soundService.playLightningMilestone()');
    expect(
      sound.slice(sound.indexOf('playLightningMilestone() {'), sound.indexOf('playChatMessage() {'))
    ).toContain("this.shouldPlay('ui', 'event')");
  });
});

describe('real preferences surface', () => {
  it('keeps the choice for this visit if storage is blocked and rejects corrupt values', () => {
    writeLightningPrefs({ milestoneHands: 500 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    writeLightningPrefs({ shortcutModifier: 'off', milestoneHands: 100 });
    expect(readLightningPrefs()).toMatchObject({ shortcutModifier: 'off', milestoneHands: 100 });
    expect(writeLightningPrefs({ milestoneHands: -1 })).toMatchObject({ milestoneHands: 0 });
  });
});

// The Stage 0 checklist must retain separate proof authority.
it('readiness evidence never claims its unevaluated proofs passed', () => {
  const plan = readFileSync(resolve(__dirname, '../../docs/lightning/ROLLOUT.md'), 'utf8');
  expect(plan).toContain('`proofs_evaluated_in_sql` must remain false');
  expect(plan).toContain('Separate exact installed-migration proof readback is required');
  expect(plan).not.toContain('every `invariants` key true');
});
