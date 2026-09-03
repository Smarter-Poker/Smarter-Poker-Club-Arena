/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE CHAT — the 3/4 sheet
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27, verbatim: "chat has issues too, it should open 3/4 screen
 * have padding with an X off, chat should run inside here, there should also be
 * a microphone for voice as well."
 *
 * Chat was a 280x320 box pinned to the bottom-right corner. Everything pinned
 * below is something a player would SEE if it broke, and most of it has broken
 * once already on a neighbouring surface:
 *
 *  - the safe-area padding, whose two blocks are dead unless they sit AFTER the
 *    header's `padding` shorthand (GlobalHeader.module.css:440-459 documents the
 *    trap; HandDetailModal hit it the same week);
 *  - the backdrop, which on the Previous Hand sheet was wired to a target that
 *    did not exist because the panel covered 100% of it - the gesture was there
 *    and did nothing;
 *  - one close per gesture: there are three ways out now and `onToggleCollapse`
 *    is a TOGGLE, so two calls for one tap is "chat closes and reopens";
 *  - the collapsed button's `calc()` fallback, whose absence does not degrade a
 *    `position: fixed` offset but DELETES it (`bottom: auto`) and throws the
 *    button to the top of the screen - caught in production by
 *    tests/e2e/raise-panel-covers-chat.spec.ts on 2026-08-25.
 *
 * The stylesheet parts are asserted against the CSS SOURCE, following
 * tests/unit/bottomBarReserve.test.ts: happy-dom does no layout, so a rule that
 * "exists" is the strongest honest claim, and source order is exactly what the
 * padding bug is about. The behaviour is asserted against the real component.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, fireEvent } from '@testing-library/react';
import { TableChat } from '../../src/components/table/TableChat';
import type { ChatMessage } from '../../src/components/table/TableChat';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const CHAT_CSS = read('src/components/table/TableChat.css');
const CHAT_TSX = read('src/components/table/TableChat.tsx');

/**
 * The body of one top-level rule. None of the rules asserted here nest, so the
 * first closing brace ends the block; a selector is matched at column 0 so
 * `.table-chat` never picks up `.table-chat-backdrop` or an indented
 * `.table-chat,` inside a media query.
 */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no top-level rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const messages: ChatMessage[] = [];

