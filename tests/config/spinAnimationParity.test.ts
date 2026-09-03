/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN / CASH ANIMATION PARITY — a Spin table is a cash table that ends sooner
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan's brief: the Spin path must be a true 1:1 clone of the cash-game
 * animations. Structurally it already was - `TablePage` renders both, and
 * ChipPhysics, CommunityCards, PotDisplay, DealAnimation, ActionPanel and every
 * hook under `src/hooks/useTable*` contain not one mention of a tournament. The
 * divergences were four specific conditionals and two unhandled events.
 *
 *   1. useUserThemeSettings was passed `undefined` for the tournament type,
 *      under a comment claiming it was "resolved internally from gameType".
 *      It is not - getThemeGameType has no other source - so every tournament
 *      fell to the 'MTT' default. A Spin resolved the player's MTT felt,
 *      background, deck and button art instead of the SNG row it shares with
 *      heads-up, and the four data-* theme attributes on the table root came
 *      off that same wrong value. Not a missing preference: a different table.
 *
 *   2. SeatSlot suppressed getStackDepthClass unless showStackInBB was on,
 *      which meant `stackCriticalPulse` - the infinite sub-10bb warning - did
 *      not run in tournaments. A hyper-turbo Spin is the one format where a
 *      sub-10bb stack is the normal state of affairs. A cash table at 8bb
 *      pulsed; a Spin at 8bb sat still.
 *
 *   3. SeatSlot returned a bare unlabelled div for every empty seat in a
 *      tournament, before `canSit` was consulted. At an MTT that is harmless.
 *      At a seat-first Spin, where the three seats are sold by the click, it
 *      meant the footer read "Spectating, Tap An Open Seat To Join" over seats
 *      that carried no label, did not breathe, and had no click handler. This
 *      was not an animation gap, it was an instruction that could not be
 *      followed.
 *
 *   4. `spin_chips` and `spin_button` had no client handler at all. The engine
 *      broadcasts both and holds the deal 1.8s for them, saying in its own
 *      comment that it does so "so the client can animate them rather than
 *      discovering them in a state diff". The chips and the puck did appear -
 *      whenever the next snapshot landed - so the two beats Dan named
 *      ("CHIP STACKS GET ADDED, BUTTON RANDOMLY ASSIGNED") existed on the
 *      engine's clock and nowhere on the player's.
 *
 * These read source rather than execute it, in the house style of
 * spinEngineWiring and spinReserveOwnership: the table needs a live engine and
 * three seated players. The E2E beat spec covers the CSS these fixes drive.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveThemeBucket } from '../../src/hooks/useUserThemeSettings';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** Comments quote the very things these tests ban. Never match against them. */
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const page = tsCode(read('src/pages/TablePage.tsx'));
const seat = tsCode(read('src/components/table/SeatSlot.tsx'));
const themeHook = tsCode(read('src/hooks/useUserThemeSettings.ts'));
const seatCss = read('src/components/table/SeatSlot.css');
const engine = tsCode(read('server/src/tournament/TournamentManagerBase.ts'));

describe('1. a Spin resolves its own theme, not the MTT default', () => {
  it('passes the resolved tournament format to the theme hook', () => {
    const call = page.slice(
      page.indexOf('useUserThemeSettings('),
      page.indexOf(');', page.indexOf('useUserThemeSettings('))
    );
    expect(call).toMatch(/tournamentFormat/);
    // The regression, verbatim: a literal undefined in the type slot.
    expect(call).not.toMatch(/^\s*undefined\s*$/m);
  });

  it('still maps spin and sng to the same theme row', () => {
    expect(themeHook).toMatch(/tournamentType === 'sng' \|\| tournamentType === 'spin'/);
    expect(themeHook).toMatch(/return 'SNG'/);
  });

  it('refuses to resolve a theme for a tournament whose format is unknown', () => {
    // Without this the hook answers MTT for one render and the felt changes
    // under the player when the real format arrives.
    //
    // 2026-08-25: this used to grep the hook's source for the literal line
    // `if (isTournament && !tournamentType) return;`. The guard moved into an
    // exported function during the theme-persistence audit, unchanged in
    // behaviour, and a text match cannot tell those two things apart. Asserting
    // the behaviour instead: a tournament with no format resolves NO bucket,
    // and one with a format resolves the right one.
    expect(resolveThemeBucket(undefined, true, undefined)).toBeNull();
    expect(resolveThemeBucket(undefined, true, '')).toBeNull();
    expect(resolveThemeBucket(undefined, true, 'spin')).toBe('SNG');
    expect(resolveThemeBucket(undefined, true, 'mtt')).toBe('MTT');
    // A cash table has nothing to wait for and must resolve immediately.
    expect(resolveThemeBucket('nlh', false, undefined)).toBe('NLH');
  });
});

