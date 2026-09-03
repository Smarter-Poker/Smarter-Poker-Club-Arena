/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AUDITING THE FIX, NOT THE BUG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three claims were made about the Spin owner menu. Two of them were not
 * actually true, and one had quietly created a new fault of its own.
 *
 * CLAIM: "the repayment bar is now frozen when the seed is taken."
 * Half true. It was written with GREATEST(...), which correctly stops an owner
 * LOWERING the bar by reactivating at a smaller stake — but nothing ever
 * cleared it. Once a pool had carried a 20,000 bar it carried it forever: repay
 * that seed, come back and seed 200 at a stake of 1, and the new seed needs
 * 20,000 of play to return. One direction cured, the other opened.
 *
 * CLAIM: "reactivating on an unpaid seed is refused."
 * Only when the wallet DIFFERS. With the same wallet it added a second full
 * seed, so an owner who switched Spins off and on paid twice for the same
 * protection — and the panel rendered the outstanding amount only inside the
 * is_active branch, so while Spins were off the money already sitting there
 * was invisible and the button quoted a full fresh bill.
 *
 * CLAIM: "the route decides who may act now."
 * The route did. The panel then ANDed that answer with the PAGE's guess
 * (`canManage={isOwner}`), which is false for a union lead who does not own the
 * club — so the off switch stayed hidden from exactly the person the API
 * authorises. The AND was the same bug wearing the fix's clothes.
 *
 * AND THE HALF THAT WAS NEVER BUILT: the panel existed only on
 * ClubSettingsPage. A union owns the Spin wallet for every club inside it, and
 * its lead had nowhere to switch Spins on at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../');
const dir = resolve(root, 'supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('spin_seed_bar_resets_and_credits'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');

describe('the bar is released with the seed it belonged to', () => {
  it('ships the migration', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('refuses to pass unless settle actually resets it', () => {
    expect(sql).toMatch(/required_seed_at_activation = 0%'/);
    expect(sql).toMatch(/does not release the bar with the seed/);
  });

  it('refuses to pass unless activation credits what is outstanding', () => {
    expect(sql).toMatch(/v_still_needed%'/);
    expect(sql).toMatch(/still charges a full second seed/);
  });

  it('refuses to pass unless the menu can report an unrepayable seed', () => {
    expect(sql).toMatch(/seed_is_repayable%'/);
  });

  it('checks the pool still reconciles after replacing three money functions', () => {
    expect(sql).toMatch(/seeded_amount \+ total_deposited - total_drawn/);
    expect(sql).toMatch(/does not reconcile/);
  });

  it('asserts against the LIVE function bodies, not this file', () => {
    // A migration that only asserts on its own text proves nothing about the
    // database it is supposed to describe.
    expect(sql).toMatch(/pg_get_functiondef\(oid\)/);
    expect(sql).toMatch(/FROM pg_proc WHERE proname = 'fn_spin_settle_game'/);
  });
});