function renderOpenSheet(onToggleCollapse = vi.fn()) {
  const utils = render(
    <TableChat
      messages={messages}
      onSendMessage={vi.fn()}
      myPlayerId="hero-id"
      tableId="table-1"
      isCollapsed={false}
      onToggleCollapse={onToggleCollapse}
    />
  );
  return { ...utils, onToggleCollapse };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SHEET
// ═══════════════════════════════════════════════════════════════════════════════

describe('the chat sheet occupies three quarters of the height', () => {
  it('is bottom-anchored at 75dvh with a 75vh fallback ahead of it', () => {
    const block = ruleBlock(CHAT_CSS, '.table-chat');

    expect(block).toContain('height: 75dvh');
    // The plain-vh line is the fallback for a browser with no dvh, so it must
    // come FIRST - after it, the dvh declaration wins wherever it is understood.
    expect(block.indexOf('height: 75vh')).toBeLessThan(block.indexOf('height: 75dvh'));

    expect(block).toContain('bottom: 0');
    expect(block).toMatch(/border-radius:\s*18px 18px 0 0/);
  });

  it('does not cover its own backdrop', () => {
    // The Previous Hand sheet's reported bug in one assertion: a panel at
    // `inset: 0` / `height: 100%` leaves no backdrop to tap, so "click off to
    // close" is wired to a target that does not exist.
    const sheet = ruleBlock(CHAT_CSS, '.table-chat');
    expect(sheet).not.toMatch(/inset:\s*0/);
    expect(sheet).not.toMatch(/height:\s*100(%|vh|dvh)/);
    expect(sheet).not.toMatch(/top:\s*0/);

    const backdrop = ruleBlock(CHAT_CSS, '.table-chat-backdrop');
    expect(backdrop).toMatch(/inset:\s*0/);
  });

  it('puts the backdrop under the sheet and both above the action panel', () => {
    // THE Z-INDEX DECISION. The sheet is modal: its backdrop takes every tap
    // meant for the table, so nothing underneath can be aimed at, and at 75dvh
    // it reaches past the action bar - left at 99 the bar would cover the
    // compose row. The COLLAPSED button is the element the e2e spec pins and it
    // is asserted separately below, unchanged at 99.
    expect(ruleBlock(CHAT_CSS, '.table-chat-backdrop')).toContain(
      'z-index: var(--z-modal-backdrop, 400)'
    );
    expect(ruleBlock(CHAT_CSS, '.table-chat')).toContain('z-index: var(--z-modal, 500)');
  });

  it('has the 36x4 grab handle the Previous Hand sheet uses', () => {
    expect(ruleBlock(CHAT_CSS, '.table-chat__grab span')).toMatch(/width:\s*36px/);
    expect(ruleBlock(CHAT_CSS, '.table-chat__grab span')).toMatch(/height:\s*4px/);
    // Drag past 100px closes, same threshold as HandDetailModal / BottomSheet.
    expect(CHAT_TSX).toMatch(/dragY\s*>\s*100/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE PADDING (both blocks, standalone last)
// ═══════════════════════════════════════════════════════════════════════════════

describe('the sheet header pays the safe area, in both blocks, in the right order', () => {
  it('carries the phone block', () => {
    expect(CHAT_CSS).toContain('@media (max-width: 640px)');
    expect(CHAT_CSS).toContain('padding-top: calc(12px + env(safe-area-inset-top, 0px));');
  });

  it('carries the installed-app floor', () => {
    // env(safe-area-inset-top) resolves to 0 on some devices in an installed
    // app, so the env() padding above silently vanishes without this floor.
    expect(CHAT_CSS).toContain('@media (display-mode: standalone), (display-mode: fullscreen)');
    expect(CHAT_CSS).toContain(
      'padding-top: calc(12px + max(env(safe-area-inset-top, 0px), 24px));'
    );
  });

  it('puts the standalone floor LAST, after the phone block and after the shorthand', () => {
    const shorthand = CHAT_CSS.indexOf('padding: 10px 14px');
    const phone = CHAT_CSS.indexOf('padding-top: calc(12px + env(safe-area-inset-top, 0px));');
    const standalone = CHAT_CSS.indexOf('display-mode: standalone');

    expect(shorthand).toBeGreaterThan(-1);
    // `.table-chat__header` sets a `padding` SHORTHAND and a shorthand RESETS
    // padding-top. Equal specificity means source order decides, so either
    // block placed above it would be dead CSS that reads as correct.
    expect(phone).toBeGreaterThan(shorthand);
    expect(standalone).toBeGreaterThan(phone);

    // And nothing touching the header's padding may follow it.
    expect(CHAT_CSS.lastIndexOf('.table-chat__header')).toBeGreaterThan(standalone);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE COLLAPSED BUTTON (unchanged — the e2e spec's premise)
// ═══════════════════════════════════════════════════════════════════════════════

describe('the collapsed chat button is untouched by the sheet', () => {
  it('keeps the repeated calc() fallback behind --sp-hud-line', () => {
    const block = ruleBlock(CHAT_CSS, '.chat-collapsed');
    // An unresolved custom property on a `position: fixed` element does not
    // degrade the offset, it DELETES it: `bottom` computes to `auto` and the
    // button jumps to the top of the screen. The fallback deliberately repeats
    // TableHUD.css's expression.
    expect(block).toContain('--sp-hud-line');
    // 2026-08-27: --sp-action-reserve, not the deleted --sp-action-h. The line
    // still follows the bar; it follows the height the bar is ENTITLED to,
    // which is the part that does not change several times a hand.
    expect(block).toContain('--sp-action-reserve');
    // The deleted variable may still be NAMED in the block's comment — that is
    // the history of why the line moved. It may not be READ.
    expect(block).not.toMatch(/var\(\s*--sp-action-h\b/);
    expect(block).toContain('--sp-bottom-row-h');
    expect(block).toContain('env(safe-area-inset-bottom, 0px)');
  });

  it('keeps z-index 99, one below the action panel', () => {
    // tests/e2e/raise-panel-covers-chat.spec.ts asserts the open raise panel
    // wins the overlap against THIS element. Moving the open sheet above the
    // action panel must not move this one.
    expect(ruleBlock(CHAT_CSS, '.chat-collapsed')).toContain('z-index: 99');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIOUR
// ═══════════════════════════════════════════════════════════════════════════════

describe('dismissing the sheet', () => {
  it('closes when the backdrop is tapped, exactly once', () => {
    const { container, onToggleCollapse } = renderOpenSheet();
    const backdrop = container.querySelector('.table-chat-backdrop') as HTMLElement;
    expect(backdrop).not.toBeNull();

    fireEvent.mouseDown(backdrop);

    // ONCE. The backdrop carries its own handler AND lives outside the panel,
    // so the document `mousedown` listener sees it too; `onToggleCollapse` is a
    // toggle, and two calls for one tap is "closes and instantly reopens".
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('does not close when the tap lands inside the sheet', () => {
    const { container, onToggleCollapse } = renderOpenSheet();
    const messagesPane = container.querySelector('.table-chat__messages') as HTMLElement;

    fireEvent.mouseDown(messagesPane);

    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onToggleCollapse } = renderOpenSheet();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('closes on the X, which says what it does', () => {
    const { getByLabelText, onToggleCollapse } = renderOpenSheet();

    fireEvent.click(getByLabelText('Close Chat'));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE MICROPHONE
// ═══════════════════════════════════════════════════════════════════════════════

describe('the microphone has a slot in the header', () => {
  it('renders the voice slot inside the header, to the LEFT of the close X', () => {
    const { container } = renderOpenSheet();
    const header = container.querySelector('.table-chat__header') as HTMLElement;
    const slot = header.querySelector('.table-chat__voice');
    const close = header.querySelector('.table-chat__close');

    expect(slot, 'no voice slot in the chat header').not.toBeNull();
    expect(close).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING: the close button comes after the slot.
    expect(slot!.compareDocumentPosition(close!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('mounts VoiceControls with the contract the voice agent fixed', () => {
    // The component renders nothing until the voice agent implements it, so the
    // DOM cannot show this. The call site can, and the call site is the part
    // that must not drift: <VoiceControls tableId={...} userId={...} />.
    expect(CHAT_TSX).toContain("import VoiceControls from './VoiceControls'");
    expect(CHAT_TSX).toMatch(
      /<VoiceControls\s+tableId=\{tableId\}\s+userId=\{myPlayerId \?\? ''\}/
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// QUICK CHAT (the orphan stylesheet, now a component)
// ═══════════════════════════════════════════════════════════════════════════════

describe('quick chat presets', () => {
  it('are in the sheet and send through the ordinary chat path', () => {
    const onSendMessage = vi.fn();
    const { container, getByLabelText } = render(
      <TableChat
        messages={messages}
        onSendMessage={onSendMessage}
        myPlayerId="hero-id"
        tableId="table-1"
        isCollapsed={false}
        onToggleCollapse={vi.fn()}
      />
    );

    expect(container.querySelector('.quick-chat')).not.toBeNull();

    fireEvent.click(getByLabelText('Send Nice Hand'));

    // The same callback a typed line uses, so the rate limit, the profanity
    // filter, the failed-send marking and the seat bubble all still apply.
    expect(onSendMessage).toHaveBeenCalledWith('Nice Hand');
  });

  it('refuses a second preset inside the send cooldown', () => {
    const onSendMessage = vi.fn();
    const { getByLabelText } = render(
      <TableChat
        messages={messages}
        onSendMessage={onSendMessage}
        myPlayerId="hero-id"
        tableId="table-1"
        isCollapsed={false}
        onToggleCollapse={vi.fn()}
      />
    );

    fireEvent.click(getByLabelText('Send Nice Hand'));
    fireEvent.click(getByLabelText('Send Good Luck'));

    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });
});
