import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../helpers/sourceWindow';

/* WooWoo, 2026-10-24: he bought in by tapping an open seat on a physical
   table of a Lightning game. The database moved him into the pool and dealt
   him hands in his own pool-session room, but nothing told his tab to follow,
   so every hand timed out on a screen he could not see. Only the Join
   Lightning page marked the entry intent. A seat buy-in at a Lightning
   anchor now marks it too, before the buy-in request, and a spectator there
   is offered Join Lightning, never the table's waiting list. */
const page = readFileSync('src/pages/TablePage.tsx', 'utf8');

describe('a buy-in at a Lightning anchor follows the player into their room', () => {
  it('the seat buy-in marks the Lightning entry intent for this anchor', () => {
    const body = sliceMethod(page, 'onConfirmBuyIn={async (amount, autoRebuy) =>');
    expect(body).toMatch(
      /if \(anchorLightningClusterId\)\s+setLightningEntryIntent\(tableId, anchorLightningClusterId\);/
    );
  });

  it('a spectator at a Lightning anchor is offered Join Lightning, not the waiting list', () => {
    expect(page).toMatch(
      /!tableState\.isTournament && anchorLightningClusterId \? \(\s*<WaitlistCallToAction\s+lightning\s+onClick=\{openLightningAnchorEntry\}/
    );
  });

  it('Join Lightning on a Lightning table goes to the one-question door, never a seat on this felt', () => {
    const body = sliceMethod(page, 'const openLightningAnchorEntry = () =>');
    expect(body).toMatch(/navigate\(`\$\{lightningRoute\(anchorLightningClusterId\)\}\?join=1`\)/);
    expect(body).not.toMatch(/handleSeatClick/);
  });
});
