/**
 * AN ENTRANT HELD FOR THE BLIND IS NOT "SITTING OUT" (Dan 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "IT SHOULDN'T SAY 'SITTING OUT' IF YOU AGREED TO 'POST THE BIG BLIND'. IT
 * ALSO SHOULDN'T SAY 'SITTING OUT' IF THEY ARE WAITING FOR BB, IT SHOULD SAY
 * 'WAITING FOR BB'."
 *
 * The engine flags every cash entrant it is holding for the big blind as
 * sitting out, and the seat printed SITTING OUT over all of them - including
 * the player in Dan's screenshot who had just tapped Post Big Blind. The seat
 * now takes `entryWait` from the parent, decided from the engine's own two
 * lists, and says what is true. This renders the seat for each state.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';
import { sliceBetween } from '../helpers/sourceWindow';

const entrant = (over: Partial<SeatPlayer> = {}): SeatPlayer => ({
  id: 'u-kingfish',
  name: 'KingFish',
  avatar: '',
  stack: 1000,
  status: 'sitting_out',
  isHero: false,
  showCards: false,
  ...over,
});

const seat = (entryWait: 'waiting_for_bb' | 'posting_bb' | null) =>
  render(
    <SeatSlot
      seatNumber={4}
      player={entrant()}
      position={null}
      isActive={false}
      lastAction={null}
      entryWait={entryWait}
    />
  ).container;

describe('what a sat-out seat says', () => {
  it('held for the blind and unanswered: Waiting For BB, not Sitting Out', () => {
    const c = seat('waiting_for_bb');
    const badge = c.querySelector('[data-testid="seat-waiting-bb-badge"]');
    expect(badge?.textContent).toBe('Waiting For BB');
    expect(c.querySelector('[data-testid="seat-sitout-badge"]')).toBeNull();
    expect(c.textContent).not.toContain('Sitting Out');
  });

  it('agreed to post the big blind: no badge at all', () => {
    const c = seat('posting_bb');
    expect(c.querySelector('[data-testid="seat-waiting-bb-badge"]')).toBeNull();
    expect(c.querySelector('[data-testid="seat-sitout-badge"]')).toBeNull();
    expect(c.textContent).not.toContain('Sitting Out');
    expect(c.textContent).not.toContain('Waiting For BB');
  });

  it('a real sit-out is still a sit-out', () => {
    const c = seat(null);
    expect(c.querySelector('[data-testid="seat-sitout-badge"]')?.textContent).toBe('Sitting Out');
  });
});

describe('the parent decides from the engine lists', () => {
  it('TablePage reads post_bb_deferred_user_ids before waiting_for_bb_user_ids', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    // The prop's expression, bounded by the prop that follows it in the JSX.
    const expr = sliceBetween(page, 'entryWait={', 'showPickedCardIndexes=');
    expect(expr.length).toBeGreaterThan(0);
    expect(expr).toContain('(tableState.postBBDeferredUserIds ?? []).includes(displayPlayer.id)');
    expect(expr).toContain("? 'posting_bb'");
    expect(expr).toContain('(tableState.waitingForBBUserIds ?? []).includes(displayPlayer.id)');
    expect(expr).toContain("? 'waiting_for_bb'");
    // the deferred check is the earlier branch
    expect(expr.indexOf('postBBDeferredUserIds')).toBeLessThan(expr.indexOf('waitingForBBUserIds'));
  });

  it('a player released to post on the next deal is posting, not sitting out (2026-09-24)', () => {
    // postBBToEnter deletes the player from BOTH waitingForBB and
    // postBBWhenClear and parks them in postingBBToEnter, which was not
    // published. So between the tap and the deal the seat read neither list
    // and fell through to SITTING OUT - the case Dan named.
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    const expr = sliceBetween(page, 'entryWait={', 'showPickedCardIndexes=');
    expect(expr).toContain('(tableState.postingBBUserIds ?? []).includes(displayPlayer.id)');
    expect(expr.indexOf('postingBBUserIds')).toBeLessThan(expr.indexOf("? 'posting_bb'"));
    const mapper = readFileSync(resolve(__dirname, '../../src/utils/mapEngineSnapshot.ts'), 'utf8');
    expect(mapper).toContain('posting_bb_user_ids');
    expect(mapper).toMatch(
      /postingBBUserIds:\s*\n?\s*\(s as unknown as \{ posting_bb_user_ids\?: string\[\] \}\)\.posting_bb_user_ids \?\? \[\]/
    );
    const engine = readFileSync(
      resolve(__dirname, '../../server/src/engine/ServerTableEngine.ts'),
      'utf8'
    );
    // Both snapshot builders (live and idle) publish it.
    expect(
      engine.match(/posting_bb_user_ids: Array\.from\(this\.postingBBToEnter\)/g)
    ).toHaveLength(2);
  });
});
