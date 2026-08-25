/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNEY UX SWEEP — Dan's 2026-08-25 list, pinned
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One spec per complaint, so each of them fails loudly if it comes back. Where
 * a behaviour is a rendered fact it is asserted by rendering; where it is a
 * layout/CSS fact (a badge's offset, a ring's colour, a rail's gutter) it is
 * asserted against the stylesheet source, which is the same technique
 * tournamentTableFixes.test.tsx already uses for engine invariants.
 *
 * Dan's list, in his numbering:
 *   1  watch a running tournament, featured table + player redirect
 *   2  buy-in confirmation restyled; a space after every colon
 *   3  no secondary confirmation
 *   4  tournaments were missing the stats bar   -> tournamentTableFixes.test.tsx
 *   5  bounty badge centered above the action box
 *   6  action timer keeps the neon blue, no red
 *   7  amounts default to chip totals, never BB
 *   8  raise slider must not overlap the action buttons
 *   9  blind level display must track the real level
 *  10  busting holds action so the rebuy can be offered
 *  11  hero chips sit closer to the rail
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import ActionPanel from '../../src/components/table/ActionPanel';
import {
  CHIP_RAIL_BOTTOM_EXTRA_PX,
  CHIP_RAIL_INSET_PX,
} from '../../src/components/table/tableGeometry';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
/** Strip comments so a rule quoted in prose cannot satisfy a source assertion. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SEAT_CSS = 'src/components/table/SeatSlot.css';
const ACTION_CSS = 'src/components/table/ActionPanel.css';
const ACTION_TSX = 'src/components/table/ActionPanel.tsx';
const TABLE_PAGE = 'src/pages/TablePage.tsx';
const ANNOUNCE = 'src/components/table/TournamentAnnouncementOverlay.tsx';
const HUD = 'src/components/tournament/TournamentHUD.tsx';
const DETAILS = 'src/pages/tournament/TournamentDetails.tsx';
const STANDINGS = 'src/components/tournament/TournamentStandings.tsx';
const REG_HOOK = 'src/hooks/useTournamentRegistration.ts';
const SIGNUP_TSX = 'src/components/tournament/signUpDialog.tsx';
const SIGNUP_CSS = 'src/components/tournament/signUpDialog.css';
const APP = 'src/App.tsx';

// ─── 1. WATCH A RUNNING TOURNAMENT ────────────────────────────────────────────

describe('Item 1 - a running tournament can be watched', () => {
  it('the details footer offers a WATCH button driven by a featured table', () => {
    const src = code(read(DETAILS));
    expect(src).toMatch(/const featuredTableId = useMemo\(/);
    expect(src).toMatch(/className="btn btn-watch"/);
    expect(src).toMatch(/onClick=\{\(\) => watchTable\(featuredTableId\)\}/);
  });

  it('the featured table is the chip leader table, with fallbacks that cannot be empty', () => {
    const src = code(read(DETAILS));
    // Leader first: still playing, has a table, highest chips.
    expect(src).toMatch(/e\.status === 'playing' && e\.table_id/);
    expect(src).toMatch(/\(b\.chips \|\| 0\) - \(a\.chips \|\| 0\)/);
    // Then the fullest live table, then any table at all.
    expect(src).toMatch(/\(b\.current_players \|\| 0\) - \(a\.current_players \|\| 0\)/);
    expect(src).toMatch(/return tables\[0\]\?\.id \?\? null;/);
  });

  it('WATCH is offered alongside every running-state footer, not instead of one', () => {
    const src = code(read(DETAILS));
    // Waiting for a seat, eliminated, late-reg and plain in-progress all render it.
    const occurrences = src.match(/\{watchBtn\}/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
  });

  it('a Ranking row carries its table id and can be activated', () => {
    const src = code(read(STANDINGS));
    // The column has to be SELECTED - this is the bit that was missing.
    expect(src).toMatch(/\.select\('user_id, username, chips, status, position, table_id'\)/);
    expect(src).toMatch(/tableId: p\.table_id \?\? null/);
    expect(src).toMatch(/onWatchPlayer\?: \(tableId: string\) => void/);
    // Only rows that really have a table become buttons.
    expect(src).toMatch(/const watchable = !!\(onWatchPlayer && player\.tableId\)/);
  });

  it('an Entries row for a seated player is a route to that table', () => {
    const src = code(read(DETAILS));
    expect(src).toMatch(/const watchable = isRunning && isPlaying && !!entry\.table_id/);
    expect(src).toMatch(/watchTable\(entry\.table_id as string\)/);
  });

  it('Ranking rows are only clickable while the tournament is RUNNING', () => {
    const src = code(read(DETAILS));
    expect(src).toMatch(
      /onWatchPlayer=\{tournament\.status === 'RUNNING' \? watchTable : undefined\}/
    );
  });
});

// ─── 2 & 3. THE ONE BUY-IN CONFIRMATION ───────────────────────────────────────

describe('Items 2 and 3 - exactly one, styled, buy-in confirmation', () => {
  it('the registration hook no longer shows a generic confirm dialog', () => {
    const src = code(read(REG_HOOK));
    expect(src).not.toMatch(/confirmDialog\(/);
    expect(src).not.toMatch(/Confirm Buy In/);
    expect(src).toMatch(/await signUpDialog\(\{/);
  });

  it('the details page no longer renders a buy-in modal of its own', () => {
    const src = code(read(DETAILS));
    expect(src).not.toMatch(/showSignUpModal/);
    expect(src).not.toMatch(/className="signup-modal"/);
  });

  it('the shared dialog is mounted once at the app root', () => {
    const src = code(read(APP));
    expect(src).toMatch(/import \{ SignUpHost \} from '\.\/components\/tournament\/signUpDialog'/);
    expect((src.match(/<SignUpHost \/>/g) || []).length).toBe(1);
  });

  it('a dialog that cannot mount resolves false rather than registering unasked', () => {
    const src = code(read(SIGNUP_TSX));
    expect(src).toMatch(/if \(!enqueue\)[\s\S]{0,200}resolve\(false\)/);
  });

  it('the modal is actually styled, centered, and has depth', () => {
    const css = read(SIGNUP_CSS);
    expect(css).toMatch(/\.signup-overlay\s*\{/);
    expect(css).toMatch(/align-items: center;/);
    expect(css).toMatch(/justify-content: center;/);
    expect(css).toMatch(/perspective:/);
    expect(css).toMatch(/\.signup-modal\s*\{/);
    expect(css).toMatch(/rotateX\(/); // the 3D entrance
    expect(css).toMatch(/inset 0 1px 0/); // layered lighting, not a flat fill
  });

  it('the space after every colon is a layout rule, not a typed character', () => {
    const css = read(SIGNUP_CSS);
    // `.signup-row` must be a flex row with a real gap - two adjacent inline
    // spans in JSX have no whitespace between them, which is what printed
    // "Entry Fee:50".
    const row = css.slice(css.indexOf('.signup-row {'));
    expect(row).toMatch(/display: flex;/);
    expect(row).toMatch(/gap: \d+px;/);
  });

  it('the overlay does not reuse the app-wide .modal-overlay class', () => {
    // Five other stylesheets declare .modal-overlay; load order would decide
    // the winner, which is how this dialog ended up unstyled to begin with.
    expect(code(read(SIGNUP_TSX))).toMatch(/className="signup-overlay"/);
    expect(read(SIGNUP_CSS)).not.toMatch(/^\.modal-overlay\s*\{/m);
  });
});

// ─── 5. THE BOUNTY BADGE ──────────────────────────────────────────────────────

describe('Item 5 - the bounty badge is centered above the action box', () => {
  const css = read(SEAT_CSS);

  const topOf = (selector: string): number => {
    const start = css.indexOf(selector + ' {');
    expect(start, `${selector} must exist`).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    const m = block.match(/top:\s*(-?\d+)px/);
    expect(m, `${selector} must declare a top offset`).toBeTruthy();
    return Number(m![1]);
  };

  it('is horizontally centered on the seat, not pinned to a corner', () => {
    const start = css.indexOf('.seat__bounty {');
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toMatch(/left:\s*50%/);
    expect(block).toMatch(/translateX\(-50%\)/);
    expect(block).not.toMatch(/right:\s*-?\d+px/);
  });

  it('sits ABOVE the action badge with clear air between them', () => {
    const bountyTop = topOf('.seat__bounty');
    const actionTop = topOf('.seat__action');
    expect(bountyTop).toBeLessThan(actionTop);
    // The bounty pill is ~22px tall; anything under that would overlap.
    expect(actionTop - bountyTop).toBeGreaterThanOrEqual(30);
  });

  it('has dimension rather than a flat fill', () => {
    const start = css.indexOf('.seat__bounty {');
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toMatch(/inset 0 1px 0/); // top highlight
    expect(block).toMatch(/linear-gradient/);
  });
});

// ─── 6. THE COUNTDOWN RING ────────────────────────────────────────────────────

describe('Item 6 - the action countdown stays neon blue', () => {
  const css = read(SEAT_CSS);

  it('never snaps the ring colour to red', () => {
    const start = css.indexOf('@keyframes spTimerColorShift');
    const block = css.slice(start, css.indexOf('}\n', css.indexOf('{', start) + 1) + 2);
    expect(block).not.toMatch(/#ef4444/);
    expect(block).toMatch(/#00e5ff/);
  });

  it('the urgent and critical states do not repaint the ring', () => {
    const start = css.indexOf('.seat--timer-urgent .seat__info::before');
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).not.toMatch(/#ff6b35/);
    expect(block).not.toMatch(/#ef4444/);
    expect(block).toMatch(/var\(--timer-color, #00e5ff\)/);
  });

  it('the acting seat keeps its own plate frame instead of going transparent', () => {
    const start = css.indexOf('.seat--active .seat__info {');
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).not.toMatch(/border-color:\s*transparent/);
    expect(block).toMatch(/border-color:\s*var\(--seat-border/);
  });
});

// ─── 7. CHIPS, NOT BIG BLINDS ─────────────────────────────────────────────────

describe('Item 7 - amounts default to actual totals, never BB', () => {
  const baseProps = {
    canFold: true,
    canCheck: false,
    canCall: true,
    canRaise: true,
    canAllIn: true,
    callAmount: 100,
    minRaise: 200,
    maxRaise: 2000,
    pot: 300,
    bigBlind: 100,
    smallBlind: 50,
    onAction: () => {},
    isMyTurn: true,
  };

  it('the panel prop defaults to chips', () => {
    const src = code(read(ACTION_TSX));
    expect(src).toMatch(/showStackInBB = false/);
  });

  it('the BB sub-label is gated on the user setting', () => {
    const src = code(read(ACTION_TSX));
    expect(src).toMatch(/showStackInBB && bigBlind > 0 && !amountTyping/);
  });

  it('the slider cap prints chips unless BB is switched on', () => {
    const src = code(read(ACTION_TSX));
    expect(src).toMatch(/showStackInBB && bigBlind > 0\s*\?\s*`\$\{Math\.round\(minRaise/);
  });

  it('renders no BB text at all with the default settings', () => {
    render(<ActionPanel {...baseProps} />);
    // The resting 3-button row must never print a BB figure.
    expect(screen.queryByText(/\bBB\b/)).toBeNull();
  });

  it('the table passes the real user setting through', () => {
    expect(code(read(TABLE_PAGE))).toMatch(/showStackInBB=\{v8Settings\.show_stack_in_bb\}/);
  });

  it('the hamburger toggle writes the key the felt actually reads', () => {
    const src = code(read('src/components/navigation/HamburgerMenu.tsx'));
    // The bus key must be a field of DEFAULT_USER_TABLE_SETTINGS or the table
    // settings hook silently drops the event.
    expect(src).toMatch(/setting: 'show_stack_in_bb'/);
    expect(src).not.toMatch(/setting: 'showStackInBB'/);
    expect(src).toMatch(/from\('user_table_settings'\)[\s\S]{0,200}show_stack_in_bb: newValue/);
  });
});

// ─── 8. THE RAISE SLIDER ──────────────────────────────────────────────────────

describe('Item 8 - the raise slider clears the action buttons', () => {
  /* Comment-stripped: the rule's own docstring quotes the OLD `right: 8px` it
     replaced, and a naive indexOf would read the prose instead of the code. */
  const css = code(read(ACTION_CSS));

  it('the rail lives in the reserved gutter, outside the content column', () => {
    const start = css.indexOf('.raise-slider-vertical {');
    const block = css.slice(start, css.indexOf('}', start));
    const m = block.match(/right:\s*(-?\d+)px/);
    expect(m).toBeTruthy();
    // Negative = outside .raise-layout. `right: 8px` (the old value) put the
    // 76px rail straight over the presets and the confirm button.
    expect(Number(m![1])).toBeLessThan(0);
  });

  it('the rail never overhangs the panel edge', () => {
    const railStart = css.indexOf('.raise-slider-vertical {');
    const railBlock = css.slice(railStart, css.indexOf('}', railStart));
    const right = Math.abs(Number(railBlock.match(/right:\s*(-?\d+)px/)![1]));
    const width = Number(railBlock.match(/width:\s*(\d+)px/)![1]);

    const gutStart = css.indexOf('.action-panel--raise-vertical {');
    const gutBlock = css.slice(gutStart, css.indexOf('}', gutStart));
    const gutter = Number(gutBlock.match(/padding-right:\s*calc\((\d+)px/)![1]);

    // Rail occupies [right - width, right] beyond the column. Its far edge must
    // stay inside the gutter, and its near edge must clear the buttons.
    expect(right).toBeLessThanOrEqual(gutter);
    expect(right - width).toBeGreaterThan(0);
  });

  it('the top cap no longer prints on top of the ALL IN tick label', () => {
    const src = code(read(ACTION_TSX));
    expect(src).not.toMatch(/raise-slider-vertical__cap--max/);
    expect(src).toMatch(/raise-slider-vertical__cap--min/);
  });
});

