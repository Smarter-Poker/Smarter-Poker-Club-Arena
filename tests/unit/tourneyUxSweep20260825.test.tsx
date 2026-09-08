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
import { sliceCall, sliceBlockAfter } from '../helpers/sourceWindow';
import {
  betChipOffsetPx,
  NOMINAL_SCALER,
  HERO_CHIP_LIFT_WIDTH_PCT,
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
const ENTRIES_TAB = 'src/components/tournament/details/EntriesTab.tsx';
const RANKING_TAB = 'src/components/tournament/details/RankingTab.tsx';
const TAB_TYPES = 'src/components/tournament/details/types.ts';
const ENTRIES_HOOK = 'src/hooks/useTournamentEntries.ts';
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
    // Whitespace-tolerant: the old exact-source match broke on a prettier wrap.
    expect(src).toMatch(/watchTable\(\s*featuredTableId\s*\)/);
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
    expect(page).toMatch(/isRegistered \? 'Go To Table' : 'Watch'/);
    expect(page).toMatch(/openTableAsObserver\(navigate, \{ tableId: live\[0\]\.id \}\)/);
  });

  it('WATCH is offered alongside every running-state footer, not instead of one', () => {
    const src = code(read(DETAILS));
    // Waiting for a seat, eliminated, late-reg and plain in-progress all render it.
    const occurrences = src.match(/\{watchBtn\}/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
  });

  /* RE-POINTED 2026-08-26. This asserted the four halves of the behaviour
     against `TournamentStandings`, which fetched its own copy of the field and
     drew it as cards. That component has been retired - RankingTab is the one
     ranking board on the platform now, and it renders from props - so the same
     four halves are asserted at the addresses that hold them today:

       the column is SELECTED       -> whichever query feeds the tab
       the column reaches the row    -> the same mappers
       the prop exists on the contract -> details/types.ts
       only real tables are clickable  -> RankingTab

     Nothing about what a player can do has changed; only where it is written. */
  it('a Ranking row carries its table id and can be activated', () => {
    // Both feeds of the board select the column and carry it onto the entry.
    // Not the exact select string — adding a column must not break this.
    for (const feed of [DETAILS, ENTRIES_HOOK]) {
      const src = code(read(feed));
      const playersQuery = src.slice(src.indexOf(".from('tournament_players')"));
      expect(playersQuery.startsWith(".from('tournament_players')")).toBe(true);
      expect(sliceCall(playersQuery, '.select(')).toMatch(/\btable_id\b/);
      expect(src).toMatch(/table_id: \(e\.table_id as string \| null\) \|\| null/);
    }

    const contract = code(read(TAB_TYPES));
    expect(contract).toMatch(/onWatchPlayer\?: \(tableId: string\) => void/);

    // Only rows that really have a table become buttons.
    const tab = code(read(RANKING_TAB));
    expect(tab).toMatch(/const watchable = eventRunning && !out && !!entry\.table_id/);
    expect(tab).toMatch(/if \(!watchable\) \{/);
  });

  /* The lobby page's live pane used to mount `TournamentStandings` beside the
     clock, so a running tournament had TWO ranking boards on the platform,
     fetching the same rows and free to disagree. It mounts the tab now. */
  it('the tournament page live pane mounts the same Ranking board', () => {
    const page = code(read('src/pages/TournamentPage.tsx'));
    expect(page).toMatch(/<RankingTab\b/);
    expect(page).toMatch(/onWatchPlayer=\{watchPlayerTable\}/);
    expect(page).not.toMatch(/TournamentStandings/);
  });

  /* MOVED 2026-08-25 (same commit): the details page no longer draws the entry
     list or the ranking board inline - they are EntriesTab and RankingTab, and
     the page hands them `onWatchPlayer` through the tab contract. The
     behaviour Dan asked for is unchanged, so these two assert it at its new
     address rather than at the old one. */
  it('an Entries row for a seated player is a route to that table', () => {
    const src = code(read(ENTRIES_TAB));
    // Still playing, still holding a table, and only when the page offered a
    // handler at all - which it does only for a RUNNING event.
    expect(src).toMatch(
      /const watchable = !!onWatchPlayer && entry\.status === 'playing' && !!entry\.table_id/
    );
    expect(src).toMatch(/onWatchPlayer\?\.\(entry\.table_id as string\)/);
  });

  it('Ranking rows are clickable whenever the event is LIVE, late reg included', () => {
    /* 2026-08-26, third audit. This spec used to require
       `onWatchPlayer: isRunning ? ...`, i.e. `status === 'RUNNING'` — which
       made every watch surface go INERT during LATE_REG, an event that is
       dealing with players at tables. The spec was pinning the defect. The gate
       is `isLateStatus`, the same predicate the registration side already uses
       for "this event has started". */
    const page = code(read(DETAILS));
    expect(page).toMatch(/onWatchPlayer: isWatchable \? watchTable : undefined/);
    expect(page).toMatch(/const isWatchable = isLateStatus\(tournament\?\.status\)/);
    expect(page).not.toMatch(/onWatchPlayer: isRunning \?/);

    // And the tab honours it rather than deriving a second rule of its own.
    const src = code(read(RANKING_TAB));
    expect(src).toMatch(/const eventRunning = Boolean\(onWatchPlayer\)/);
    expect(src).toMatch(/const watchable = eventRunning && !out && !!entry\.table_id/);
  });

  it('every tab is mounted from one shared props object, not seven call sites', () => {
    const src = code(read(DETAILS));
    for (const tab of [
      'DetailOverviewTab',
      'BlindsTab',
      'RankingTab',
      'EntriesTab',
      'UnionsTab',
      'TablesTab',
      'RewardsTab',
    ]) {
      expect(src).toMatch(new RegExp(`<${tab} \\{\\.\\.\\.tabProps\\} />`));
    }
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
    /* 2026-08-25, second audit: this used to slice to END OF FILE, so
       `.signup-actions { display:flex; gap:10px }` satisfied both assertions
       and the test for Dan's literal complaint was tautological. Slice to the
       END OF THE RULE. */
    const start = css.indexOf('.signup-row {');
    expect(start).toBeGreaterThan(-1);
    const row = css.slice(start, css.indexOf('}', start));
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
    /* Dan 2026-08-25: "tournaments and cash games should always be defaulted to
       actual totals unless the user changes the setting to BB." What this
       guards is that the value the FELT reads is the value that gets written.

       REAIMED 2026-08-29 (second pass). It used to pin
       `toggleTableSetting('show_stack_in_bb')` inside `handleShowBBToggle` —
       and that call was real, but the function had never had a caller, so the
       assertion described a code path no player could reach. The hamburger's
       BB switch is the one in the expandable TableSettingsPanel, which writes
       through `useUserTableSettings` directly.

       What must hold is now stated positively: the canonical column is the only
       one this component touches, it never writes the legacy `profiles` mirror,
       and it never opens a second direct upsert that would race the ordered
       hook. The wrong-key bug (`showStackInBB`, which no store accepts) stays
       pinned because that one is easy to reintroduce by autocomplete. */
    expect(src).not.toMatch(/'showStackInBB'/);
    expect(src).not.toMatch(/show_stack_bb/);
    expect(src).not.toMatch(/from\('user_table_settings'\)[\s\S]{0,200}\.upsert/);
    // The canonical value still reaches the first-paint seed the felt reads.
    expect(src).toMatch(/STORAGE_KEYS\.SHOW_STACK_BB, String\(tableSettings\.show_stack_in_bb\)/);
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
    /* Not pinned to the literal `45_000` any more — the interval is a named
       constant now so the backoff path can reuse it, and a test that pins a
       number rather than the behaviour breaks on a harmless rename. */
    expect(src).toMatch(/const POLL_MS = 45_000;/);
    expect(src).toMatch(/resyncRef\.current = setInterval\(\(\) => void refresh\(\), POLL_MS\)/);
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
    /* 2026-08-26, third audit: asserting that `releaseBustHoldRef.current?.()`
       appears SOMEWHERE in a 15,000-line file is satisfied by the rebuy re-arm
       just as happily as by the backstop. Assert the timer is installed WITH
       the constant. */
    expect(src).toMatch(/hold\.deadline = setTimeout\([\s\S]{0,600}BUST_HOLD_MODAL_MS/);
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
    /* 2026-08-26, third audit: this used to be a single 400-char window match
       that `onConfirmRebuy` satisfied — so the CONFIRM path proved the claim
       about the DECLINE path, and deleting `onCloseRebuyModal` entirely still
       passed. Slice each handler and assert inside it. */
    const confirm = src.slice(src.indexOf('onConfirmRebuy'), src.indexOf('onCloseRebuyModal'));
    expect(confirm, 'a rebuy must discard the deferred exit').toMatch(
      /bustHoldRef\.current\.pendingExit = null;/
    );
    expect(confirm).toMatch(/releaseBustHold\(\)/);

    const decline = src.slice(
      src.indexOf('onCloseRebuyModal'),
      src.indexOf('onCloseRebuyModal') + 1200
    );
    expect(decline, 'declining must release the hold immediately').toMatch(/releaseBustHold\(\)/);
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

  /* ── DAN REVERSED THIS FOR THE HERO ON 2026-08-27 ────────────────────────
     Round 3: "hero's chips need to be moved up higher on the table when they
     are put into the pot, and the action pill should be below them above the
     hero's head." Raising the hero's bet collides with the one-oval rule these
     two specs were written to protect, so the conflict was put to him with the
     cost stated, and he ruled:

       "All chips in all other positions and seats should sit in the same
        position except for the hero, they need to be raised up more."

     BOTH SPECS BELOW ARE UPDATED RATHER THAN DELETED, because the complaint
     they came from has not gone away — it has a floor now as well as a
     ceiling. The 200px picture in Dan's original screenshot is still not what
     ships; the hero sits at 159px at NOMINAL_SCALER, between the 123px it had
     been pulled back to and the 200px that was too far. What changed is that
     the hero is now DELIBERATELY the outlier, by a stated amount, instead of
     accidentally the same as everybody else. */

  it("the hero's chips are still well inside the distance that drew the complaint", () => {
    const heroDist = dist(betChipOffsetPx(HERO, NOMINAL_SCALER));
    expect(heroDist).toBeGreaterThan(0);
    /* 175, up from 150, because the round-3 lift adds
       HERO_CHIP_LIFT_WIDTH_PCT (36.3px at NOMINAL_SCALER) on purpose: 123 ->
       159. Still comfortably inside the 200px that produced the complaint,
       with headroom so an honest re-tune does not trip it. If this ever fails,
       the number to look at is HERO_CHIP_LIFT_WIDTH_PCT — the ceiling is the
       screenshot, and the screenshot has not changed. */
    expect(heroDist).toBeLessThanOrEqual(175);
  });

  it('the hero is the ONE seat off the oval, by exactly the lift', () => {
    const heroDist = dist(betChipOffsetPx(HERO, NOMINAL_SCALER));
    const topDist = dist(betChipOffsetPx({ x: 50, y: 0 }, NOMINAL_SCALER));
    /* These two chairs sit opposite each other, both outside the painted felt,
       and until round 3 they were required to be identical to within rounding
       — that was the whole content of "the hero is not the outlier".

       They are no longer identical, and the difference is not drift: it is
       Dan's exception, so it is pinned to the constant that creates it rather
       than to a tolerance that would let it wander. Anything else moving these
       two apart still fails here. */
    const liftPx = (HERO_CHIP_LIFT_WIDTH_PCT / 100) * NOMINAL_SCALER.w;
    /* Take the lift back off and the ORIGINAL assertion is restored, unchanged:
       the two seats agree to within the same 20px they always had to. So this
       still fails for any reason the old one would have failed — a per-seat
       term creeping back in, a rail that treats top and bottom differently —
       and passes only for the one exception Dan named. */
    expect(heroDist - topDist).toBeGreaterThan(0);
    expect(Math.abs(heroDist - liftPx - topDist)).toBeLessThanOrEqual(20);
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
    /* 2026-08-25, second audit: this used to grep the WHOLE FILE for
       `club_id:` / `start_time:`, which ClubHomePage satisfies three times over
       without the register payload containing either. Slice to the actual
       `registerMtt({ ... })` argument and assert the rows inside it. */
    for (const f of REGISTER_SURFACES) {
      const src = code(read(f));
      const at = src.indexOf('registerMtt(');
      expect(at, `${f} must call registerMtt`).toBeGreaterThan(-1);
      // The payload object, bounded by the paren that closes the call.
      const payload = sliceCall(src, 'registerMtt(');
      expect(payload, `${f} payload must carry club_id`).toMatch(/club_id:/);
      expect(payload, `${f} payload must carry start_time`).toMatch(/start_time:/);
      /* `status` is what the hook derives late-registration from. Every caller
         used to compute it by hand and every one of them missed LATE_REG. */
      expect(payload, `${f} payload must carry status`).toMatch(/status:/);
      expect(payload, `${f} must not hand-roll the late-reg test - the hook owns it`).not.toMatch(
        /is_late_registration:\s*String\(/
      );
    }
    expect(code(read(REG_HOOK))).toMatch(/clubId: t\.club_id \?\? null/);
    expect(code(read(REG_HOOK))).toMatch(/club_id\?: string \| null/);
    // One definition of "late", and it covers LATE_REG.
    const hook = code(read(REG_HOOK));
    expect(hook).toMatch(/export function isLateStatus/);
    expect(hook).toMatch(/s === 'RUNNING' \|\| s === 'LATE_REG'/);
    expect(hook).toMatch(
      /isLateRegistration: t\.is_late_registration \?\? isLateStatus\(t\.status\)/
    );
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
    expect(src).toMatch(/queueRef\.current = queueRef\.current\.filter\(\(r\) => r\.id !== id\)/);
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
    expect(src).toMatch(/readPlayerBalance\(userId, \{ clubId \}\)/);
  });

  it('an unreadable balance never blocks a buy-in', () => {
    /* R7, and this is the one the FIRST audit fix got wrong. It called
       `getPlayerBalance`, which collapses every failure — RPC error, RLS
       denial, an unresolvable club id — into the NUMBER 0. It never throws, so
       the catch that was supposed to set `balance = null` was dead code, and a
       funded player whose read failed saw "Insufficient Balance" with Confirm
       disabled. Assert the property at BOTH ends: the gate treats null as
       unknown, AND the reader it calls can actually produce a null. */
    expect(src).toMatch(
      /const short = !usesTournamentTicket && balance !== null && balance < cost;/
    );
    expect(src).not.toMatch(/getPlayerBalance\(/);
    const wallet = code(read('src/services/WalletService.ts'));
    expect(wallet).toMatch(/async readPlayerBalance\(/);
    expect(wallet).toMatch(/balance: number \| null; source: 'rpc' \| 'wallet' \| 'failed'/);
    expect(wallet).toMatch(/return \{ balance: null, source: 'failed' \}/);
  });

  it('does not tell a late registrant they cannot unregister near the start', () => {
    // A late registration cannot be unregistered at all, and an SNG has no
    // start time for the rule to be about.
    expect(src).toMatch(/!o\.isLateRegistration && !!startLabel/);
  });

  it('traps focus and gives it back', () => {
    /* 2026-08-26, third audit: this used to assert only that a ref NAMED
       `restoreFocusRef` existed and that the string 'Tab' appeared — satisfied
       by a file that never calls `.focus()` at all. Assert the actual moves. */
    expect(src).toMatch(/restoreFocusRef\.current = document\.activeElement/);
    expect(src).toMatch(/back && typeof back\.focus === 'function'[\s\S]{0,80}back\.focus\(\)/);
    // and the trap must pull focus back IN, not merely notice Tab
    expect(src).toMatch(/if \(!inside\) \{[\s\S]{0,120}\.focus\(\)/);
  });
});

describe('Audit - the tournament HUD stops when there is nothing left to ask', () => {
  const src = code(read(HUD));

  it('stops polling only on a TERMINAL status, never on a live one', () => {
    /* The first version was an ALLOW-LIST of live statuses and stopped the
       poll on anything else — including ANNOUNCED, a perfectly live state. A
       HUD whose first read returned ANNOUNCED never polled again, which is the
       single point of failure the poll exists to remove. Deny-list now, so an
       unrecognised status keeps polling. */
    expect(src).toMatch(/const TERMINAL = \[/);
    /* The clear must be INSIDE the terminal branch. The old assertion looked
       for `clearInterval(resyncRef.current)` anywhere in the file, which the
       unmount cleanup satisfied — the stop branch could have been deleted
       outright (2026-08-26 audit). */
    expect(src).toMatch(
      /if \(t && TERMINAL\.includes\(status\)\) \{[\s\S]{0,200}clearInterval\(resyncRef\.current\)/
    );
    expect(src).not.toMatch(/status !== 'RUNNING' && status !== 'REGISTERING'/);
    // The list must cover the ends, and must NOT contain a live status.
    const m = src.match(/const TERMINAL = \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    const list = m![1];
    expect(list).toContain('COMPLETED');
    expect(list).toContain('CANCELLED');
    for (const live of ['RUNNING', 'REGISTERING', 'ANNOUNCED', 'LATE_REG']) {
      expect(list, `${live} is a live status and must not stop the poll`).not.toContain(live);
    }
  });

  it('backs the poll off on a sustained fault instead of giving up on it', () => {
    /* It used to STOP after five failures, permanently — and because
       PersistentTableLayer hides rather than unmounts, permanently meant the
       session. Five failures is about three minutes offline. */
    expect(src).toMatch(/if \(failures <= 2\) reportError/);
    expect(src).toMatch(/const BACKOFF_MS = /);
    expect(src).toMatch(/setInterval\(\(\) => void refresh\(\), BACKOFF_MS\)/);
    // and it must come BACK to the normal cadence once a read succeeds
    expect(src).toMatch(/backedOff && resyncRef\.current/);
    expect(src).toMatch(/setInterval\(\(\) => void refresh\(\), POLL_MS\)/);
    expect(src).not.toMatch(
      /if \(failures >= 5 && resyncRef\.current\) \{\s*clearInterval\(resyncRef\.current\);\s*resyncRef\.current = null;/
    );
  });

  it('does not tick once a second while hidden', () => {
    expect(src).toMatch(
      /if \(hidden \|\| !tournament \|\| tournament\.status !== 'RUNNING'\) return;/
    );
  });
});

// ─── SECOND AUDIT (2026-08-25) ────────────────────────────────────────────────
//
// The first audit's FIXES were themselves audited. These pin what that found.

describe('Second audit - the balance gate cannot lock out a funded player', () => {
  it('WalletService can report that it did not manage to read', () => {
    /* THE BUG: `getPlayerBalance` returns a `number`, so every failure — RPC
       error, RLS denial, an unresolvable club id, a dropped connection —
       becomes 0. The dialog gated on it and disabled Confirm with "Insufficient
       Balance" for players who were funded. A read that never happened is not
       a balance of zero. */
    const wallet = code(read('src/services/WalletService.ts'));
    expect(wallet).toMatch(/async readPlayerBalance\(/);
    expect(wallet).toMatch(/source: 'failed'/);
    /* The legacy-read branch this used to pin is GONE (2026-08-27), and its
       removal strengthens this spec rather than weakening it. That branch fell
       back to the retired global wallet pool, frozen since 2026-08-21 — so on
       an RPC failure the gate was answered by a six-day-old number that read
       up to 95x high. "A read that never happened is not a balance of zero"
       is the rule; a read that never happened is not a balance of THREE
       MILLION either. There is now exactly one live source and one honest
       failure value. */
    expect(wallet).not.toMatch(/from\('wallets'\)/);
    expect(wallet).toMatch(/return \{ balance: null, source: 'failed' \}/);
  });

  it('a genuine zero still comes back as zero — from the LIVE source', () => {
    /* Failing OPEN on a real zero would be its own bug, and that distinction
       survives: it just has to be earned from the live pool rather than from a
       frozen table. `fn_player_spendable_balance` returning 0 is a genuine
       zero and is reported as `source: 'rpc'`; only an RPC that does not
       ANSWER yields null. A missing row in a table nothing has written since
       2026-08-21 was never evidence of anything, which is why the old
       fallback that claimed it was is gone. */
    const wallet = code(read('src/services/WalletService.ts'));
    expect(wallet).toMatch(/fn_player_spendable_balance/);
    expect(wallet).toMatch(/Number\(\(data as any\)\.balance\) \|\| 0, source: 'rpc'/);
  });

  it('and the busted-player rebuy no longer turns unknown into zero', () => {
    /* Same rule, the site the 2026-08-25 audit did not reach: TablePage read
       the balance for the bust-rebuy dialog and wrote `r.balance ?? 0`,
       collapsing "could not find out" into "you have no chips" on a state
       already typed `number | null`. */
    const page = code(read('src/pages/TablePage.tsx'));
    expect(page).not.toMatch(/setBustWalletBalance\(r\.balance \?\? 0\)/);
    /* 2026-09-04: the read moved into readBustBalance (null after one retry,
       never 0 for "unknown") and the layer stopped re-collapsing it - see
       tests/run-it-multiple-times-tells-the-truth.law.test.ts. */
    expect(page).toMatch(/setBustWalletBalance\(await readBustBalance\(userId, tableId\)\)/);
    expect(read('src/components/table/TableModalsLayer.tsx')).not.toContain(
      'accountBalance={bustWalletBalance ?? 0}'
    );
  });
});

describe('Second audit - a request cannot be lost between enqueue and unmount', () => {
  const src = code(read(SIGNUP_TSX));

  it('the queue ref is written synchronously, never during render', () => {
    /* R8. `queueRef.current = queue` during render lagged the truth by a
       commit, so a request enqueued in the same batch as an unmount was
       invisible to the drain and its promise hung forever — bricking the
       caller's Register button, which is exactly the failure R3 names. */
    expect(src).not.toMatch(/queueRef\.current = queue;/);
    expect(src).toMatch(/queueRef\.current = \[\.\.\.queueRef\.current, req\]/);
  });
});

describe('Second audit - the focus trap and Escape behave', () => {
  const src = code(read(SIGNUP_TSX));

  it('traps Tab even when focus is on the card itself', () => {
    /* With Confirm disabled the open-effect focuses the CARD, and
       `card.contains(card)` is true — so the old test believed focus was
       already on a control and trapped nothing. Shift+Tab walked out of a
       dialog that takes money. */
    expect(src).toMatch(/active !== cardRef\.current/);
    expect(src).toMatch(/if \(!inside\) \{/);
  });

  it('does not swallow Escape for the rest of the app', () => {
    // Capture-phase on window is the FIRST node in the path; stopping there
    // blocked Escape for every deeper listener while the dialog was open.
    const esc = sliceBlockAfter(src, "if (e.key === 'Escape')");
    expect(esc).not.toMatch(/stopPropagation/);
  });
});

describe('Second audit - busting cannot strand a player at a dead seat', () => {
  const src = code(read(TABLE_PAGE));

  it('releasing with nothing to replay still gets the player out', () => {
    /* THE BUG: `pendingExit` is only set by the elimination broadcast. On the
       ordinary path this watcher exists for — hand settled, stack zero, no
       broadcast — release did NOTHING: modal gone, hero still seated with no
       chips, no result card, and `bustPromptFiredRef` still true so it could
       never re-prompt. */
    expect(src).toMatch(/exitIfBustedRef\.current\?\.\(\)/);
    expect(src).toMatch(/const exitIfBustedRef = useRef/);
  });

  it('the fallback exit re-checks the stack, so a rebuy is never ejected', () => {
    const impl = sliceBlockAfter(src, 'exitIfBustedRef.current = () => {');
    expect(impl).toMatch(/if \(stack > 0\) return;/);
  });

  it('the backstop does not cancel a rebuy that is mid-flight', () => {
    expect(src).toMatch(/if \(rebuyProcessingRef\.current\) \{/);
  });
});

describe('Second audit - the featured table is never a stale one', () => {
  it('an empty live-table set means no leader, not an unfiltered leader', () => {
    /* The filter used to disable ITSELF when the live set was empty
       (`activeTableIds.size === 0 || ...`) — which is the state on first render
       before the tables query resolves, and when every table is closed. The
       leader's stale table_id was returned before the live-only fallback was
       ever reached. */
    const src = code(read(DETAILS));
    expect(src).not.toMatch(/activeTableIds\.size === 0 \|\| activeTableIds\.has/);
    expect(src).toMatch(/\.filter\(\(e\) => activeTableIds\.has\(e\.table_id as string\)\)/);
  });
});

describe('Second audit - a button labelled Watch actually watches', () => {
  it('the lobby card carries the intent and the details page acts on it', () => {
    const card = code(read('src/components/tournament/TournamentLobbyCard.tsx'));
    expect(card).toMatch(/\?watch=1/);
    const src = code(read(DETAILS));
    expect(src).toMatch(/get\('watch'\) !== '1'/);
    expect(src).toMatch(/watchIntentDoneRef/);
    // once only, and only for a running event
    /* Was `status !== 'RUNNING'`, which ignored the intent for a LATE_REG
       event (2026-08-26 audit). And the intent must be CONSUMED from the url,
       or pressing Back re-fires it and drags the player onto the felt again. */
    expect(src).toMatch(/if \(!isWatchable\) return;/);
    expect(src).toMatch(/params\.delete\('watch'\)/);
    expect(src).toMatch(/\{ replace: true \}/);
  });
});

describe('Second audit - dead code is gone', () => {
  it('MiniStatsCard has no unreachable expanded panel', () => {
    /* `expanded` was `showRealTimeResults || isExpanded`; nothing passes the
       prop and TablePage always passes `onTap`, so the only writer of
       `isExpanded` was unreachable and ~70 lines never rendered. */
    const src = code(read('src/components/table/MiniStatsCard.tsx'));
    expect(src).not.toMatch(/mini-stats-card--expanded/);
    expect(src).not.toMatch(/showRealTimeResults/);
    expect(src).not.toMatch(/setIsExpanded/);
  });

  it('a tournament buy-in tells the rest of the app the balance moved', () => {
    // The old inline register path emitted this; routing every surface through
    // the hook dropped it, so wallet displays kept the pre-buy-in figure.
    expect(code(read(REG_HOOK))).toMatch(/masterBus\.emit\('BALANCE_UPDATED'/);
  });
});
