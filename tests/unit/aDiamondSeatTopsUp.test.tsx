/**
 * A DIAMOND SEAT TOPS UP FROM THE CUSTODY IT SAT WITH.
 *
 * Until now `addChips` answered a Diamond seat with "Diamond Add-Ons Are Not
 * Available Yet", which was true: the chip add-on debits `club_members`, and no
 * such row exists on this side of the arena. The seat now has its own writer,
 * `fn_poker_diamond_top_up`, which reserves settled Diamonds into the SAME
 * custody row the seat is bound to and raises `table_seats.stack` in one
 * transaction, because a deferred constraint holds the two equal.
 *
 * Three things have to stay true for that to reach a player, and each is a case
 * below: the cashier has to open for a Diamond cash seat, every number it offers
 * there has to be whole, and the control must NOT appear on a Diamond
 * tournament seat, which has no top-up writer at all.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  sliceBetween,
  sliceEnclosingBlock,
  sliceStatement,
  sliceMethod,
} from '../helpers/sourceWindow';
import { CashierModal } from '../../src/components/table/CashierModal';
import { seatCanAddFunds } from '../../server/src/domain/ArenaContext';

const TABLE_PAGE = readFileSync('src/pages/TablePage.tsx', 'utf8');
const MODALS = readFileSync('src/components/table/TableModalsLayer.tsx', 'utf8');
const SEATING = readFileSync('server/src/engine/ServerTableEngineSeating.ts', 'utf8');
const TABLE_MENU = readFileSync('src/components/table/TableMenu.tsx', 'utf8');
const withoutComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('A Diamond seat tops up from the custody it sat with', () => {
  it('offers the cashier to a Diamond cash seat and to no Diamond tournament seat', () => {
    /* THE RULE MOVED, SO THE PIN MOVED WITH IT (2026-09-12).

       This used to read the `canTopUpSeat` declaration for two asset literals,
       because the declaration was the only place the rule existed. It is now
       `seatCanAddFunds` in the shared arena contract, and it moved for a
       reason this file should record: THREE controls ask this question and two
       of them had drifted. The tab bar's Top Up item and the automatic top-up
       both still refused every non-chip asset, so at a Diamond cash seat the
       first did nothing at all and the second switched on a behaviour that
       never fired.

       A pure function can be CALLED, so the rule is asserted by behaviour
       rather than by text, and the table page is pinned to delegating to it. */
    expect(seatCanAddFunds('chips', false), 'a chip cash seat').toBe(true);
    expect(seatCanAddFunds('chips', true), 'a chip tournament seat rebuys').toBe(true);
    expect(seatCanAddFunds('diamonds', false), 'a Diamond cash seat').toBe(true);
    expect(
      seatCanAddFunds('diamonds', true),
      'a Diamond tournament seat has no top-up writer, so it is offered no control'
    ).toBe(false);
    expect(seatCanAddFunds(null, false), 'an unknown asset is never funded').toBe(false);
    expect(seatCanAddFunds(undefined, false), 'an asset that has not landed yet').toBe(false);

    const decision = sliceStatement(TABLE_PAGE, 'const canTopUpSeat =');
    expect(decision, 'the table page re-implements the rule instead of reading it').toMatch(
      /seatCanAddFunds\(/
    );
    /* Every surface that opens the cashier reads the one decision, so none of
       them can drift from the others the way the lobby's three join controls
       did on 2026-09-11. */
    /* THREE SINCE 2026-09-15, NOT FOUR. The fourth was the old side menu's
       own Cashier row, and that menu could not be opened - the only reference
       to its toggle was the overlay's own close handler - so the row was
       deleted with the rest of it. The rule this pins is unchanged: every
       surface that can open the cashier reads the one decision, and every
       remaining `setShowCashier(true)` sits behind `canTopUpSeat` or calls
       `seatCanAddFunds` itself. */
    expect(TABLE_PAGE.match(/canTopUpSeat/g) ?? []).toHaveLength(3);
    /* And every surface that ASKS the question reads the same function. This
       is a census of a NAMED set rather than a ceiling on an unrelated one:
       six surfaces decide whether this seat can be funded, and each is listed,
       so a seventh cannot appear without someone writing down what it is.

         1. the seat's own control, through `canTopUpSeat`
         2. the tab bar's Top Up bus case
         3. the bus case that toggles Auto Top Up
         4. the automatic top-up itself
         5. the prompt that opens when the hero is felted
         6. the confirm behind that prompt

       Five and six are the bust rebuy, which was chip-only until 2026-09-12
       on a note saying Diamond re-entry needed a new custody occupancy. It
       does not: `fn_poker_diamond_top_up` accepts an expected stack of zero
       and reserves into the custody the seat already holds.

         7. the report to the multi-table tab bar (2026-09-19, B12): the bar
            cannot see the arena, so the page tells it the rule's answer and
            the bar drops its Top Up items where the answer is no
            (tests/unit/tabBarTopUpFollowsSeatCanAddFunds.test.tsx). */
    expect(TABLE_PAGE.match(/seatCanAddFunds\(/g) ?? []).toHaveLength(7);
  });

  it('opens the cashier for Diamonds in whole units and names them', () => {
    /* The whole element, not a hand-measured window: a reformat must never be
       able to move this pin off the thing it guards. */
    const element = sliceBetween(MODALS, '<CashierModal', '/>');
    expect(element).toMatch(/arenaAsset === 'diamonds' && !isTournament/);
    expect(element).toMatch(/wholeUnits=\{arenaAsset === 'diamonds'\}/);
    expect(element).toMatch(/currency=\{arenaAsset === 'diamonds' \? 'Diamonds'/);
  });

  it('floors a typed fraction rather than rounding it up', () => {
    const onAddChips = vi.fn().mockResolvedValue(true);
    render(
      <CashierModal
        isOpen
        onClose={() => undefined}
        onAddChips={onAddChips}
        currentStack={40}
        accountBalance={1000}
        maxBuyIn={200}
        maxStack={200}
        wholeUnits
        currency="Diamonds"
      />
    );
    const input = screen.getByLabelText('Amount To Add') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.6' } });
    /* A Diamond does not divide, and the custody door refuses a fraction
       outright. Rounding UP would also ask for a unit the player never chose. */
    expect(input.value).toBe('10');
  });

  it('sends the whole floored amount, never the typed fraction', async () => {
    const onAddChips = vi.fn().mockResolvedValue(true);
    render(
      <CashierModal
        isOpen
        onClose={() => undefined}
        onAddChips={onAddChips}
        currentStack={40}
        accountBalance={1000}
        maxBuyIn={200}
        maxStack={200}
        wholeUnits
      />
    );
    const input = screen.getByLabelText('Amount To Add') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99.99' } });
    fireEvent.click(screen.getByRole('button', { name: /Add 99/i }));
    await vi.waitFor(() => expect(onAddChips).toHaveBeenCalled());
    expect(onAddChips.mock.calls[0][0]).toBe(99);
  });

  it('keeps the chip cashier on cents', () => {
    const onAddChips = vi.fn().mockResolvedValue(true);
    render(
      <CashierModal
        isOpen
        onClose={() => undefined}
        onAddChips={onAddChips}
        currentStack={40}
        accountBalance={1000}
        maxBuyIn={200}
        maxStack={200}
      />
    );
    const input = screen.getByLabelText('Amount To Add') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.6' } });
    expect(input.value).toBe('10.6');
  });

  it('routes the engine add-on to the Diamond door and only between hands', () => {
    const method = sliceMethod(SEATING, 'protected async addDiamonds(');
    expect(method).toMatch(/fn_poker_diamond_top_up/);
    /* THIS PINNED THE REFUSAL, AND THE REFUSAL MOVED (2026-09-12). A mid-hand
       Diamond top-up used to answer "Diamond Top Ups Land Between Hands" and
       do nothing. It is an INTENT now: still nothing moves during the hand,
       but the request is remembered and the whole top-up happens in the one
       transaction the seat-keeps-custody constraint allows, once the hand is
       over. The property the old string stood for is unchanged and is what is
       asserted instead - no money door is reached from inside the hand - which
       is the thing that actually made the refusal correct. */
    const midHand = sliceMethod(method, 'if (midHand) {');
    expect(midHand, 'the mid-hand branch reaches a money door').not.toMatch(/supabase\.rpc/);
    expect(midHand, 'the mid-hand request is not remembered').toMatch(/diamondTopUpIntents\.set/);
    expect(method, 'the door is told the stack the caller believes it is raising').toMatch(
      /p_expected_stack: stack/
    );
    expect(method, 'whole units only').toMatch(/Math\.floor/);
    expect(method, 'the chip add-on debits a club wallet that does not exist here').not.toMatch(
      /atomic_table_addon/
    );
  });

  /* ─── THE OTHER TWO SURFACES (2026-09-12) ────────────────────────────────
     The seat's own control learned about Diamond cash when the custody door
     shipped. The multi-table tab bar's menu did not, and it renders its items
     unconditionally because it cannot see the arena, so both of its money
     items were dead at a Diamond seat: Top Up did nothing at all, and Auto Top
     Up switched on a setting the automatic top-up would not read. These pin
     the repair at each of the three places, bounded by the structure that owns
     it rather than by a count of lines. */

  it('the tab bar Top Up item reaches the cashier at a Diamond cash seat', () => {
    const branch = sliceStatement(TABLE_PAGE, "case 'REBUY':");
    expect(branch, 'the bus case still refuses every non-chip asset').not.toMatch(
      /arenaAsset !== 'chips'/
    );
    expect(branch, 'it reads the one rule').toMatch(/seatCanAddFunds\(/);
  });

  it('the tab bar Auto Top Up item refuses a seat the automatic top-up will not serve', () => {
    const branch = sliceBetween(
      TABLE_PAGE,
      "event.action === 'AUTO_TOP_UP'",
      'setIsAutoRebuyEnabled'
    );
    expect(branch, 'it reads the one rule').toMatch(/seatCanAddFunds\(/);
    expect(branch, 'and a tournament seat is never topped up automatically').toMatch(
      /isTournament/
    );
    expect(
      branch,
      'the callback is registered once, so the asset must come from the ref, not the closure'
    ).toMatch(/tableStateRef\.current/);
  });

  it('the automatic top-up serves a Diamond cash seat, in whole Diamonds', () => {
    const gate = sliceStatement(TABLE_PAGE, 'isAutoRebuyEnabled &&');
    expect(gate, 'the automatic top-up still refuses every non-chip asset').not.toMatch(
      /arenaAsset === 'chips'/
    );
    expect(gate, 'it reads the one rule').toMatch(/seatCanAddFunds\(/);

    /* A Diamond does not divide. The custody door reserves whole units and
       floors anything else, so a fractional request would report one number
       and move another; a shortfall under one Diamond waits instead. The chip
       arithmetic has to survive that unchanged, which is why both branches
       are asserted rather than only the new one. */
    const amount = sliceStatement(TABLE_PAGE, 'const topUpAmount =');
    expect(amount, 'whole Diamonds').toMatch(/arenaAsset === 'diamonds'[\s\S]*Math\.floor\(/);
    expect(amount, 'and chips still to the cent').toMatch(/Math\.round\(shortfall \* 100\) \/ 100/);
  });

  it('the automatic top-up names what actually moved', () => {
    /* Anchored on the `if`, not on the toast text: `blankNonCode` blanks
       string literals before it looks for an anchor, precisely so a pin cannot
       be hung on a sentence, and the copy this asserts lives inside one. */
    const toast = sliceMethod(TABLE_PAGE, 'if (!alreadyAnnounced) {');
    expect(toast, 'a Diamond seat is not told it received chips').toMatch(/Diamond/);
    expect(toast, 'and one Diamond is not "1 Diamonds"').toMatch(/landed === 1/);
    expect(toast, 'a chip seat is unchanged').toMatch(/landed\.toFixed\(2\)\} Chips/);
  });

  it('a felted Diamond seat is prompted, and rebuys through the Diamond door', () => {
    /* The prompt and the confirm are separate decisions in separate places,
       and a repair to one without the other is a prompt that cannot be
       answered or an answer nothing asks for. Both are pinned. */
    const prompt = sliceStatement(TABLE_PAGE, 'if (!seatCanAddFunds(tableState.arenaAsset');
    expect(prompt, 'the prompt still refuses every non-chip asset').not.toMatch(
      /arenaAsset !== 'chips'/
    );

    const confirm = sliceStatement(TABLE_PAGE, 'const confirmBustRebuy =');
    expect(confirm, 'it reads the one rule').toMatch(/seatCanAddFunds\(/);
    expect(confirm, 'whole Diamonds, for the reason the automatic top-up floors').toMatch(
      /bustAsset === 'diamonds'[\s\S]*Math\.floor\(requested\)/
    );
    expect(
      confirm,
      'the chip rebuy RPC debits a club wallet a Diamond entitlement has no row in'
    ).toMatch(/bustAsset === 'diamonds'[\s\S]*handleAddChipsRef\.current/);
    expect(confirm, 'and the chip path still reaches its own RPC').toMatch(/atomic_table_rebuy/);
    expect(confirm, 'one idempotency key per bust event and amount, on both paths').toMatch(
      /bustRebuyKeyRef/
    );
  });

  it('the tab bar menu names no denomination it cannot see', () => {
    /* Comments stripped: the note explaining why the label changed has to be
       able to quote the label it replaced. */
    const item = withoutComments(sliceEnclosingBlock(TABLE_MENU, 'handlers.onRebuy'));
    expect(item, 'this menu cannot see the arena, so it cannot name one').not.toMatch(
      /Chips|Diamonds/
    );
    expect(item, "and it says what the table page's own control says").toMatch(/'Top Up'/);
  });
});
