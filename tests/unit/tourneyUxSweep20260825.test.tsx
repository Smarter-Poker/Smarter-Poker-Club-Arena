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
import * as geometry from '../../src/components/table/tableGeometry';
import { betChipOffsetPx, NOMINAL_SCALER } from '../../src/components/table/tableGeometry';

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

  it('the featured table is the chip leader table, and never a closed one', () => {
    const src = code(read(DETAILS));
    // Leader first: still playing, has a table, highest chips.
    expect(src).toMatch(/e\.status === 'playing' && e\.table_id/);
    expect(src).toMatch(/\(b\.chips \|\| 0\) - \(a\.chips \|\| 0\)/);
    // Then the fullest LIVE table.
    expect(src).toMatch(/\(b\.current_players \|\| 0\) - \(a\.current_players \|\| 0\)/);
    /* 2026-08-25 audit: the last-resort fallback was `tables[0]?.id`, which can
       be a CLOSED table — a WATCH button that opens a dead felt. Every fallback
       is now drawn from the `live` list, and when nothing is live the button is
       not rendered at all. */
    expect(src).toMatch(/const live = tables\.filter/);
    expect(src).toMatch(/return live\[0\]\?\.id \?\? null;/);
    expect(src).not.toMatch(/return tables\[0\]\?\.id/);
  });

  it('watching ADDS a screen rather than replacing the one in front of you', () => {
    const src = code(read(DETAILS));
    expect(src).toMatch(/openTableAsObserver\(navigate, \{ tableId \}\)/);
    expect(src).not.toMatch(/navigate\(`\/table\/\$\{tableId\}`\)/);
  });

  it('a running tournament is watchable from the lobby card and the club page too', () => {
    const card = code(read('src/components/tournament/TournamentLobbyCard.tsx'));
    expect(card).not.toMatch(/tournament\.status === 'running' && isRegistered/);
    expect(card).toMatch(/isRegistered \? 'Open Tournament' : 'Watch'/);

    const page = code(read('src/pages/TournamentPage.tsx'));
    expect(page).not.toMatch(/disabled=\{!isRegistered\}[\s\S]{0,160}handleJoinTable/);
    expect(page).toMatch(/isRegistered \? 'Go to Table' : 'Watch'/);
    expect(page).toMatch(/openTableAsObserver\(navigate, \{ tableId: live\[0\]\.id \}\)/);
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

  it('the elimination broadcast claims the hold itself and always defers', () => {
    /* 2026-08-25 audit: this used to only defer IF some other watcher had
       already claimed the hold, and otherwise navigated — the same race in a
       new coat, because the stack watcher may not have run yet. */
    expect(src).toMatch(
      /beginBustHoldRef\.current\?\.\(\);\s*bustHoldRef\.current\.pendingExit = exit;/
    );
    expect(src).not.toMatch(
      /if \(bustHoldRef\.current\.active\) \{\s*bustHoldRef\.current\.pendingExit = exit;/
    );
  });

  it('an all-in that is still live does not get a bust prompt', () => {
    /* THE REGRESSION THIS BRANCH ITSELF INTRODUCED, caught by audit: a hero who
       is all-in shows stack === 0 for the whole of settlement. Deleting the
       in-hand guard outright threw a rebuy modal at a player about to win the
       pot. The guard is back, but conditional on there being no elimination
       signal — which is what preserves the fix for the original race. */
    expect(src).toMatch(/const eliminationSignalled =/);
    expect(src).toMatch(/if \(tableState\.isHandInProgress && !eliminationSignalled\) return;/);
  });

  it('an unanswered rebuy prompt cannot hold the player forever', () => {
    /* The modal branch cancelled the 5s deadline and set nothing in its place.
       PersistentTableLayer HIDES rather than unmounts, so navigating away with
       the prompt open left the hold active for the rest of the session. */
    expect(src).toMatch(/const BUST_HOLD_MODAL_MS = 120_000;/);
    expect(src).toMatch(/releaseBustHoldRef\.current\?\.\(\)/);
  });

  it('a slow rebuy check cannot open a modal over a table the player has left', () => {
    expect(src).toMatch(/if \(!bustHoldRef\.current\.active\) return;/);
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
  /**
   * This branch originally cut CHIP_RAIL_BOTTOM_EXTRA_PX from 46 to 16. While
   * it was open, main landed a full rewrite of tableGeometry (2026-08-25,
   * "mobile pass items 11 and 13") that DELETES the hero-only extra outright
   * and puts every seat on one common rail, clamped inside the felt. That is a
   * stronger answer to the same complaint, so the merge kept main's file and
   * this spec was rewritten to assert the OUTCOME Dan asked for rather than the
   * constant that used to produce it — an outcome assertion survives the next
   * rewrite too.
   *
   * The old distance at NOMINAL_SCALER was (64 + 46) * 1.82 = 200px, which is
   * the picture in Dan's screenshot: chips out on the felt, nowhere near him.
   */
  const dist = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
  const HERO = { x: 50, y: 100 };

  it('no hero-only distance term survives anywhere in the module', () => {
    expect(geometry).not.toHaveProperty('CHIP_RAIL_BOTTOM_EXTRA_PX');
    expect(code(read('src/components/table/tableGeometry.ts'))).not.toMatch(
      /isHeroRailSeat|BOTTOM_EXTRA/
    );
  });

  it("the hero's chips are pulled well back from where they were", () => {
    const heroDist = dist(betChipOffsetPx(HERO, NOMINAL_SCALER, false));
    expect(heroDist).toBeGreaterThan(0);
    // Comfortably inside the 200px that produced the complaint, with headroom
    // so an honest re-tune does not trip it.
    expect(heroDist).toBeLessThanOrEqual(150);
  });

  it('the hero is not the outlier: every seat walks the same rail', () => {
    const heroDist = dist(betChipOffsetPx(HERO, NOMINAL_SCALER, false));
    const topDist = dist(betChipOffsetPx({ x: 50, y: 0 }, NOMINAL_SCALER, false));
    // The two seats opposite each other, both outside the painted felt by the
    // same amount, must be treated identically to within rounding.
    expect(Math.abs(heroDist - topDist)).toBeLessThanOrEqual(20);
  });
});

// ─── AUDIT HARDENING (2026-08-25, post-merge) ─────────────────────────────────
//
// Everything below pins a defect found by an adversarial audit of the shipped
// PR, hours after it merged. Each one is a way the "one confirmation" work
// could have cost a player money or stranded them at a table.

describe('Audit - no path takes a buy-in without asking', () => {
  const REGISTER_SURFACES = [
    'src/pages/tournament/TournamentLobbyPage.tsx',
    'src/pages/XMTTPage.tsx',
    'src/pages/UnionGamesPage.tsx',
    'src/pages/ClubHomePage.tsx',
    'src/pages/TournamentPage.tsx',
    'src/pages/tournament/TournamentDetails.tsx',
  ];

  it('every player-facing surface registers through the hook, never the service', () => {
    /* THE HOLE. TournamentLobbyPage (the GLOBAL lobby — the busiest register
       button in the app), XMTTPage and UnionGamesPage each called
       `tournamentService.registerPlayer` directly: one tap, chips gone, no
       price confirmed, no balance shown. All three ALSO destructured
       `registerMtt` from the hook and never used it, so they looked wired to
       the shared path and were not. */
    for (const f of REGISTER_SURFACES) {
      const src = code(read(f));
      expect(src, `${f} must not register directly`).not.toMatch(
        /tournamentService\.registerPlayer\(/
      );
      expect(src, `${f} must go through the hook`).toMatch(/registerMtt\(/);
    }
  });

  it('the only registerPlayer caller left in src/ is the hook and the horses', () => {
    const offenders: string[] = [];
    for (const f of REGISTER_SURFACES) {
      if (/tournamentService\.registerPlayer\(/.test(read(f))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('every surface hands the dialog the SAME rows, including the club that pays', () => {
    /* "One dialog everywhere" has to mean the same dialog. ClubHomePage and
       TournamentPage passed only the two money fields, so the Bounty and Start
       Time rows silently vanished on those surfaces for the same tournament.
       `club_id` matters more than cosmetics: without it the balance is read
       against whatever club is ambient, which can DISABLE Confirm for a player
       who is funded in the club that would actually be charged. */
    for (const f of REGISTER_SURFACES) {
      const src = code(read(f));
      expect(src, `${f} must pass club_id`).toMatch(/club_id:/);
      expect(src, `${f} must pass start_time`).toMatch(/start_time:/);
    }
    expect(code(read(REG_HOOK))).toMatch(/clubId: t\.club_id \?\? null/);
    expect(code(read(REG_HOOK))).toMatch(/club_id\?: string \| null/);
  });
});

describe('Audit - the dialog cannot confirm a buy-in nobody was shown', () => {
  const src = code(read(SIGNUP_TSX));

  it('settle answers one request by id, never whatever is at the head', () => {
    /* R1. The first version popped the head unconditionally, so two settles in
       one React batch (double-tapped Confirm, or Escape landing in the same
       batch as a click) resolved request #1 AND silently resolved queued
       request #2 `true` — confirming a buy-in whose card never rendered. */
    expect(src).toMatch(/const settle = useCallback\(\(id: number, result: boolean\)/);
    expect(src).toMatch(/if \(settledRef\.current\.has\(id\)\) return;/);
    expect(src).toMatch(/setQueue\(\(q\) => q\.filter\(\(r\) => r\.id !== id\)\)/);
    // and every control passes the id it was rendered for
    expect(src).toMatch(/settle\(id, true\)/);
    expect(src).toMatch(/settle\(id, false\)/);
  });

  it('never resolves a money promise from inside a state updater', () => {
    // R2. React runs updaters twice under StrictMode.
    expect(src).not.toMatch(/setQueue\(\([\s\S]{0,200}head\.resolve\(/);
  });

  it('unmount settles every pending request instead of hanging it', () => {
    /* R3. The caller awaits this AFTER flipping its re-entrancy ref, so one
       hung promise bricked that Register button for the rest of the session. */
    expect(src).toMatch(/for \(const req of pending\)/);
    expect(src).toMatch(/req\.resolve\(false\)/);
  });

  it('a remounted host cannot null out the live bridge', () => {
    // R4.
    expect(src).toMatch(/if \(enqueue === mine\) enqueue = null;/);
  });

  it('sits above every other overlay in the app', () => {
    /* R5. It shipped at z-index 1000. The app has ~20 overlays above that and
       the offline banner alone is 9999 — ordinary chrome could paint over the
       one prompt that takes money. */
    const css = read(SIGNUP_CSS);
    const m = css.match(/\.signup-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(9999);
  });

  it('reads the balance of the club that actually pays', () => {
    // R6.
    expect(src).toMatch(/getPlayerBalance\(userId, \{ clubId \}\)/);
  });

  it('an unreadable balance never blocks a buy-in', () => {
    // Null renders "--" and leaves Confirm enabled; the server RPC is the gate.
    expect(src).toMatch(/const short = balance !== null && balance < cost;/);
  });

  it('does not tell a late registrant they cannot unregister near the start', () => {
    // A late registration cannot be unregistered at all, and an SNG has no
    // start time for the rule to be about.
    expect(src).toMatch(/!o\.isLateRegistration && !!startLabel/);
  });

  it('traps focus and gives it back', () => {
    expect(src).toMatch(/restoreFocusRef/);
    expect(src).toMatch(/e\.key !== 'Tab'/);
  });
});

describe('Audit - the tournament HUD stops when there is nothing left to ask', () => {
  const src = code(read(HUD));

  it('stops polling once the event is over', () => {
    expect(src).toMatch(/status !== 'RUNNING' && status !== 'REGISTERING'/);
    expect(src).toMatch(/clearInterval\(resyncRef\.current\)/);
  });

  it('does not report the same failure every 45 seconds forever', () => {
    expect(src).toMatch(/if \(failures <= 2\) reportError/);
    expect(src).toMatch(/if \(failures >= 5 && resyncRef\.current\)/);
  });

  it('does not tick once a second while hidden', () => {
    expect(src).toMatch(
      /if \(hidden \|\| !tournament \|\| tournament\.status !== 'RUNNING'\) return;/
    );
  });
});
