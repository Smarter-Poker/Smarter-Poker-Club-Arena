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
import { sliceBetween, sliceStatement, sliceMethod } from '../helpers/sourceWindow';
import { CashierModal } from '../../src/components/table/CashierModal';

const TABLE_PAGE = readFileSync('src/pages/TablePage.tsx', 'utf8');
const MODALS = readFileSync('src/components/table/TableModalsLayer.tsx', 'utf8');
const SEATING = readFileSync('server/src/engine/ServerTableEngineSeating.ts', 'utf8');

describe('A Diamond seat tops up from the custody it sat with', () => {
  it('offers the cashier to a Diamond cash seat and to no Diamond tournament seat', () => {
    const decision = sliceStatement(TABLE_PAGE, 'const canTopUpSeat =');
    expect(decision).toMatch(/arenaAsset === 'chips'/);
    expect(decision).toMatch(/arenaAsset === 'diamonds'/);
    expect(
      decision,
      'a Diamond tournament seat has no top-up writer, so it is offered no control'
    ).toMatch(/!tableState\.isTournament/);
    /* Every surface that opens the cashier reads the one decision, so none of
       them can drift from the others the way the lobby's three join controls
       did on 2026-09-11. */
    expect(TABLE_PAGE.match(/canTopUpSeat/g) ?? []).toHaveLength(4);
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
    expect(method, 'the seat and its custody only move together').toMatch(
      /Diamond Top Ups Land Between Hands/
    );
    expect(method, 'the door is told the stack the caller believes it is raising').toMatch(
      /p_expected_stack: stack/
    );
    expect(method, 'whole units only').toMatch(/Math\.floor/);
    expect(method, 'the chip add-on debits a club wallet that does not exist here').not.toMatch(
      /atomic_table_addon/
    );
  });
});
