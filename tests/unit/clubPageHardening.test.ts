/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB PAGE HARDENING — the failures a third audit pass found
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every rule here is one that had already been broken once, and every one of
 * them fails SILENTLY on screen: a wrong balance looks like a balance, an
 * empty lobby looks like a quiet club, a dead realtime channel looks like a
 * table nobody is playing at. None of them throws, so none of them would have
 * been noticed by a smoke test.
 *
 * Where the behaviour is in an exported pure function it is exercised
 * directly. Where it lives inside a 3,000-line component or a hook that needs
 * a live Supabase, the shape that made the failure possible is forbidden by
 * reading the source — the house's existing guard-test style.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FILTER_SPECS,
  emptyFilterValue,
  rowPassesFilter,
  type FilterableRow,
} from '../../src/components/lobby/advancedFilterSpec';

const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
/** Comments quote the very things these tests ban. Never match against them. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const WALLET = code(read('src/components/wallet/DynamicWallet.tsx'));
const REG = code(read('src/hooks/useTournamentRegistration.ts'));
const FILTERS = code(read('src/components/lobby/AdvancedFilters.tsx'));
const CACHE = code(read('src/lib/walletCache.ts'));

describe('the wallet never renders a refusal as a balance', () => {
  it('never renders an unauthorized money panel as zeros', () => {
    /* fn_club_money_panel answers {authorized:false, reason} for no_auth,
       club_not_found and not_a_member. That is a RESOLVED rpc with no `error`,
       so the error check cannot see it; every figure then coerced to 0 and the
       panel declared success — and the write-through persisted the invented
       zeros for the next visit to paint instantly.

       REFINED 2026-08-25: the first fix threw on EVERY refusal, which made a
       signed-in NON-MEMBER opening any club lobby see a red "Balances
       Unavailable" badge and a fabricated Diamonds 0 over the balance that had
       just been read successfully - three of the four reads are the viewer's
       own money and succeed regardless of membership. `not_a_member` and
       `no_auth` are ordinary states: keep what was read, leave the club's own
       figures unknown, do not raise. Anything else is still a fault. */
    expect(WALLET).toMatch(/const panelRefused = panel\.authorized === false;/);
    expect(WALLET).toMatch(
      /panelRefused && refusalReason !== 'not_a_member' && refusalReason !== 'no_auth'/
    );
    expect(WALLET).toMatch(/throw new Error\(`fn_club_money_panel refused/);
    // ...and a refusal must not move the union flag in either direction.
    expect(WALLET).toMatch(/if \(!panelRefused\) \{/);
  });

  it('still raises on a genuine query error from any of the four reads', () => {
    expect(WALLET).toMatch(/const readError =[\s\S]{0,160}?panelRes\.error/);
    expect(WALLET).toMatch(/if \(readError\) throw readError;/);
  });

  it('does not leave the union flag pinned across a club switch', () => {
    // A stale `true` removes a standalone club's Rake Treasury and Spins
    // Wallet rows and stops useSpinsWallet fetching at all.
    expect(WALLET).toMatch(/setIsClubInUnion\(false\);/);
    expect(
      /if \(panel\.in_union !== undefined\) setIsClubInUnion/.test(WALLET),
      'the guarded write is back: it can never fire on a refusal, and it freezes the previous club'
    ).toBe(false);
  });

  it('never hands the spins hook anything but the resolved UUID', () => {
    expect(WALLET).toMatch(/useSpinsWallet\(resolvedId,/);
  });
});

describe('a realtime reconnect actually reconnects', () => {
  it('scopes every channel topic to the epoch as well as the instance', () => {
    /* supabase.channel(topic) RETURNS AN EXISTING CHANNEL when one with that
       topic is still registered, and removeChannel only deregisters when the
       server acknowledges the leave. React runs cleanup and setup back to back,
       so a constant topic handed the rebuild the old, still-'leaving' channel —
       and subscribe() does all of its work inside `if (state === 'closed')`, so
       it registered no callback, never joined, and returned silently. No
       SUBSCRIBED, no CHANNEL_ERROR, no CLOSED: nothing left to reconnect it. */
    expect(WALLET).toMatch(
      /const channelTopicSuffix = `\$\{instanceIdRef\.current\}-\$\{channelEpoch\}`/
    );
    for (const topic of ['dynamic-wallet-', 'dynamic-wallet-club-', 'dynamic-wallet-union-']) {
      expect(
        WALLET.includes(`${topic}$`) === false || WALLET.includes('${channelTopicSuffix}`)'),
        `${topic} must carry the epoch-scoped suffix`
      ).toBeTruthy();
    }
    expect(WALLET.match(/\$\{channelTopicSuffix\}`\)/g) || []).toHaveLength(3);
  });

  it('keeps the disposed guard that stops teardown from looping', () => {
    expect(WALLET).toMatch(/let disposed = false;/);
    expect(WALLET).toMatch(/disposed = true;/);
  });
});

describe('a buy-in cannot be taken twice', () => {
  it('guards on a ref that flips before the confirm dialog is awaited', () => {
    /* `isRegistering` is state, and state does not change until React
       re-renders — but the next line awaits a dialog. Two activations in one
       frame both passed, and the dialog QUEUES rather than rejects, so the
       second confirmation debited a second buy-in.

       2026-08-25: the awaited dialog is now `signUpDialog` — the full Sign Up
       card — rather than the generic `confirmDialog` this line used to name.
       Dan: "you don't need a secondary confirmation for buy ins", so the two
       dialogs that used to fire for one buy-in became this one. The INVARIANT
       here is unchanged and is exactly as important: the ref must flip before
       anything is awaited. Only the dialog's identity moved, so this assertion
       moves with it rather than being deleted. */
    const guard = REG.indexOf('if (registeringRef.current) return;');
    const confirm = REG.indexOf('await signUpDialog');
    expect(guard, 'the ref guard is missing').toBeGreaterThan(-1);
    expect(confirm, 'the buy-in must still be confirmed before it is taken').toBeGreaterThan(-1);
    expect(guard, 'the guard must come BEFORE the await').toBeLessThan(confirm);
    expect(REG).toMatch(/registeringRef\.current = true;/);
    expect(REG.indexOf('registeringRef.current = true;')).toBeLessThan(confirm);
  });

  it('asks exactly once - there is no second confirmation behind the first', () => {
    /* Dan 2026-08-25, binding. Two prompts for one buy-in is the bug; zero
       prompts would be a far worse one, so this pins BOTH ends: exactly one
       awaited dialog, and it is the Sign Up card. */
    expect(REG).not.toMatch(/confirmDialog\(/);
    expect((REG.match(/await signUpDialog\(/g) || []).length).toBe(1);
  });

  it('releases the guard when the player cancels', () => {
    expect(REG).toMatch(/if \(!confirmed\) \{[\s\S]{0,120}?registeringRef\.current = false;/);
  });

  it('does not navigate or set state after unmount', () => {
    expect(REG).toMatch(/if \(aliveRef\.current\) \{[\s\S]{0,400}?navigate\(/);
    expect(REG).toMatch(/if \(aliveRef\.current\) setIsRegistering\(false\);/);
  });
});

describe('saved filters cannot empty the lobby or crash it', () => {
  it('clamps every numeric field it reads back', () => {
    expect(FILTERS).toMatch(/const clampTo = /);
    for (const field of ['rangeMin', 'rangeMax', 'seatMin', 'seatMax']) {
      expect(FILTERS).toMatch(new RegExp(`${field}: (spec\\.seats\\s*\\?\\s*)?clampTo\\(`));
    }
  });

  it('drops preset keys this build no longer defines', () => {
    // One stale key made matchesPreset false for EVERY row.
    expect(FILTERS).toMatch(/selectedRanges: list\(value\.selectedRanges\)\.filter/);
  });

  it('does not let one malformed tab discard the others', () => {
    expect(FILTERS).toMatch(/reportError\(perTab, 'AdvancedFilters\.loadFilters\.tab'/);
  });

  it('derives the slider step from the range MIN, and only when it is above zero', () => {
    /* min 0.02 with a step of 1 makes the reachable values 0.02, 1.02, 2.02...
       so the Micro and Small blind tiers the spec itself defines could not be
       selected, and 5000 was not step-valid so the max thumb was sanitised to
       4999.02 and read as a permanently active filter.

       REFINED 2026-08-25: `min < 1` is also true for the BUY-IN sliders, whose
       min is 0 - that gave a 0-15,000 range 1.5 million steps, so one arrow
       key moved the filter by a cent and dragging produced 3847.23 under a
       header whose own formatter says buy-ins carry no decimals. Cents are
       needed only when the minimum is above zero and below one. */
    expect(FILTERS).toMatch(
      /const rangeStep = spec \? \(spec\.range\.min > 0 && spec\.range\.min < 1 \? 0\.01 : 1\) : 1;/
    );
    expect(/step=\{spec\.range\.max > 100 \? 1 : 0\.01\}/.test(FILTERS)).toBe(false);
  });

  it('keeps both thumbs inside the spec, and heals an inverted pair on read', () => {
    /* The one-step gap alone could walk a bound OUTSIDE the spec: with
       rangeMax already at the minimum, `rangeMax - rangeStep` is below it, and
       the browser then clamps the input while the arithmetic re-applies the
       out-of-range partner on every drag - the range freezes and the tab
       empties. Clamping each bound separately on read cannot undo an inversion
       either, so an inverted pair is discarded for the spec's full range. */
    expect(FILTERS).toMatch(/Math\.max\(\s*spec\.range\.min,/);
    expect(FILTERS).toMatch(/Math\.min\(\s*spec\.range\.max,/);
    expect(FILTERS).toMatch(/if \(repaired\.rangeMin > repaired\.rangeMax\)/);
    expect(FILTERS).toMatch(/if \(repaired\.seatMin > repaired\.seatMax\)/);
  });

  it('keeps the two range thumbs one step apart so neither can be buried', () => {
    expect(FILTERS).toMatch(/value\.rangeMax - rangeStep/);
    expect(FILTERS).toMatch(/value\.rangeMin \+ rangeStep/);
  });
});

describe('the buy-in filter applies to freerolls', () => {
  const spec = FILTER_SPECS.MTT;
  const highOnly = { ...emptyFilterValue(spec), selectedRanges: ['high'] };
  const row = (price: number | null): FilterableRow => ({
    price,
    variant: 'nlh',
    status: 'open_reg',
    row: {},
  });

  it('excludes a 0 buy-in when only the High tier is selected', () => {
    // `price > 0` used to skip the whole price block, so every freeroll passed
    // every buy-in filter. Zero is a real price here: micro starts at 0.
    expect(rowPassesFilter(spec, highOnly, row(0))).toBe(false);
  });

  it('still includes a 0 buy-in when the Micro tier is selected', () => {
    const microOnly = { ...emptyFilterValue(spec), selectedRanges: ['micro'] };
    expect(rowPassesFilter(spec, microOnly, row(0))).toBe(true);
  });

  it('treats a missing price as unknown rather than as zero', () => {
    expect(rowPassesFilter(spec, highOnly, row(null))).toBe(true);
  });
});

describe('the MTT variant chips can all match something', () => {
  it('has no plo_high chip', () => {
    /* No variant in the database normalises to `plo_high` — game_type across
       23,116 tournaments is NLH, PLO4, PLO5, PLO6, PLO8, SHORT_DECK and
       OFC_PINEAPPLE — so selecting it matched zero rows and emptied the tab. */
    const keys = FILTER_SPECS.MTT.games?.map((g) => g.key) ?? [];
    expect(keys).not.toContain('plo_high');
  });

  it('every chip key is reachable from some real variant string', () => {
    /* Counted on production 2026-08-25 — the live cash board is nlh 16,
       plo4 7, plo5 6, PINEAPPLE 5, plo8 5, short_deck 4, plo6 3. Pineapple was
       missing from this set AND from the HOLDEM chips, which is how ticking
       "NLH" made five real tables disappear: cashKind routes Pineapple to the
       Hold'em tab, variantKey returns 'pineapple' for it, and a games list
       that does not name it drops it. */
    const reachable = new Set([
      'nlh',
      'pineapple',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'short_deck',
      'flh',
      'flo8',
      'sat',
    ]);
    for (const spec of Object.values(FILTER_SPECS)) {
      for (const g of spec.games ?? []) {
        expect(reachable.has(g.key), `${g.key} is a chip no variant can produce`).toBe(true);
      }
    }
  });
});

describe('the cache does not tell itself the data is fresher than it is', () => {
  it('flushes the stored envelope rather than re-stamping it', () => {
    // A debounced write re-dated to flush time made every freshness check
    // downstream skip the refetch that would have corrected stale money.
    expect(CACHE).toMatch(/function persistEnvelope</);
    expect(CACHE).toMatch(/if \(env\) persistEnvelope\(key, env\);/);
    expect(
      /if \(env\) writeWalletCache\(key, env\.data/.test(CACHE),
      'the flush is re-stamping `at` again'
    ).toBe(false);
  });
});
