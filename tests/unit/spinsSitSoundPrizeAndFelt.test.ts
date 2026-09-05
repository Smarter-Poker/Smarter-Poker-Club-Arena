/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE EIGHT THINGS DAN REPORTED ABOUT SPINS ON 2026-09-05
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every block below pins one sentence of his report, and every one of them is
 * a bug that actually shipped. They are gathered in one file because they are
 * one session's findings and because six of the eight share a single root
 * cause - a seat that holds chips before the game starts.
 *
 * Source-text pins, bounded by the structure they are about (see
 * tests/helpers/sourceWindow.ts for why a byte count is not allowed to bound
 * one of these).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock, sliceMethod } from '../helpers/sourceWindow';

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const TABLE_PAGE = read('src', 'pages', 'TablePage.tsx');
const TABLE_CSS = read('src', 'pages', 'TablePage.css');
const SEAT_CSS = read('src', 'components', 'table', 'SeatSlot.css');
const RANKING_HOST = read('src', 'components', 'tournament', 'TournamentRankingHost.tsx');
const MULTI_TABLE = read('src', 'pages', 'MultiTablePage.tsx');
const QUICK_JOIN_SPINS = read('src', 'lib', 'quickJoinSpins.ts');
const ENGINE_BASE = read('server', 'src', 'tournament', 'TournamentManagerBase.ts');
const SOUND = read('src', 'services', 'SoundService.ts');

/* ─────────────────────────────────────────────────────────────────────────
   1. "WHEN I TRY TO JOIN A SPIN THAT ALREADY HAS HORSES REGISTERED, I DON'T
       GET OR HAVE A 'SIT +' BUTTON AVAILABLE."
   ───────────────────────────────────────────────────────────────────────── */
