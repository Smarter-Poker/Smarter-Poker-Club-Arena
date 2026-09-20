/**
 * ONE KEYBOARD, ONE TABLE — the keys may only reach the table in front.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MultiTablePage keeps up to four TablePage instances MOUNTED at once, and each
 * one mounted its own `window` keydown listener. Nothing consulted which table
 * the player was looking at.
 *
 * So a player with action on two tables — the ordinary case when multi-tabling —
 * pressed F once and FOLDED BOTH HANDS, into two different pots. `C` called
 * both. Each table has its own `actionLockRef`, so the debounce that protects a
 * single table against a double-tap cannot see the other table at all and never
 * had a chance of catching this.
 *
 * `M` was the quiet version of the same bug: it toggled the sound once per open
 * table, so with two or four tables open mute did nothing whatsoever.
 *
 * TablePage ALSO carried a second, near-duplicate keydown listener of its own
 * handling F/Q, C/W, R/E and A, so on the active table every one of those keys
 * ran two code paths per press. That listener is deleted; this hook is the only
 * keyboard system on the table now, and these tests are what keeps it that way.
 *
 * These tests drive the hook directly rather than TablePage, because the thing
 * being pinned is the hook's contract: `isActive` gates everything, and there is
 * exactly one listener per mounted instance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { useTableKeyboard, type UseTableKeyboardOptions } from '../../src/hooks/useTableKeyboard';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const TABLE_TSX = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

/** Execute the actual TablePage wiring without mounting its unrelated services. */
function keyboardProperty(name: string): ts.Expression {
  const source = ts.createSourceFile(
    'TablePage.tsx',
    TABLE_TSX,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let object: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useTableKeyboard') {
      const argument = node.arguments[0];
      if (ts.isObjectLiteralExpression(argument)) object = argument;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const property = object?.properties.find((item) => item.name?.getText(source) === name);
  if (!property || !ts.isPropertyAssignment(property))
    throw new Error(`Missing keyboard option ${name}`);
  return property.initializer;
}

/** A table where hero is seated, in a hand, and on the clock. */
function opts(over: Partial<UseTableKeyboardOptions> = {}): UseTableKeyboardOptions {
  return {
    isActive: true,
    isHeroTurn: true,
    isSpectator: false,
    isModalOpen: false,
    isSizingOpen: false,
    ...over,
  };
}

const press = (key: string) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('the keyboard reaches only the table the player is looking at', () => {
  let onFold: ReturnType<typeof vi.fn>;
  let onCallCheck: ReturnType<typeof vi.fn>;
  let onToggleSound: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onFold = vi.fn();
    onCallCheck = vi.fn();
    onToggleSound = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('folds the active table', () => {
    renderHook(() => useTableKeyboard(opts({ onFold })));
    press('f');
    expect(onFold).toHaveBeenCalledTimes(1);
  });

  it('blocks betting shortcuts while the actual Must Move lobby flag is open', () => {
    const expression = keyboardProperty('isModalOpen');
    const flags: Record<string, boolean> = { showMustMoveLobby: true };
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) flags[node.text] = node.text === 'showMustMoveLobby';
      ts.forEachChild(node, visit);
    };
    visit(expression);
    const modalOpen = () =>
      Function(...Object.keys(flags), `return (${expression.getText()})`)(...Object.values(flags));
    const onAction = vi.fn();
    const { rerender } = renderHook(() =>
      useTableKeyboard(
        opts({
          isModalOpen: modalOpen(),
          isSizingOpen: true,
          onFold: onAction,
          onCallCheck: onAction,
          onRaise: onAction,
          onAllIn: onAction,
          onBetPreset: onAction,
          onRabbitHunt: onAction,
        })
      )
    );
    for (const key of ['f', 'q', 'c', 'w', 'r', 'e', 'a', '1', '2', '3', '4', 'b']) press(key);
    expect(onAction).not.toHaveBeenCalled();
    flags.showMustMoveLobby = false;
    rerender();
    press('f');
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('closes Must Move through the shared Escape handler without hiding a pending buy-in', () => {
    const expression = keyboardProperty('onClosePanel');
    const callbacks: Record<string, ReturnType<typeof vi.fn>> = { setShowMustMoveLobby: vi.fn() };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        callbacks[node.expression.text] = vi.fn();
      ts.forEachChild(node, visit);
    };
    visit(expression);
    const close = Function(
      ...Object.keys(callbacks),
      'seatFirstPending',
      `return (${expression.getText()})`
    )(...Object.values(callbacks), true);
    renderHook(() => useTableKeyboard(opts({ isModalOpen: true, onClosePanel: close })));
    press('Escape');
    expect(callbacks.setShowMustMoveLobby).toHaveBeenCalledWith(false);
    expect(callbacks.setSeatFirstConfirm).not.toHaveBeenCalled();
  });

  it('does NOT fold a table the player is not looking at', () => {
    // The bug, in one assertion. Same hand state, same hero turn — the only
    // difference is that this table is not in front.
    renderHook(() => useTableKeyboard(opts({ isActive: false, onFold })));
    press('f');
    expect(onFold).not.toHaveBeenCalled();
  });

  it('folds exactly one hand when four tables are mounted and hero acts on two', () => {
    const folds = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    // Tables 0 and 1 both have hero on the clock; the player is looking at 0.
    renderHook(() => useTableKeyboard(opts({ isActive: true, onFold: folds[0] })));
    renderHook(() => useTableKeyboard(opts({ isActive: false, onFold: folds[1] })));
    renderHook(() =>
      useTableKeyboard(opts({ isActive: false, isHeroTurn: false, onFold: folds[2] }))
    );
    renderHook(() =>
      useTableKeyboard(opts({ isActive: false, isHeroTurn: false, onFold: folds[3] }))
    );

    press('f');

    expect(folds[0]).toHaveBeenCalledTimes(1);
    expect(folds[1]).not.toHaveBeenCalled();
    expect(folds[2]).not.toHaveBeenCalled();
    expect(folds[3]).not.toHaveBeenCalled();
  });

  it('toggles the sound once, not once per open table', () => {
    // With an even number of tables the old behaviour made mute a no-op.
    const toggles = [vi.fn(), vi.fn()];
    renderHook(() => useTableKeyboard(opts({ isActive: true, onToggleSound: toggles[0] })));
    renderHook(() => useTableKeyboard(opts({ isActive: false, onToggleSound: toggles[1] })));
    press('m');
    expect(toggles[0]).toHaveBeenCalledTimes(1);
    expect(toggles[1]).not.toHaveBeenCalled();
  });

  it('carries both alias rows, F/C/R/A and Q/W/E, on one listener', () => {
    // Q/W/E used to live in TablePage's own duplicate listener. Both rows must
    // work, and each key must fire its action exactly once.
    const onRaise = vi.fn();
    renderHook(() => useTableKeyboard(opts({ onFold, onCallCheck, onRaise })));
    press('f');
    press('q');
    press('c');
    press('w');
    press('r');
    press('e');
    expect(onFold).toHaveBeenCalledTimes(2);
    expect(onCallCheck).toHaveBeenCalledTimes(2);
    expect(onRaise).toHaveBeenCalledTimes(2);
  });

  it('leaves the number row to the table switcher until a bet is being sized', () => {
    /* MultiTablePage binds 1..4 to "switch to table N" on the same `window`.
       Both listeners see the key, so a preset that fires unconditionally armed a
       half-pot raise on the table being left. Presets size a bet that is already
       open; they do not open one. */
    const onBetPreset = vi.fn();
    const { unmount } = renderHook(() =>
      useTableKeyboard(opts({ isSizingOpen: false, onBetPreset }))
    );
    press('2');
    expect(onBetPreset).not.toHaveBeenCalled();
    unmount();

    renderHook(() => useTableKeyboard(opts({ isSizingOpen: true, onBetPreset })));
    press('2');
    expect(onBetPreset).toHaveBeenCalledWith(1); // 0=1/3, 1=1/2, 2=3/4, 3=pot
  });

  it('does not let a number key be swallowed when it is not a preset', () => {
    // If the hook called preventDefault and returned, the table switch would
    // still run (it does not read defaultPrevented) — but a future handler
    // might. Not consuming a key you are not acting on is the rule.
    renderHook(() => useTableKeyboard(opts({ isSizingOpen: false, onBetPreset: vi.fn() })));
    const ev = new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useTableKeyboard(opts({ onFold })));
    unmount();
    press('f');
    expect(onFold).not.toHaveBeenCalled();
  });
});

