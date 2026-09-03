/**
 * Anonymous tables must scrub the equipped frame and aura, not only the name
 * and the picture.
 *
 * `seatIdentity` was added 2026-08-25 for `is_anonymous`, and it scrubbed
 * exactly two fields because at the time a seat carried exactly two identity
 * fields. Cosmetics landed the same day and are the third: they are worn ON the
 * avatar, they are rare, and they are stable across sessions. A table where
 * every name reads "Player 4" but one seat burns with `frame-hellfire` every
 * night is not anonymous - it has one anonymous player and one signature.
 *
 * The method is `protected`, so this reaches it through the prototype rather
 * than standing up a whole engine. What is being pinned is a branch, not an
 * integration.
 */
import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

type Identity = {
  username: string;
  avatar_url: string;
  equipped_frame: string;
  equipped_aura: string;
};

function identityFor(isAnonymous: boolean, seat: Record<string, unknown>): Identity {
  const fn = (
    ServerTableEngine.prototype as unknown as {
      seatIdentity: (p: Record<string, unknown>) => Identity;
    }
  ).seatIdentity;
  return fn.call({ tableInfo: { is_anonymous: isAnonymous } }, seat);
}

const SEAT = {
  seat: 4,
  username: 'DanTheMan',
  avatar_url: '/avatars/table/vip_wolf@2x.webp',
  equipped_frame: 'frame-hellfire',
  equipped_aura: 'aura-glitch',
};

describe('seatIdentity - cosmetics are identity', () => {
  it('passes everything through at a normal table', () => {
    expect(identityFor(false, SEAT)).toEqual({
      username: 'DanTheMan',
      avatar_url: '/avatars/table/vip_wolf@2x.webp',
      equipped_frame: 'frame-hellfire',
      equipped_aura: 'aura-glitch',
    });
  });

  it('scrubs the frame and the aura at an anonymous table', () => {
    expect(identityFor(true, SEAT)).toEqual({
      username: 'Player 4',
      avatar_url: '',
      equipped_frame: '',
      equipped_aura: '',
    });
  });

  it('never returns undefined for a seat that has no cosmetics', () => {
    // The payload fields are non-optional strings on the wire. undefined would
    // serialize to a missing key and the client's `|| undefined` normalisation
    // would be reading a field that is not there.
    const bare = { seat: 2, username: 'X', avatar_url: '' };
    expect(identityFor(false, bare)).toEqual({
      username: 'X',
      avatar_url: '',
      equipped_frame: '',
      equipped_aura: '',
    });
  });

  it('falls back to a seatless label without leaking cosmetics', () => {
    expect(identityFor(true, { username: 'X', equipped_frame: 'frame-gold' })).toEqual({
      username: 'Player',
      avatar_url: '',
      equipped_frame: '',
      equipped_aura: '',
    });
  });
});