describe('2. the sub-10bb warning runs wherever a stack is short', () => {
  it('applies the stack depth class unconditionally', () => {
    expect(seat).toMatch(/\$\{getStackDepthClass\(player\.stack, bigBlind\)\}/);
    expect(seat).not.toMatch(/showStackInBB \|\| !isTournament \? getStackDepthClass/);
  });

  it('keeps the class it depends on, and its duration', () => {
    expect(seat).toMatch(/return 'seat__stack--critical'/);
    expect(seatCss).toMatch(
      /\.seat__stack--critical\s*\{[^}]*animation:\s*stackCriticalPulse 1\.5s[^}]*infinite/
    );
  });
});

describe('3. an empty seat is decided by whether it can be taken', () => {
  it('has no tournament short-circuit before the canSit branch', () => {
    const empty = seat.slice(seat.indexOf('if (!player) {'), seat.indexOf('OCCUPIED SEAT'));
    expect(empty).not.toMatch(/if \(isTournament\)/);
    expect(empty).toMatch(/if \(!canSit\)/);
    // 2026-08-26: text spans replaced by <img class="seat__empty-img">
    expect(empty).toMatch(/seat__empty-img/);
  });

  it('branches no visual inside SeatSlot on tournament-ness at all', () => {
    // The memo comparator may still read it off the props objects; nothing in
    // the render body may.
    const body = seat.slice(seat.indexOf('if (!player) {'));
    const bare = body.replace(/prev\.isTournament|next\.isTournament/g, '');
    expect(bare).not.toMatch(/\bisTournament\b/);
  });

  it('lets TablePage open the seat for the seat-first formats only', () => {
    const canSit = page.slice(page.indexOf('canSit={'), page.indexOf('isHeroReservedSeat={'));
    expect(canSit).toMatch(/!tableState\.isTournament \|\| !!seatFirstBuyIn/);
  });

  it('keeps the pseudo-element disabled on all empty seats (no breathing ring)', () => {
    // 2026-08-26: the pulse ring was replaced by the coin image asset.
    // The ::before pseudo-element is suppressed via content:none on all seats.
    expect(seatCss).toMatch(/\.seat--empty::before\s*\{[^}]*content:\s*none/);
  });
});

