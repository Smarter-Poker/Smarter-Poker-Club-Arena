/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CHIME IS THE EASIEST THING ON THIS STRIP TO GET WRONG
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A bar that beeps is a bar that gets muted, and a player who mutes the app to
 * silence an announcement strip also mutes their own turn alert. The failure
 * mode is not annoyance - it is a player timing out on a hand because they
 * switched the sound off to escape an advertisement.
 *
 * So every rule in tickerChime.ts is asserted here, including the two that are
 * refusals to make a sound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playRailAlert = vi.fn();
const isEnabled = vi.fn(() => true);

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    get isEnabled() {
      return isEnabled;
    },
    get playRailAlert() {
      return playRailAlert;
    },
  },
}));

import { announce, resetTickerChime } from '../../src/components/tournament/tickerChime';

/** The tab has already shown something, which is the ordinary running state. */
function warmUp() {
  announce('starting_soon', 'warm-up');
}

beforeEach(() => {
  resetTickerChime();
  playRailAlert.mockClear();
  isEnabled.mockClear();
  isEnabled.mockReturnValue(true);
});

afterEach(() => {
  resetTickerChime();
});

describe('only an overlay guarantee earns a sound', () => {
  it('chimes for an overlay', () => {
    warmUp();
    expect(announce('overlays', 'o1')).toBe(true);
    expect(playRailAlert).toHaveBeenCalledTimes(1);
  });

  it.each([
    'starting_soon',
    'registration_closing',
    'guarantees',
    'table_openings',
    'winner_results',
    'maintenance',
    'custom_messages',
  ] as const)('stays silent for %s', (kind) => {
    warmUp();
    expect(announce(kind, `${kind}-1`)).toBe(false);
    expect(playRailAlert).not.toHaveBeenCalled();
  });
});

describe('the arrival is the event, not the presence', () => {
  it('chimes once for an announcement however many times it is offered', () => {
    warmUp();
    announce('overlays', 'o1');
    announce('overlays', 'o1');
    announce('overlays', 'o1');
    expect(playRailAlert).toHaveBeenCalledTimes(1);
  });

  it('chimes again for a DIFFERENT overlay', () => {
    warmUp();
    announce('overlays', 'o1');
    announce('overlays', 'o2');
    expect(playRailAlert).toHaveBeenCalledTimes(2);
  });

  it('survives the container unmounting, which is every route change', () => {
    /* THE DEFECT THIS PREVENTS. The memory lives in module scope, not in the
       component. A per-component memory would reset on every navigation and
       chime again for the same overlay each time a player moved around. */
    warmUp();
    announce('overlays', 'o1');
    // A route change: the component goes away, the module does not.
    announce('overlays', 'o1');
    expect(playRailAlert).toHaveBeenCalledTimes(1);
  });

  it('forgets the oldest ids rather than growing without bound', () => {
    warmUp();
    for (let i = 0; i < 205; i += 1) announce('overlays', `o${i}`);
    expect(playRailAlert).toHaveBeenCalledTimes(205);
    // The window rolled, so a very old id is allowed to speak once more. That
    // is the cost of a bounded memory, and it is one tone on a tab that has
    // seen two hundred overlays.
    expect(announce('overlays', 'o0')).toBe(true);
  });
});

describe('the first strip a tab shows never makes a noise', () => {
  it('is silent when the overlay is the very first announcement', () => {
    /* Arriving on a page that immediately beeps at you is a different thing
       from an announcement arriving while you sit there, and only the second
       is news. */
    expect(announce('overlays', 'o1')).toBe(false);
    expect(playRailAlert).not.toHaveBeenCalled();
  });

  it('does not chime for that same overlay once the tab warms up', () => {
    /* The silent first strip is still REMEMBERED, so the lane re-computing a
       moment later cannot smuggle the same announcement back in with a tone
       attached. */
    announce('overlays', 'o1');
    announce('starting_soon', 'x');
    expect(announce('overlays', 'o1')).toBe(false);
    expect(playRailAlert).not.toHaveBeenCalled();
  });

  it('chimes for the next overlay after a silent first strip', () => {
    announce('overlays', 'o1');
    expect(announce('overlays', 'o2')).toBe(true);
    expect(playRailAlert).toHaveBeenCalledTimes(1);
  });

  it('counts a silent NON-overlay as warming the tab up', () => {
    announce('maintenance', 'm1');
    expect(announce('overlays', 'o1')).toBe(true);
  });
});

describe("the player's switch wins", () => {
  it('plays nothing when sound is off', () => {
    warmUp();
    isEnabled.mockReturnValue(false);
    expect(announce('overlays', 'o1')).toBe(false);
    expect(playRailAlert).not.toHaveBeenCalled();
  });

  it('asks BEFORE playing, so a muted tab never wakes an AudioContext', () => {
    warmUp();
    isEnabled.mockReturnValue(false);
    announce('overlays', 'o1');
    expect(isEnabled).toHaveBeenCalled();
    expect(playRailAlert).not.toHaveBeenCalled();
  });

  it('does not ask at all for a kind that could never chime', () => {
    warmUp();
    announce('starting_soon', 's1');
    expect(isEnabled).not.toHaveBeenCalled();
  });
});