describe('a paid seat is not a started game', () => {
  it('the begun-latch reads the button and the hand, never a stack', () => {
    const m = /const begun =\s*([^;]+);/.exec(TABLE_PAGE);
    expect(m, 'the playHasBegun latch moved - re-point this pin').toBeTruthy();
    const expr = m![1];
    expect(expr).toContain('dealerSeat > 0');
    expect(expr).toContain('handNumber');
    /* THE WHOLE BUG. `players.some(p => p.stack > 0)` was decisive when a
       seat-first seat held zero chips until the wheel landed. Migration
       20260901154500 made both seating paths write starting_chips at
       purchase, so from that day the first seat SOLD latched the game as
       started - and on a horse-seeded Spin that happened before the player
       ever opened the table. canSit went false and every chair rendered as
       an inert EMPTY plate. */
    expect(expr).not.toContain('stack');
  });

  it('the mount read latches it from the tournament row instead', () => {
    /* A player arriving at a game already in progress used to latch off the
       stacks. The row says it directly, and earlier.

       Bounded by the `if` block itself, never by a byte count - a comment
       added inside it would walk the assertions off the end of a fixed
       window, silently, which is what tests/helpers/sourceWindow exists to
       prevent (and what noFixedSizeSourceWindows caught me doing). */
    expect(TABLE_PAGE).toContain('if (!openForSeats) {');
    const latch = sliceEnclosingBlock(TABLE_PAGE, 'if (!openForSeats) {', 0, 1);
    expect(latch).toContain('playHasBegunRef.current = true');
    expect(latch).toContain('setPlayHasBegun(true)');
  });

  it('canSit still opens the seat for a seat-first game', () => {
    // The gate itself is unchanged and must stay that way: it is what turns
    // the fixed latch back into a visible SIT plate.
    expect(TABLE_PAGE).toContain('(!tableState.isTournament || !!seatFirstBuyIn)');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2. "THERE IS NO SOUND EFFECT OR COUNT DOWN FOR THE SPIN ANIMATION."
   ───────────────────────────────────────────────────────────────────────── */
describe('the wheel is anchored to the instant the engine chose', () => {
  it('the client prefers spin_reveal_at over started_at', () => {
    expect(TABLE_PAGE).toContain('row?.spin_reveal_at ? Date.parse(row.spin_reveal_at)');
    // started_at survives as the fallback for rows drawn before the column.
    expect(TABLE_PAGE).toContain('Number.isFinite(anchorMs)');
    expect(TABLE_PAGE).toContain('Number.isFinite(startedAtMs)');
  });

  it('every read that builds the wheel asks for the column', () => {
    // Two call sites feed buildSpinDrawFromRow: the mount read and the D2
    // post-start recheck. A select that omits it silently reverts this fix.
    const selects = TABLE_PAGE.match(/\.select\(\s*'[^']*spin_multiplier[^']*'/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const sel of selects) expect(sel).toContain('spin_reveal_at');
  });

  it('the engine writes the anchor on the row that already carries the lag', () => {
    expect(ENGINE_BASE).toContain('spin_reveal_lag_ms: Math.round(this.spinRevealLagMs)');
    expect(ENGINE_BASE).toContain('spin_reveal_at:');
    // Zero means never stamped; null then, so the client keeps its fallback
    // rather than being handed the epoch and skipping the whole sequence.
    expect(ENGINE_BASE).toContain(
      'this.spinRevealAt > 0 ? new Date(this.spinRevealAt).toISOString() : null'
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3. "THE TOTAL PRIZE OR MULTIPLIER FOR THE SPIN NEEDS TO BE PRESENT ON THE
       FELT AFTER THE SPIN RUNS."
   ───────────────────────────────────────────────────────────────────────── */
describe('the badge outlives the wheel', () => {
  it('the live SPIN_REVEAL path writes the multiplier into table state', () => {
    const i = TABLE_PAGE.indexOf("case 'SPIN_REVEAL':");
    expect(i).toBeGreaterThan(0);
    const window = TABLE_PAGE.slice(i, TABLE_PAGE.indexOf("case 'SPIN_CHIPS':", i));
    /* Before today only the MOUNT read set this, so the badge appeared for
       somebody who refreshed into a running spin and never for the three
       players who actually watched the wheel. */
    expect(window).toContain('spinMultiplier: mult');
    expect(window).toContain('prize_pool');
  });

  it('the felt badge renders the prize beside the multiplier', () => {
    expect(TABLE_PAGE).toContain('spinMultiplierPrize');
    expect(TABLE_PAGE).toContain('(tableState.spinPrizePool ?? 0) > 0');
    expect(TABLE_CSS).toContain('.spinMultiplierPrize');
  });

  it('a rejoin reads the prize off the tournament row', () => {
    expect(TABLE_PAGE).toContain('spinPrizePool: Number(tournData.prize_pool) || undefined');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4. "YOUR RESULT CARD SHOULD ONLY DISPLAY ON THE ... LOBBY TAB YOU ARE IN,
       NOT EVERY SINGLE PAGE INSIDE THE CLUB ARENA."
   ───────────────────────────────────────────────────────────────────────── */
describe('the result card belongs to the page it landed on', () => {
  it('anchors on a route and clears when the player leaves it', () => {
    expect(RANKING_HOST).toContain('useLocation');
    expect(RANKING_HOST).toContain('cardRouteRef');
    expect(RANKING_HOST).toContain('clearSessionSummary()');
  });

  it('never anchors on the table route it was published from', () => {
    /* TablePage publishes and THEN navigates, so the card's first render is
       on /table/<id>. Anchoring there would clear it on the exit navigation
       and Dan would never see the card at all. */
    expect(RANKING_HOST).toContain("location.pathname.includes('/table/')");
  });

  it('is not on a timer - Dan 2026-08-30: it never auto-closes', () => {
    expect(RANKING_HOST).not.toContain('setTimeout(() => clearSessionSummary');
    expect(RANKING_HOST).not.toContain('setInterval');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   6. "WHEN YOU ARE INSIDE A SPIN, AND HIT THE + BUTTON, IT SHOULD RECOMMEND
       MORE SPINS, NOT CASH GAMES."
   ───────────────────────────────────────────────────────────────────────── */
describe('a spin offers more spins', () => {
  it('quick join asks the spin branch before the cash query', () => {
    /* The first `.is('tournament_id', null)` in this file is inside the
       comment explaining WHY the branch exists, so the pin has to find the
       CALL - the one preceded by a `.` on its own line inside the query
       chain - rather than the first textual match. */
    const i = MULTI_TABLE.indexOf('quickJoinSpinRows(scopeClubIds');
    const j = MULTI_TABLE.indexOf("\n            .is('tournament_id', null)");
    expect(i, 'the spin branch call moved').toBeGreaterThan(0);
    expect(j, 'the cash candidate query moved').toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });

  it('scopes to the same club pair the cash path uses', () => {
    // The 2026-08-26 scope bug emptied this sheet for every union player by
    // filtering on the entry club alone. Same pair, same reason.
    expect(MULTI_TABLE).toContain('quickJoinSpinRows(scopeClubIds, activeTableId, openIds)');
    expect(QUICK_JOIN_SPINS).toContain("q.in('club_id', scopeClubIds)");
  });

  it('only fires for a real spin, and both columns decide that', () => {
    expect(QUICK_JOIN_SPINS).toContain("String(t.variant ?? '').toLowerCase() === 'spin'");
    expect(QUICK_JOIN_SPINS).toContain("String(t.tournament_type ?? '').toUpperCase() === 'SPIN'");
  });

  it('falls through to the cash sheet rather than showing an empty one', () => {
    // null on every failure path AND on a readable-but-empty result.
    expect(QUICK_JOIN_SPINS).toContain('if (rows.length === 0) return null;');
    expect(QUICK_JOIN_SPINS).toContain("reportError(err as Error, 'QuickJoinSpins.unexpected')");
  });

  it('offers only boards that are open and not already in a tab', () => {
    expect(QUICK_JOIN_SPINS).toContain("in('status', ['REGISTERING', 'ANNOUNCED'])");
    expect(QUICK_JOIN_SPINS).toContain('openTableIds.has(live.id)');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   7. "THE 6 HANDED TABLE SHOULDN'T BE AS TALL AS THE 9 HANDED TABLE."
   ───────────────────────────────────────────────────────────────────────── */
describe('a six-handed table is shorter than a nine-handed one', () => {
  const smallRingHeight = () => {
    const m = /data-seats='6'\]\s*\.table-scaler\s*\{\s*--sp-table-ar-h:\s*(\d+)/.exec(TABLE_CSS);
    expect(m, 'the small-ring canvas override moved - re-point this pin').toBeTruthy();
    return Number(m![1]);
  };

  it('publishes the seat count so CSS can see it', () => {
    expect(TABLE_PAGE).toContain('data-seats={Math.min(');
    expect(TABLE_PAGE).toContain('MAX_SUPPORTED_SEATS');
  });

  it('shortens the canvas for every ring below seven', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      expect(TABLE_CSS).toContain(`.table-page[data-seats='${n}'] .table-scaler`);
    }
    expect(smallRingHeight()).toBeLessThan(1000);
  });

  it('leaves seven, eight and nine on the full canvas', () => {
    for (const n of [7, 8, 9]) {
      expect(TABLE_CSS).not.toContain(`.table-page[data-seats='${n}'] .table-scaler`);
    }
  });

  it('the width derivation and the aspect ratio read the same two tokens', () => {
    /* 605/1000 used to be written into both. Shortening one without the other
       re-engages the max-height clamp that the width derivation exists to
       avoid, and the seat ring is then measured against a box of a shape it
       was never measured on. */
    expect(TABLE_CSS).toContain('aspect-ratio: var(--sp-table-ar-w) / var(--sp-table-ar-h)');
    expect(TABLE_CSS).toContain(
      'calc(var(--sp-table-h, 100dvh) * var(--sp-table-ar-w) / var(--sp-table-ar-h))'
    );
  });

  it('does not shorten past the MEASURED banner clearance', () => {
    /* This bound was arithmetic once - "0.05 * (1000 - H) <= 5px of spare, so
       H >= 900" - derived from a prose description of a clearance. Then it was
       measured in Chromium against the real stylesheet (the harness from
       tests/e2e/top-rail-seat.spec.ts), and the estimate was optimistic:

           H = 1000  4.2px     H = 960  2.2px
           H =  980  3.2px     H = 940  1.2px     H = 920  0.2px

       920 passed the arithmetic and leaves 0.2px, which is a rounding error
       away from the 2026-08-19 bug the top-row cap exists to prevent. The
       floor is the measurement, not the formula. */
    const MEASURED_CLEARANCE_PX: Record<number, number> = {
      1000: 4.2,
      980: 3.2,
      960: 2.2,
      940: 1.2,
      920: 0.2,
    };
    const H = smallRingHeight();
    const clearance = MEASURED_CLEARANCE_PX[H];
    expect(
      clearance,
      `no measurement on record for a ${H}-unit canvas - re-run the harness before changing it`
    ).toBeDefined();
    // 2px of margin, so sub-pixel rounding on a real device cannot cross zero.
    expect(clearance).toBeGreaterThanOrEqual(2);
  });

  it('the top row is capped per CANVAS, because the same cap measures both ways', () => {
    /* 76px on the full canvas clears by 3.9px; the SAME 76px on the short
       canvas (shorter, and its top seat sits at y 5 not y 6) measures -8.1px,
       eight pixels inside the banner. So the cap is two rules, not one
       literal. */
    expect(SEAT_CSS).toContain('--seat-avatar-base: min(var(--seat-avatar-full), 76px)');
    /* MOVED 2026-09-05 with the selector it guards (CLAUDE.md 5.8). This asked
       for five literal `.table-page[data-seats='N'] ...` selectors, which is
       what shipped - and which is 0-4-0, so it out-specified BOTH the
       tournament exemption and the empty-seat exemption and capped every Spin
       at 56px. The ring list is inside `:where()` now, contributing zero
       specificity.

       This pin can only ever see TEXT. What actually decides the cap is
       arithmetic over the three selectors, so that lives in
       tests/unit/topRailCapCascade.test.ts and this one stays a text pin about
       the ring list. */
    for (const n of [2, 3, 4, 5, 6]) {
      expect(SEAT_CSS).toContain(`[data-seats='${n}']`);
    }
    // Prettier breaks the :where() list across lines, so the pin is on the
    // construct rather than on one formatting of it.
    expect(SEAT_CSS).toMatch(/\.table-page:where\(\s*\[data-seats='2'\]/);
    const shortRule = SEAT_CSS.slice(SEAT_CSS.indexOf('.table-page:where('));
    expect(shortRule.slice(0, shortRule.indexOf('}'))).toContain(
      '--seat-avatar-base: min(var(--seat-avatar-full), 56px)'
    );
  });

  it('the bust scale the clearance was measured at has not moved', () => {
    expect(SEAT_CSS).toContain('--sp-bust-scale: 1.05');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   10. "THE CARDS, EVEN IF THE AVATAR IS SQUISHED (FOR A 9 HANDED GAME) MUST
        ALWAYS DISPLAY AT THE SAME HEIGHT AS ANY AND ALL OTHER CARDS AT THE
        TABLE WHEN 'SHOWN DOWN'."
   ───────────────────────────────────────────────────────────────────────── */
describe('a shown hand is the same size at every seat', () => {
  const revealBlock = () => {
    const i = SEAT_CSS.indexOf('.seat__cards--opponent.seat__cards--revealed {');
    expect(i).toBeGreaterThan(0);
    return SEAT_CSS.slice(i, SEAT_CSS.indexOf('\n}', i));
  };

  it('the revealed card is sized from the table slot, not this seat', () => {
    /* --seat-avatar-full is declared on .seat from --table-w, so every seat
       computes the SAME number whatever its own avatar was capped to. The top
       row is capped at 56px for banner clearance and was therefore showing a
       31px hand beside everyone else's 46.5px. */
    expect(revealBlock()).toContain(
      '--vh-card-h: max(17px, calc(var(--seat-avatar-full, 84px) * 0.346 * var(--vh-reveal)))'
    );
  });

  it('the resting rosette still scales with its own pod', () => {
    // Only the reveal is equalised; the face-down marker is meant to be small
    // and proportional to the seat it sits on.
    const i = SEAT_CSS.indexOf('.seat__cards--opponent {');
    const base = SEAT_CSS.slice(i, SEAT_CSS.indexOf('\n}', i));
    expect(base).toContain('--seat-avatar-size, 84px) * 0.346');
  });

  it('the top row keeps its own vertical anchor', () => {
    // The row's BOTTOM edge is pinned 1px above the plate, and where the plate
    // is depends on this seat's real avatar. Equalising that too would float
    // the hand off the pod.
    expect(SEAT_CSS).toContain(
      '.seat-wrapper--top .seat .seat__cards--opponent.seat__cards--revealed'
    );
    const i = SEAT_CSS.indexOf(
      '.seat-wrapper--top .seat .seat__cards--opponent.seat__cards--revealed'
    );
    expect(SEAT_CSS.slice(i, SEAT_CSS.indexOf('\n}', i))).toContain('--seat-avatar-size');
  });
});

describe('the spin reveal is a sequence, so no beat of it can be suppressed', () => {
  /* ROUND 18, 2026-09-05. Round 1 gave the reveal its cues and Dan still
     reported "NO SOUND EFFECT AND NO COUNTDOWN". Every cue existed, was
     wired, and was called; `shouldPlay` was throwing them away.

     The gate is `rank <= currentFramePriority`, held for 50ms by whoever won
     it. playSpinStart is big_win (95) and the countdown and the ticking are
     ui (10), so any client that arrived mid reveal - where SpinWheel's `at()`
     clamps every past beat to 0 and schedules them into ONE frame - heard the
     lever and nothing else. The result cue is 95 as well, and the comparison
     is `<=`, so the reveal ate its own climax.

     The four now go through shouldPlaySpinCue, which is the mechanism
     playPotCollect already moved to for exactly this reason (that move is
     pinned in tests/animations-always-play.law.test.ts). */

  /* No leading indent in these needles, deliberately: sliceMethod derives the
     closing indent from the text between the line start and the match, so a
     needle that already contains the indent computes '' and runs to the end of
     the class - a window that is green on every negative assertion. */
  const CUES: Record<string, string> = {
    playSpinStart: 'playSpinStart()',
    playSpinCountdownLight: 'playSpinCountdownLight(step',
    playSpinTicking: 'playSpinTicking(durationMs',
    playSpinMultiplierResult: 'playSpinMultiplierResult(multiplier',
  };
  const cue = (name: string) => sliceMethod(SOUND, CUES[name]);
  const helper = () => sliceMethod(SOUND, 'private shouldPlaySpinCue(cue');

  it('none of the four reveal cues is ranked against the felt any more', () => {
    for (const name of [
      'playSpinStart',
      'playSpinCountdownLight',
      'playSpinTicking',
      'playSpinMultiplierResult',
    ]) {
      expect(cue(name)).not.toContain('this.shouldPlay(');
      expect(cue(name)).toContain('this.shouldPlaySpinCue(');
    }
  });

  it('the countdown throttle is keyed per step, so three lights are three cues', () => {
    // One shared key would make lights 2 and 3 duplicates of light 1 and drop
    // them - the same bug in a new place.
    expect(cue('playSpinCountdownLight')).toContain('`countdown:${step}`');
  });

  it('every reveal cue still answers to the master switch', () => {
    // Leaving the rank window must not leave the mute switch. This is the one
    // gate that has to survive.
    expect(helper()).toContain('if (!this.enabled || !isSoundAllowed()) return false;');
  });

  it('the reveal no longer parks the priority window against the table', () => {
    // playSpinStart used to set currentFramePriority to 95 for 50ms, so a
    // deal or a chip landing beside the lever was eaten BY the wheel.
    expect(helper()).not.toContain('currentFramePriority');
  });
});

describe('the spin quick-join sheet is live for as long as it is open', () => {
  /* ROUND 18, 2026-09-05. Dan: "YOU NEED TO INSURE THAT REAL TIME CONNECTIONS
     ARE FULLY ADDED TO THIS."

     The sheet was a snapshot taken when "+" was pressed. A spin board holds
     three seats, usually has two of them filled when the sheet renders, and
     the fleet takes the last one within 90-350 seconds of a human sitting - so
     the row a player taps can already have started. Both `tables` and
     `tournaments` are in the supabase_realtime publication, so the fill was
     already on the wire and nothing was listening to it. */

  const effect = () => sliceEnclosingBlock(MULTI_TABLE, 'quick-join-spins-', 0, 1);

  it('subscribes to both tables the fill is written to', () => {
    expect(effect()).toContain("table: 'tournaments'");
    expect(effect()).toContain("table: 'tables'");
  });

  it('refreshes without blanking the sheet the player is reading', () => {
    // Re-running the loader would set { loading: true, rows: [] } and flash a
    // spinner over a list being read. The refresh patches rows in place.
    const e = effect();
    expect(e).toContain('loading: false');
    expect(e).not.toContain('rows: [] }');
  });

  it('a failed or empty re-read leaves the rows alone', () => {
    // `null` from quickJoinSpinRows means "could not answer", never "no spins".
    expect(effect()).toContain('if (cancelled || !rows) return;');
  });

  it('the channel is torn down when the sheet closes', () => {
    expect(effect()).toContain('supabase.removeChannel(channel)');
  });

  it('the cash sheet is never overwritten by a spin refresh', () => {
    // The spin branch stores its scope; the cash fall-through clears it, so the
    // effect stays inert over a cash list.
    expect(MULTI_TABLE).toContain('setSpinSheetScope({ scopeClubIds, activeTableId });');
    expect(MULTI_TABLE).toContain('setSpinSheetScope(null);');
    expect(effect()).toContain(
      'if (!spinSheetScope || spinSheetScope.scopeClubIds.length === 0) return;'
    );
  });

  it('every listener carries its club, so the sheet is not a firehose', () => {
    // tests/no-unfiltered-realtime-firehose: unfiltered listeners on `tables`
    // and `tournaments` were ~80% of 86 million realtime messages in one
    // billing cycle, and this effect mounts for every player who presses "+".
    const e = effect();
    expect(e).toContain('filter: `club_id=eq.${clubId}`');
    expect(e).not.toMatch(/table: 'tournaments' \}/);
    expect(e).not.toMatch(/table: 'tables' \}/);
  });

  it('the scope is state, so the subscription arms on the FIRST opening', () => {
    // The loader is async: `quickJoin.open` is true a round trip before the
    // spin branch knows its scope. A ref read by an effect keyed on `open`
    // alone is still null at that moment, and never re-runs.
    expect(MULTI_TABLE).toContain('const [spinSheetScope, setSpinSheetScope] = useState<{');
    expect(MULTI_TABLE).toContain('}, [quickJoin.open, spinSheetScope]);');
  });
});
