/**
 * A PLAYER IS CALLED WHAT THEY ASKED TO BE CALLED.
 *
 * Dan, 2026-08-23: "FIX WHAT EVER IS CAUSING IT TO CALL ME 'MARCUS CHEN'
 * INSTEAD OF KINGFISH OR DAN BEKAVAC".
 *
 * The first case below is his ACTUAL production row, copied field for field.
 * It is the whole bug in one object: four different names, a preference that
 * settles it, and a `display_name` carrying seed data that belongs to nobody.
 * Every screen that reached for `display_name` first greeted him as a stranger.
 */
import { describe, it, expect } from 'vitest';
import {
  playerDisplayName,
  realName,
  handleName,
  PLAYER_NAME_COLUMNS,
} from '../../src/utils/playerDisplayName';

/** Dan's row in production on 2026-08-23. Do not "tidy" these values. */
const DAN = {
  username: 'kingfish',
  display_name: 'Marcus Chen',
  alias: 'KingFish',
  first_name: 'Dan',
  last_name: 'Bekavac',
  full_name: 'Dan Bekavac',
  display_name_preference: 'full_name',
  use_real_name: false,
};

describe('the Marcus Chen bug', () => {
  it('never calls Dan "Marcus Chen"', () => {
    expect(playerDisplayName(DAN)).not.toBe('Marcus Chen');
  });

  it('honours his stated preference, which is his full name', () => {
    expect(playerDisplayName(DAN)).toBe('Dan Bekavac');
  });

  it('falls to his handle, not to display_name, when no preference is set', () => {
    // The ordering that matters: a name the player TYPED beats a column nobody
    // owns. Without this, clearing the preference reintroduces the bug.
    const noPref = { ...DAN, display_name_preference: null };
    expect(playerDisplayName(noPref)).toBe('KingFish');
  });

  it('still avoids display_name even with no preference and no alias', () => {
    const bare = { ...DAN, display_name_preference: null, alias: null };
    expect(playerDisplayName(bare)).toBe('kingfish');
  });
});

describe('preference resolution', () => {
  it('reads each preference value', () => {
    expect(playerDisplayName({ ...DAN, display_name_preference: 'alias' })).toBe('KingFish');
    expect(playerDisplayName({ ...DAN, display_name_preference: 'username' })).toBe('kingfish');
    expect(playerDisplayName({ ...DAN, display_name_preference: 'real_name' })).toBe('Dan Bekavac');
    expect(playerDisplayName({ ...DAN, display_name_preference: 'display_name' })).toBe(
      'Marcus Chen'
    );
  });

  it('ignores a preference pointing at an empty column rather than rendering blank', () => {
    /* A player who chose `full_name` and then never set one must still get a
       name. Returning '' here would put an empty label on the card. */
    const noReal = {
      username: 'shortstack',
      display_name_preference: 'full_name',
      full_name: '   ',
      first_name: null,
      last_name: null,
    };
    expect(playerDisplayName(noReal)).toBe('shortstack');
  });

  it('honours the older use_real_name boolean when no preference is set', () => {
    const legacy = { ...DAN, display_name_preference: null, use_real_name: true };
    expect(playerDisplayName(legacy)).toBe('Dan Bekavac');
  });

  it('does not let use_real_name win over an explicit preference', () => {
    const conflict = { ...DAN, display_name_preference: 'alias', use_real_name: true };
    expect(playerDisplayName(conflict)).toBe('KingFish');
  });
});

describe('never renders nothing', () => {
  it('handles null, undefined and an empty profile', () => {
    expect(playerDisplayName(null)).toBe('Player');
    expect(playerDisplayName(undefined)).toBe('Player');
    expect(playerDisplayName({})).toBe('Player');
  });

  it('treats whitespace-only columns as absent', () => {
    expect(playerDisplayName({ username: '   ', alias: '\t', display_name: 'Real' })).toBe('Real');
  });

  it('assembles a real name from first and last when full_name is missing', () => {
    expect(realName({ first_name: 'Dan', last_name: 'Bekavac' })).toBe('Dan Bekavac');
    expect(realName({ first_name: 'Dan' })).toBe('Dan');
    expect(realName({})).toBeNull();
  });

  it('exposes the handle separately for surfaces that want it', () => {
    expect(handleName(DAN)).toBe('KingFish');
    expect(handleName({ username: 'onlyuser' })).toBe('onlyuser');
    expect(handleName({})).toBeNull();
  });
});

describe('the query contract', () => {
  it('names every column the resolver reads', () => {
    /* A resolver is only as good as the SELECT that feeds it. Selecting
       `username, display_name` and then asking for the preference silently
       returns undefined and falls through - which looks exactly like the bug
       this file exists to prevent. */
    for (const col of [
      'username',
      'display_name',
      'alias',
      'first_name',
      'last_name',
      'full_name',
      'display_name_preference',
      'use_real_name',
    ]) {
      expect(PLAYER_NAME_COLUMNS).toContain(col);
    }
  });
});