describe('TablePage has no second keyboard system', () => {
  /* Stripped of comments: this file quotes the deleted listener at length in a
     gravestone, and a naive grep would match the description of the bug. */
  const code = TABLE_TSX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('registers no keydown listener of its own', () => {
    expect(code).not.toMatch(/addEventListener\(\s*['"`]keydown/);
  });

  it('passes isActive, so the hook can tell which table is in front', () => {
    expect(code).toMatch(/useTableKeyboard\(\{[\s\S]{0,400}?isActive/);
  });

  it('feeds the hook the GUARDED hero-turn predicate, not a second copy', () => {
    /* The inlined copy was `currentPlayerSeat === heroSeat && isHandInProgress`
       with no `> 0` guards. Between hands both fields are 0, so `0 === 0` made
       it true and the number row armed a raise on a table where hero had no
       hand — the same false-trigger the note on isHeroTurnContext documents. */
    expect(code).toMatch(/isHeroTurn:\s*isHeroTurnContext/);
  });

  it('routes fold and check-call through the same function the buttons use', () => {
    // handleFold / handleCall were a parallel implementation that skipped the
    // VPIP/PFR counting inside handleActionPanelAction, so a keyboard player's
    // own HUD stats under-counted every hand they played that way.
    expect(code).toMatch(/onFold:\s*\(\)\s*=>\s*void handleActionPanelAction\('fold'\)/);
    expect(code).toMatch(
      /handleActionPanelAction\(canCheckRightNow\(\)\s*\?\s*'check'\s*:\s*'call'\)/
    );
    expect(code).not.toMatch(/const handleFold\s*=/);
    expect(code).not.toMatch(/const handleCall\s*=/);
  });
});

describe('nothing app-wide is written by four tables at once (2026-08-28)', () => {
  const code = TABLE_TSX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ENV_TS = readFileSync(
    resolve(__dirname, '../../src/hooks/useTableEnvironment.ts'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('guards every MasterBus toast on tableId', () => {
    /* MasterBus is app-wide and four TablePages subscribe to it, so an
       unguarded handler fires once per open table — four identical toasts for
       one rakeback. Both emitters stamp `tableId` onto the payload for exactly
       this purpose; RAKEBACK_DISTRIBUTED and TABLE_BALANCE_EXECUTED were the
       only two subscriptions in the block that did not read it. The Toast
       layer's dedup was hiding it, which is why it survived. */
    for (const evt of ['RAKEBACK_DISTRIBUTED', 'TABLE_BALANCE_EXECUTED']) {
      const at = code.indexOf(`useMasterBusSubscription('${evt}'`);
      expect(at, `${evt} subscription not found`).toBeGreaterThan(-1);
      // The guard must be the first statement of the handler.
      const head = sliceEnclosingBlock(code, `useMasterBusSubscription('${evt}'`);
      expect(head, `${evt} does not guard on tableId`).toMatch(
        /payload\.tableId\s*!==\s*tableId\)\s*return/
      );
    }
  });

  it('lets only the ACTIVE table name the browser tab, and never with a UUID', () => {
    /* `document.title` is one string. Four instances wrote it, so the tab was
       named after whichever table mounted last — and it printed the raw table
       UUID, which is also what went into any bookmark of a table. */
    expect(ENV_TS).toMatch(/if\s*\(!isActive\)\s*return;/);
    expect(ENV_TS, 'the title still interpolates the raw tableId first').not.toMatch(
      /document\.title\s*=\s*`\$\{tableId\}/
    );
    expect(ENV_TS, 'the title does not prefer the table name').toMatch(/displayName/);
    // ...and TablePage has to actually pass both, or the hook's default wins.
    expect(code).toMatch(/useTableEnvironment\(tableId,\s*pageRootRef,\s*\{/);
    expect(code).toMatch(/displayName:\s*tableState\.tableName/);
  });
});
