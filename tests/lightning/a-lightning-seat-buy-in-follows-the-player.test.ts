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

  it('Join Lightning on a Lightning table opens the door-assigned chair, never a watch-only loop', () => {
    const body = sliceMethod(page, 'const openLightningAnchorEntry = () =>');
    expect(body).toMatch(
      /handleSeatClick\(lightningChairFromUrl\(\), \{ lightningChair: true \}\)/
    );
    expect(body).toMatch(/navigate\(lightningRoute\(anchorLightningClusterId\)\)/);
  });

  it('a Lightning chair is not read off a felt painting a pool room', () => {
    const seat = sliceMethod(page, 'const handleSeatClick = (seatNumber: number');
    expect(seat).toMatch(
      /const lightningChair = opts\?\.lightningChair === true && !!anchorLightningClusterId;/
    );
    expect(seat).toMatch(/!lightningChair &&\s+seatIdx >= 0/);
    const deepLink = page.slice(
      page.indexOf('DEEP LINK ?buyin=1'),
      page.indexOf('const openLightningAnchorEntry')
    );
    expect(deepLink).toMatch(
      /if \(anchorLightningClusterId\) \{[\s\S]*?handleSeatClick\(lightningChairFromUrl\(\), \{ lightningChair: true \}\);/
    );
  });

  it('only a game whose mode is Lightning is treated as Lightning (a Classic table keeps its waiting list)', () => {
    expect(page).toMatch(
      /isLightningMode\(spectatorLightningStates\[tableState\.clusterId\]\?\.clusterMode\)/
    );
    expect(page).not.toMatch(/spectatorLightningStates\[tableState\.clusterId\] != null/);
  });

  it('the Join Lightning door lands on the table with its buy-in open on the assigned chair', () => {
    const entry = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');
    expect(entry).toMatch(
      /joinsLightning && r\.action === 'seat'\s+\? `\/table\/\$\{r\.table_id\}\?buyin=1/
    );
    expect(entry).toContain('&seat=${chair}');
  });
});
