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

describe("the Marcus Chen bug — a horse's name on a person", () => {
  it('never calls Dan "Marcus Chen", on either surface', () => {
    expect(playerDisplayName(DAN, 'arena')).not.toBe('Marcus Chen');
    expect(playerDisplayName(DAN, 'social')).not.toBe('Marcus Chen');
  });

  it('is KingFish in the Club Arena', () => {
    // Dan 2026-08-23: "IM DAN BEKAVAC ON SOCIAL AND KINGFISH IN THE CLUB ARENA."
    expect(playerDisplayName(DAN, 'arena')).toBe('KingFish');
  });

  it('is Dan Bekavac on social', () => {
    expect(playerDisplayName(DAN, 'social')).toBe('Dan Bekavac');
  });

  it('defaults to the arena answer when no context is given', () => {
    /* This repo IS the Club Arena, so a forgetful caller gets the pseudonymous
       name. Being wrong in that direction leaks nothing. */
    expect(playerDisplayName(DAN)).toBe('KingFish');
  });
});

describe('the arena never shows a real name', () => {
  it('ignores a full_name preference at the table', () => {
    /* Dan's row literally has display_name_preference = full_name. Honouring it
       in the arena is how "Dan Bekavac" would end up printed beside a stack. */
    expect(playerDisplayName({ ...DAN, display_name_preference: 'full_name' }, 'arena')).toBe(
      'KingFish'
    );
  });

  it('ignores the legacy use_real_name boolean at the table', () => {
    expect(playerDisplayName({ ...DAN, use_real_name: true }, 'arena')).toBe('KingFish');
  });

  it('never returns the real name in the arena, for any profile shape', () => {
    const shapes = [
      DAN,
      { ...DAN, alias: null },
      { ...DAN, display_name_preference: 'real_name', use_real_name: true },
      { ...DAN, display_name: null },
    ];
    for (const s of shapes) {
      expect(playerDisplayName(s, 'arena')).not.toBe('Dan Bekavac');
    }
  });

  it('falls to the username when there is no alias', () => {
    expect(playerDisplayName({ ...DAN, alias: null }, 'arena')).toBe('kingfish');
  });
});

describe('social honours what the player asked for', () => {
  it('shows the handle when they have not opted into their real name', () => {
    const private_ = { ...DAN, display_name_preference: null, use_real_name: false };
    expect(playerDisplayName(private_, 'social')).toBe('KingFish');
  });

  it('honours the legacy boolean when no preference is set', () => {
    const legacy = { ...DAN, display_name_preference: null, use_real_name: true };
    expect(playerDisplayName(legacy, 'social')).toBe('Dan Bekavac');
  });

  it('does not render blank when they chose a real name they never set', () => {
    const noReal = {
      username: 'shortstack',
      display_name_preference: 'full_name',
      full_name: '   ',
      first_name: null,
      last_name: null,
    };
    expect(playerDisplayName(noReal, 'social')).toBe('shortstack');
  });
});

describe('display_name is last, everywhere', () => {
  it('is only reached when nothing a player chose exists', () => {
    /* It is the column that was found holding a horse's name on a human
       account. It may still be the only thing present on a legacy row, so it
       stays as a last resort - and nothing more. */
    const onlyDisplay = { display_name: 'Legacy Person' };
    expect(playerDisplayName(onlyDisplay, 'arena')).toBe('Legacy Person');
    expect(playerDisplayName(onlyDisplay, 'social')).toBe('Legacy Person');

    const hasHandle = { display_name: 'Legacy Person', username: 'realhandle' };
    expect(playerDisplayName(hasHandle, 'arena')).toBe('realhandle');
  });
});

describe('never renders nothing', () => {
  it('handles null, undefined and an empty profile', () => {
    for (const ctx of ['arena', 'social'] as const) {
      expect(playerDisplayName(null, ctx)).toBe('Player');
      expect(playerDisplayName(undefined, ctx)).toBe('Player');
      expect(playerDisplayName({}, ctx)).toBe('Player');
    }
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
