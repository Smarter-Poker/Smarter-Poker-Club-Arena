/**
 * HORSES ARE PLAYERS (CLAUDE.md 10.5), applied to pick 1 of 3 (2026-10-22).
 *
 * A person taps one of the three chests within seconds; a horse has no
 * browser, so its chest used to sit locked until the engine's deadline. The
 * rhythm told the table which seat was a horse. The engine now supplies the
 * tap a browser would: a human-like wait inside the person's window, a pick
 * through the same door, and the same open broadcast on the same channel.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MYSTERY_BOUNTY_REVEAL_DELAY_MS } from '../config/mysteryBountySpec.js';
import { CHEST_LANDING_MS, CHEST_PICK_WINDOW_MS } from '../config/mysteryChestSpec.js';

const src = readFileSync(resolve(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const method = src.slice(
  src.indexOf('protected async horseMysteryChestTap('),
  src.indexOf('One chest is done. Let its animation finish')
);

describe('a horse picks its mystery chest like a person', () => {
  it('is wired into the pending step for every chest', () => {
    expect(src).toContain(
      'void this.horseMysteryChestTap(next.awardId, next.tableId, next.designatedRevealer);'
    );
  });

  it('acts only for a horse revealer, inside the window a person has', () => {
    expect(method).toContain(".select('is_horse')");
    expect(method).toContain('const waitMs = 1500 + nodeCrypto.randomInt(0, 3500);');
    // The latest tap lands inside a person's five-second window, and well
    // before the engine's own deadline reveal.
    expect(1500 + 3500).toBeLessThanOrEqual(CHEST_LANDING_MS + CHEST_PICK_WINDOW_MS);
    expect(1500 + 3500).toBeLessThan(MYSTERY_BOUNTY_REVEAL_DELAY_MS - 1000);
  });

  it('picks through the same door and broadcasts what a browser broadcasts', () => {
    expect(method).toContain("supabase.rpc('fn_mystery_bounty_pick'");
    expect(method).toContain('supabase.channel(`mystery-chest-${tableId}`)');
    expect(method).toContain("httpSend('mystery_chest_opened'");
    // It never settles or pays: the deadline reveal does that, as for a person.
    expect(method).not.toContain('fn_mystery_bounty_reveal');
    expect(method).not.toContain('fn_mystery_bounty_pay');
  });

  it('picks at random for a revealer who never answered, before the deadline reveal', () => {
    const settle = src.slice(src.indexOf('protected async settleMysteryBountyAward('));
    const pick = settle.indexOf("supabase.rpc('fn_mystery_bounty_pick'");
    const reveal = settle.indexOf("supabase.rpc('fn_mystery_bounty_reveal'");
    expect(pick).toBeGreaterThan(-1);
    expect(pick).toBeLessThan(reveal);
    expect(settle).toContain('p_slot: 1 + nodeCrypto.randomInt(0, slots),');
  });
});