// ─── 9. THE BLIND LEVEL ───────────────────────────────────────────────────────

describe('Item 9 - the level shown is the level being played', () => {
  it('the level-up banner is handed the human level, not the engine index', () => {
    const src = code(read(TABLE_PAGE));
    expect(src).toMatch(
      /setAnnouncement\(\{ type: 'level_up', data: \{ \.\.\.levelData, level: lvlIdx \+ 1 \} \}\)/
    );
  });

  it('the banner does not add its own offset, and does not launder a zero', () => {
    const src = code(read(ANNOUNCE));
    expect(src).toMatch(/LEVEL \$\{data\?\.level \?\? '-'\}/);
    expect(src).not.toMatch(/data\?\.level \|\| 1/);
  });

  it('the tournament HUD re-reads the row instead of trusting realtime alone', () => {
    const src = code(read(HUD));
    expect(src).toMatch(/resyncRef\.current = setInterval\(\(\) => void refresh\(\), 45_000\)/);
    // and it must clear that interval on unmount.
    expect(src).toMatch(/if \(resyncRef\.current\) clearInterval\(resyncRef\.current\)/);
  });
});

// ─── 10. THE BUST HOLD ────────────────────────────────────────────────────────

describe('Item 10 - busting holds action so the rebuy can be offered', () => {
  const src = code(read(TABLE_PAGE));

  it('there is a hold with a bounded deadline', () => {
    expect(src).toMatch(/const BUST_HOLD_MS = 5000;/);
    expect(src).toMatch(/const bustHoldRef = useRef</);
    expect(src).toMatch(/hold\.deadline = setTimeout\(/);
  });

  it('the elimination broadcast defers its exit instead of navigating', () => {
    expect(src).toMatch(
      /if \(bustHoldRef\.current\.active\) \{\s*bustHoldRef\.current\.pendingExit = exit;/
    );
  });

  it('the deferred exit is replayed, not discarded, when the hold releases', () => {
    expect(src).toMatch(
      /goToLobbyWithResultRef\.current\?\.\(pending\.position, pending\.prize, pending\.delayMs\)/
    );
  });

  it('the tournament bust watcher no longer waits for the hand to finish', () => {
    // The cash watcher keeps its in-hand guard; the tournament one must not,
    // or it loses the race to player_eliminated every time. Slice from the
    // watcher's own marker comment in the RAW source (the marker is a comment,
    // so it survives only there) up to its rebuy check.
    const raw = read(TABLE_PAGE);
    const from = raw.indexOf('// Tournament bust / rebuy & elimination watcher');
    expect(from).toBeGreaterThan(-1);
    const to = raw.indexOf('const rebuyCheck = await tournamentService.canRebuy', from);
    expect(to).toBeGreaterThan(from);
    const tourneyWatcher = code(raw.slice(from, to));

    expect(tourneyWatcher).not.toMatch(/if \(tableState\.isHandInProgress\) return;/);
    expect(tourneyWatcher).toMatch(/beginBustHold\(\)/);
  });

  it('declining releases immediately and rebuying cancels the deferred exit', () => {
    expect(src).toMatch(/bustHoldRef\.current\.pendingExit = null;\s*releaseBustHold\(\);/);
    expect(src).toMatch(/setShowRebuyModal\(false\);[\s\S]{0,400}releaseBustHold\(\);/);
  });
});

// ─── 11. THE HERO'S CHIPS ─────────────────────────────────────────────────────

describe("Item 11 - the hero's chips sit closer to the rail", () => {
  it('the hero-only extra is a fraction of the common rail, not most of it', () => {
    // Strictly positive: at 0 the chips land on the oversized hero avatar,
    // which is the 2026-08-23 complaint this constant was created for.
    expect(CHIP_RAIL_BOTTOM_EXTRA_PX).toBeGreaterThan(0);
    // And no longer the ~46px that put them out on the felt.
    expect(CHIP_RAIL_BOTTOM_EXTRA_PX).toBeLessThanOrEqual(20);
    expect(CHIP_RAIL_BOTTOM_EXTRA_PX).toBeLessThan(CHIP_RAIL_INSET_PX / 2);
  });
});
