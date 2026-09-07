/**
 * AN AVATAR CHANGE STAYS CHANGED (Dan 2026-09-07).
 *
 * "WHEN A USER CHANGES THEIR AVATAR, IT BOUNCES BACK AND FORTH FROM THEIR OLD
 * AVATAR TO THE NEW ONE." The engine republishes the identity it read at the
 * top of the hand on every broadcast; the profile sync delivers the database's
 * newer value at once; both landed on the same field, last writer wins. These
 * pins replay that exact sequence and require the new face to survive it.
 */
import { describe, expect, it } from 'vitest';
import {
  createSeatIdentityOverrides,
  mergeSeatIdentity,
} from '../../src/lib/seatIdentityOverrides';

const OLD = '/avatars/table/free_cowboy@2x.webp';
const NEW = '/avatars/table/free_pirate@2x.webp';
const NEWER = '/avatars/table/vip_wolf@2x.webp';

function seat(id: string, avatar?: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, avatar, stack: 100, ...extra };
}

describe('seat identity overrides: the bounce, replayed', () => {
  it('a database change is not repainted by the next engine broadcast of the deal-time copy', () => {
    const o = createSeatIdentityOverrides();
    // Hand in progress; the engine has been publishing OLD.
    let roster = o.apply([seat('dan', OLD), seat('villain', '/avatars/table/free_fox@2x.webp')]);
    expect(roster[0]!.avatar).toBe(OLD);

    // The picker / realtime UPDATE delivers NEW.
    const painted = o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    expect(painted.avatar).toBe(NEW);
    expect(o.size()).toBe(1);

    // Every action for the rest of the hand: the engine still says OLD.
    for (let i = 0; i < 5; i += 1) {
      roster = o.apply([seat('dan', OLD), seat('villain', '/avatars/table/free_fox@2x.webp')]);
      expect(roster[0]!.avatar, `broadcast ${i}`).toBe(NEW);
    }
    // The villain's seat is never touched by dan's override.
    expect(roster[1]!.avatar).toBe('/avatars/table/free_fox@2x.webp');
    // And nothing but the identity fields moved.
    expect(roster[0]!.stack).toBe(100);
    expect(roster[0]!.name).toBe('dan');
  });

  it('the engine wins the moment it proves a re-read: next hand it publishes NEW and the override retires', () => {
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', OLD)]);
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    // Top of the next hand: loadSeatedPlayers read the row again.
    const roster = o.apply([seat('dan', NEW)]);
    expect(roster[0]!.avatar).toBe(NEW);
    expect(o.size()).toBe(0);
  });

  it('a re-read that disagrees with the override is newer than it: the engine value is adopted, whatever it is', () => {
    /* The client held NEW; the player changed again to NEWER on another
       device and this phone slept through the realtime event. The engine's
       next read is the truth and must not be overruled by a stale hold. */
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', OLD)]);
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    const roster = o.apply([seat('dan', NEWER)]);
    expect(roster[0]!.avatar).toBe(NEWER);
    expect(o.size()).toBe(0);
  });

  it('a second change inside the same hand replaces the first and still outlives the deal-time copy', () => {
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', OLD)]);
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    o.record({ userId: 'dan', avatar: NEWER }, { avatar: NEW });
    expect(o.apply([seat('dan', OLD)])[0]!.avatar).toBe(NEWER);
    // Next hand the engine catches up to NEWER.
    expect(o.apply([seat('dan', NEWER)])[0]!.avatar).toBe(NEWER);
    expect(o.size()).toBe(0);
  });

  it('an echo of what the engine already publishes holds nothing', () => {
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', NEW)]);
    // profiles UPDATE for an unrelated column re-delivers the same avatar.
    o.record({ userId: 'dan', avatar: NEW }, { avatar: NEW });
    expect(o.size()).toBe(0);
  });

  it('a change delivered before any engine frame takes the first frame as its baseline', () => {
    const o = createSeatIdentityOverrides();
    // Prefetched roster, no snapshot yet; realtime says NEW.
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    // First engine frame is mid-hand and still carries OLD: hold NEW.
    expect(o.apply([seat('dan', OLD)])[0]!.avatar).toBe(NEW);
    // Still OLD on the next broadcast: still NEW.
    expect(o.apply([seat('dan', OLD)])[0]!.avatar).toBe(NEW);
    // Re-read: engine agrees, override retires.
    expect(o.apply([seat('dan', NEW)])[0]!.avatar).toBe(NEW);
    expect(o.size()).toBe(0);
  });

  it('a change delivered before any engine frame that the first frame already agrees with retires at once', () => {
    const o = createSeatIdentityOverrides();
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    expect(o.apply([seat('dan', NEW)])[0]!.avatar).toBe(NEW);
    expect(o.size()).toBe(0);
  });

  it('cosmetics travel with the face and keep their null-means-removed meaning', () => {
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', OLD, { frame: 'frame-gold', aura: 'aura-fire' })]);
    // Avatar-only event: cosmetics untouched (undefined = not mentioned).
    let painted = o.record(
      { userId: 'dan', avatar: NEW },
      { avatar: OLD, frame: 'frame-gold', aura: 'aura-fire' }
    );
    expect(painted).toEqual({ avatar: NEW, frame: 'frame-gold', aura: 'aura-fire' });
    // Engine still on the deal-time copy: the whole triple is held.
    const held = o.apply([seat('dan', OLD, { frame: 'frame-gold', aura: 'aura-fire' })])[0]!;
    expect(held.avatar).toBe(NEW);
    expect(held.frame).toBe('frame-gold');
    // Player removes the aura (null): held as "none".
    painted = o.record({ userId: 'dan', aura: null }, painted);
    expect(painted.aura).toBeUndefined();
    const heldAgain = o.apply([seat('dan', OLD, { frame: 'frame-gold', aura: 'aura-fire' })])[0]!;
    expect(heldAgain.aura).toBeUndefined();
    expect(heldAgain.avatar).toBe(NEW);
    // A frame change by the engine is a re-read too: adopt it entirely.
    const reread = o.apply([seat('dan', NEW, { frame: 'frame-gold', aura: undefined })])[0]!;
    expect(reread.avatar).toBe(NEW);
    expect(o.size()).toBe(0);
  });

  it('a player who leaves takes their override with them', () => {
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', OLD)]);
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    o.apply([null]);
    expect(o.size()).toBe(0);
    // Coming back is a fresh engine read: no stale hold reappears.
    expect(o.apply([seat('dan', OLD)])[0]!.avatar).toBe(OLD);
  });

  it('clear() forgets everything (table change, unmount)', () => {
    const o = createSeatIdentityOverrides();
    o.apply([seat('dan', OLD)]);
    o.record({ userId: 'dan', avatar: NEW }, { avatar: OLD });
    o.clear();
    expect(o.size()).toBe(0);
    expect(o.apply([seat('dan', OLD)])[0]!.avatar).toBe(OLD);
  });

  it('null seats pass through untouched and the array length is preserved', () => {
    const o = createSeatIdentityOverrides();
    const out = o.apply([null, seat('dan', OLD), null]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeNull();
    expect(out[2]).toBeNull();
  });
});

describe('mergeSeatIdentity', () => {
  it('undefined keeps, null removes, a value replaces', () => {
    const base = { avatar: OLD, frame: 'frame-gold', aura: 'aura-fire' };
    expect(mergeSeatIdentity(base, { userId: 'x' })).toEqual(base);
    expect(mergeSeatIdentity(base, { userId: 'x', frame: null })).toEqual({
      avatar: OLD,
      frame: undefined,
      aura: 'aura-fire',
    });
    expect(mergeSeatIdentity(base, { userId: 'x', avatar: NEW, aura: 'aura-ice' })).toEqual({
      avatar: NEW,
      frame: 'frame-gold',
      aura: 'aura-ice',
    });
    expect(mergeSeatIdentity(undefined, { userId: 'x', avatar: NEW })).toEqual({
      avatar: NEW,
      frame: undefined,
      aura: undefined,
    });
  });
});
