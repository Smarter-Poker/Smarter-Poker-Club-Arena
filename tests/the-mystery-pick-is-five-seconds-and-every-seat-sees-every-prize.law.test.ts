/**
 * MYSTERY BOUNTY PICK 1 OF 3 (Dan 2026-10-25, binding):
 *
 *   "THEY HAVE 5 SECONDS TO PICK THERE BOX, AND IF THEY DON'T RANDOMLY CHOOSE
 *    IT. AND YOU MUST ALWAYS SHOW THE OTHER 2 PRIZES THAT 'COULD OF BEEN
 *    CHOOSEN'."
 *   "I JUST WATCHED THE LAST TWO PLAYERS GET ZERO APPEAR ON THE SCREEN
 *    INSTEAD OF THE PRIZE THEY GOT" / "IT SOMETIMES FLASHES IT VERY LATE."
 *   "THE 3 BOXES NEED TO BE CENTERED ON THE SCREEN."
 *
 * Each pin is a cause that shipped. Behaviour is covered in
 * tests/components/MysteryBountyChestPickOneOfThree.test.tsx; these pin the
 * table wiring and the database half that a component test cannot see.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const CHEST = read('src/components/tournament/MysteryBountyChest.tsx');
const CSS = read('src/components/tournament/MysteryBountyChest.css');
const TABLE = read('src/pages/TablePage.tsx');

describe('the pick is five seconds, then random', () => {
  it('is a five-second decision clock, not scaled by animation speed', () => {
    expect(CHEST).toContain('export const PICK_WINDOW_MS = 5000;');
  });

  it('draws the chest at random when the window runs out, and records it', () => {
    expect(CHEST).toContain('const slot = choosing ? randomPickSlot(offerSlots) : undefined;');
    expect(CHEST).toContain('runOpen(slot);');
    expect(CHEST).toContain('crypto.getRandomValues');
  });
});

describe('every chest stays on screen and shows what it held', () => {
  it('keeps the row of chests in every phase, centred on the stage', () => {
    expect(CHEST).toMatch(/\{choosing && \(\s*<div\s+className=\{`mbc__picks/);
    expect(CHEST).toContain("'Could Have Been'");
    expect(CSS).toContain('.mbc--choosing .mbc__stage {');
    expect(CSS).toMatch(/\.mbc__picks \{[^}]*width: 100%;/);
  });

  it('reads the offer until every chest is described', () => {
    expect(TABLE).toContain(
      'const currentOfferComplete = !!currentOffer?.revealed && !!currentOffer?.choices;'
    );
  });
});

describe('no seat ever counts up to zero', () => {
  it('holds the reveal until the amount is known', () => {
    expect(CHEST).toContain('if (amountRef.current > 0 || waitedMs >= AMOUNT_WAIT_MAX_MS) {');
  });

  it('takes the prize from the revealed offer on a seat that is not the revealer', () => {
    expect(TABLE).toContain('offer?.revealed ? offer.choices?.find((c) => c.picked) : undefined');
  });

  it('does not wipe the amount of the chest still on screen', () => {
    expect(TABLE).not.toMatch(/mystery_bounty_complete[\s\S]{0,900}setChestReveals\(\{\}\)/);
  });

  it('opens only the chest a "chest opened" was sent for, and opens on the server reveal', () => {
    expect(TABLE).not.toContain('setChestRemoteOpened(true)');
    expect(TABLE).toContain('setChestRemoteOpenedAward(awardId || MYSTERY_CHEST_LEGACY_KEY);');
    expect(TABLE).toContain('setChestRemoteOpenedAward(String(b.awardId));');
  });

  it("opens a horse's award when it picks, as a person's tap does (10.5)", () => {
    const dir = resolve(root, 'supabase/migrations');
    const file = readdirSync(dir).find((f) =>
      f.endsWith('_a_horse_s_mystery_chest_opens_when_it_picks.sql')
    );
    expect(file).toBeTruthy();
    const sql = readFileSync(resolve(dir, file!), 'utf8');
    expect(sql).toContain("A HORSE'S TAP OPENS ITS CHEST");
    expect(sql).toMatch(
      /IF v_engine THEN\s+UPDATE public\.tournament_bounty_awards\s+SET status = 'revealed'/
    );
    // It uncovers; it never pays.
    expect(sql).not.toContain('fn_mystery_bounty_pay');
  });
});