describe('4. the two beats after the wheel are animated on the engine clock', () => {
  it('the engine still broadcasts both', () => {
    expect(engine).toMatch(/type: 'spin_chips'/);
    expect(engine).toMatch(/type: 'spin_button'/);
    expect(engine).toMatch(/starting_stack: stack/);
    expect(engine).toMatch(/dealer_seat: seat/);
  });

  it('the client handles both', () => {
    // Events are uppercased before the switch (evt.type = rawType.toUpperCase()).
    expect(page).toMatch(/case 'SPIN_CHIPS':/);
    expect(page).toMatch(/case 'SPIN_BUTTON':/);
  });

  it('the chip beat credits only seats that are still empty-handed', () => {
    const branch = page.slice(
      page.indexOf("case 'SPIN_CHIPS':"),
      page.indexOf("case 'SPIN_BUTTON':")
    );
    expect(branch).toMatch(/starting_stack/);
    // Rewriting a seat that already has chips fires a second delta animation
    // off a number that did not change.
    expect(branch).toMatch(/\(pl\.stack \?\? 0\) <= 0/);
    expect(branch).toMatch(/return prev;/);
  });

  it('the button beat writes the seat the engine drew, and nothing else', () => {
    const branch = page.slice(
      page.indexOf("case 'SPIN_BUTTON':"),
      page.indexOf("case 'GAME_START':")
    );
    expect(branch).toMatch(/dealer_seat/);
    expect(branch).toMatch(/dealerSeat: seat/);
    // No client-side draw. The engine picks, at random, and says so - a second
    // opinion here is how two players see two different buttons.
    expect(branch).not.toMatch(/Math\.random/);
  });

  it('keeps the mount animation the button beat relies on', () => {
    expect(seatCss).toMatch(/animation:\s*dealerButtonAppear 0\.4s/);
    expect(seatCss).toMatch(/@keyframes dealerButtonAppear/);
  });

  it('keeps the stack-arrival animations the chip beat relies on', () => {
    expect(seatCss).toMatch(/\.seat__stack--up\s*\{[^}]*animation:\s*stackBounceUp 0\.4s/);
    /* UPDATED 2026-08-28. `stackDeltaFloat 2s` became
       `stackDeltaFloat calc(2s * var(--animation-speed, 1))` so the float
       honours the table-wide speed setting, like every other keyframe on this
       felt. The 2s BASE this pin was protecting is intact; only the multiplier
       is new.

       The update comes with a second assertion, because the drift it allows is
       exactly what had already happened: --animation-speed is a DURATION
       multiplier running to 3, and the JS that unmounts the indicator was still
       a flat 2000ms, so on "slow" the node was removed after two seconds of a
       six-second animation and the +/- simply disappeared. A CSS-only pin
       cannot see that. Pin the pair. */
    expect(seatCss).toMatch(
      /animation:\s*stackDeltaFloat calc\(2s \* var\(--animation-speed, 1\)\)/
    );
    // The React window that clears it must scale on the same multiplier.
    expect(seat).toMatch(/setStackDelta\(0\), 2000 \* getAnimationSpeed\(\)/);
  });
});

describe('the shared hand loop stays shared', () => {
  it('no table component or table hook branches on tournament-ness', () => {
    /* ActionPanel.tsx left this list on 2026-08-26, deliberately: Dan -
       "in cash games [the bet slider] should go out by dollars one at a
       time, in tournaments same functionality, just scaled per chip depth."
       That is a bet-GRANULARITY rule, not a hand-loop or animation rule, and
       it cannot be expressed without knowing which kind of table this is.
       The test below this one confines ActionPanel's tournament-awareness to
       exactly that: the slider unit, nothing else. */
    const shared = [
      'src/components/table/DealAnimation.tsx',
      'src/components/table/CommunityCards.tsx',
      'src/components/table/PotDisplay.tsx',
      'src/components/table/ChipPhysics.tsx',
      'src/hooks/useTableAnimations.ts',
      'src/hooks/useTableSound.ts',
    ];
    const offenders: string[] = [];
    for (const f of shared) {
      let src: string;
      try {
        src = tsCode(read(f));
      } catch {
        continue; // renamed or removed - other tests cover existence
      }
      if (/\bisTournament\b|\btournamentId\b|\btournamentFormat\b/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("ActionPanel's tournament branch is the slider unit and nothing else", () => {
    /* The exception above is scoped, not open-ended. ActionPanel may read
       `isTournament` only to pick the slider's travel unit (sliderUnitFor);
       the animation/identity fields stay banned, and every line that names
       the flag must be part of that one feature - a prop declaration, the
       destructuring default, or the sliderUnitFor call. A new branch on the
       flag anywhere else in the panel re-fails this test. */
    const src = tsCode(read('src/components/table/ActionPanel.tsx'));
    expect(src).not.toMatch(/\btournamentId\b|\btournamentFormat\b/);
    const lines = src.split('\n').filter((l) => /\bisTournament\b/.test(l));
    expect(lines.length).toBeGreaterThan(0); // the feature exists
    for (const l of lines) {
      expect(
        /isTournament\?:|isTournament: boolean|isTournament = false|sliderUnitFor\(!!isTournament|\[isTournament,|!isTournament && bigBlind/.test(
          l
        ),
        `unexpected tournament branch in ActionPanel: ${l.trim()}`
      ).toBe(true);
    }
  });
});
