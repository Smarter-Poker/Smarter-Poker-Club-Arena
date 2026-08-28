/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A TABLE WITH NO HAND SHOWS NO HANDS (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, on a Spin still selling its third seat: the two players who had
 * already bought seats were each drawn holding a fan of face-down cards. No
 * card had been dealt — the game cannot start until the third seat is paid —
 * so the table looked mid-hand while it was plainly waiting.
 *
 * Cause: the villain fan renders for any seat whose status is 'active', which
 * every seated player is from the moment they sit. The cards were furniture.
 *
 * The gate is deliberately PERMISSIVE, and that is the part worth pinning:
 * cards actually delivered, an all-in (mid-hand by definition), a deal
 * animating, a fold or a muck flying out all still draw regardless of it. The
 * animation law (CLAUDE.md 10.6) says every animation plays every time it is
 * owed; a gate that could swallow a deal, a fold or a muck would be a
 * regression of exactly that law wearing a bug fix's clothes.
 *
 * Source-contract pins — the repo's pattern for guards inside components too
 * heavy to render in a unit test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

describe('pre-start seat-first tables draw no hands', () => {
  const seat = read('components/table/SeatSlot.tsx');
  const table = read('pages/TablePage.tsx');

  it('SeatSlot takes handInPlay and defaults it TRUE so other callers are unchanged', () => {
    expect(seat).toContain('handInPlay?: boolean;');
    expect(seat).toContain('handInPlay = true,');
  });

  it('the villain fan is gated on it', () => {
    const fan = seat.slice(
      seat.indexOf('{!player.isHero &&'),
      seat.indexOf('className={`seat__cards seat__cards--opponent')
    );
    expect(fan).toContain('handInPlay ||');
  });

  it('every protected animation keeps its own escape hatch', () => {
    const fan = seat.slice(
      seat.indexOf('{!player.isHero &&'),
      seat.indexOf('className={`seat__cards seat__cards--opponent')
    );
    // A real hand, an all-in, a deal, a fold and a muck each draw whatever
    // handInPlay says. Removing any of these re-breaks the animation law.
    expect(fan).toContain('(player.holeCards?.length ?? 0) > 0');
    expect(fan).toContain("player.status === 'all_in'");
    expect(fan).toContain('isDealing');
    expect(fan).toContain('isFolding');
    expect(fan).toContain('isMucking');
  });

  it('the memo cannot swallow the flip when the first hand starts', () => {
    expect(seat).toContain('if (prev.handInPlay !== next.handInPlay) return false;');
  });

  it('TablePage feeds it from the live hand, not from the seat', () => {
    expect(table).toContain(
      'handInPlay={tableState.isHandInProgress || (tableState.handNumber ?? 0) > 0}'
    );
  });
});
