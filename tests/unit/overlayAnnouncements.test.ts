/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERLAY ANNOUNCEMENTS — last level of late reg, under half the guarantee
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-01, verbatim: "the ticker needs to be adjusted to only announce
 * when a MTT Is starting, and only if an overlay alert is in the last level of
 * late registration, and has less then 50% of the prize pool of the guarantee
 * yet registered".
 *
 * That replaced the two gates this file used to pin:
 *   - "75% of the late-reg window has elapsed"  ->  "on the LAST LEVEL of it"
 *   - "at least 10% of the guarantee missing"   ->  "under 50% of it paid in"
 *
 * Both old rules are gone on purpose, so the specs that pinned them are
 * rewritten here rather than left asserting a rule the product no longer has.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): `prize_pool` and `current_players` count
 * every horse in the field. Nothing in these fixtures or in the module under
 * test filters on `is_horse`, and the last test in this file says so out loud.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  overlayFor,
  isInLastLateRegLevel,
  rankOverlayAnnouncements,
  overlayMessage,
  MAX_REGISTERED_FRACTION,
  MIN_OVERLAY_CHIPS,
  type OverlayCandidate,
} from '../../src/utils/overlayAnnouncements';

const NOW = Date.parse('2026-09-01T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/**
 * A running Sunday $200 Deep Stack with late registration through four levels
 * (`late_reg_levels: 4`, a 0-based cap, so levels 0..3), currently on level 3 —
 * the LAST one — with 900 of a 20,000 guarantee paid in.
 */
const lastLevel = (over: Partial<OverlayCandidate> = {}): OverlayCandidate => ({
  format_contract: 'mtt-v1',
  id: 't1',
  name: 'Sunday $200 Deep Stack',
  status: 'RUNNING',
  start_time: at(-50 * MIN),
  started_at: at(-50 * MIN),
  late_reg_mins: 0,
  late_reg_levels: 4,
  current_level: 3,
  guaranteed_prize: 20000,
  prize_pool: 900,
  current_players: 5,
  buy_in_amount: 180,
  max_players: 1000,
  ...over,
});

describe('future events NEVER announce', () => {
  it.each([null, 'seat-first-satellite-v1', 'spin-v1', 'sng-v1'])(
    'does not sell MTT late entry for format %s',
    (format_contract) => {
      expect(overlayFor(lastLevel({ format_contract }), NOW)).toBeNull();
    }
  );
  it('says nothing about a registering event, however short and however soon', () => {
    expect(
      overlayFor(
        lastLevel({ status: 'REGISTERING', start_time: at(2 * HOUR), started_at: null }),
        NOW
      )
    ).toBeNull();
  });

  it('says nothing about an announced event six days out', () => {
    expect(
      overlayFor(
        lastLevel({ status: 'ANNOUNCED', start_time: at(6 * 24 * HOUR), started_at: null }),
        NOW
      )
    ).toBeNull();
  });

  it('says nothing about a finished event', () => {
    expect(
      overlayFor(lastLevel({ status: 'COMPLETED', start_time: at(-5 * HOUR) }), NOW)
    ).toBeNull();
  });
});

describe('GATE 1: the LAST level of late registration, and no other', () => {
  it('announces on the final late-reg level', () => {
    const a = overlayFor(lastLevel(), NOW);
    expect(a).not.toBeNull();
    expect(a!.tier).toBe('live');
    expect(a!.overlay).toBe(19100);
  });

  it('stays quiet one level early', () => {
    expect(overlayFor(lastLevel({ current_level: 2 }), NOW)).toBeNull();
  });

  it('stays quiet on the very first late-reg level of a long window', () => {
    expect(overlayFor(lastLevel({ late_reg_levels: 8, current_level: 0 }), NOW)).toBeNull();
  });

  it('stays quiet once the door has closed, level index past the cap', () => {
    expect(overlayFor(lastLevel({ current_level: 4 }), NOW)).toBeNull();
    expect(overlayFor(lastLevel({ current_level: 9 }), NOW)).toBeNull();
  });

  it('handles a one-level window: level 0 is the last level', () => {
    expect(isInLastLateRegLevel(lastLevel({ late_reg_levels: 1, current_level: 0 }))).toBe(true);
    expect(overlayFor(lastLevel({ late_reg_levels: 1, current_level: 0 }), NOW)).not.toBeNull();
  });

  it('fails CLOSED when the row has no level-based late-reg window at all', () => {
    // A minutes-only window has no "last level" to be on. A guess is exactly
    // what this gate exists to prevent.
    expect(isInLastLateRegLevel(lastLevel({ late_reg_levels: 0 }))).toBe(false);
    expect(
      overlayFor(lastLevel({ late_reg_levels: 0, late_reg_mins: 60, current_level: 3 }), NOW)
    ).toBeNull();
    expect(isInLastLateRegLevel(lastLevel({ late_reg_levels: null }))).toBe(false);
  });
});

describe('GATE 2: under 50% of the guarantee paid in', () => {
  it('is stated as half', () => {
    expect(MAX_REGISTERED_FRACTION).toBe(0.5);
  });

  it('announces a field that has paid for a quarter of the guarantee', () => {
    expect(overlayFor(lastLevel({ prize_pool: 5000 }), NOW)).not.toBeNull();
  });

  it('crosses over exactly at half', () => {
    // 9,999 of 20,000 paid in: under half, announce.
    expect(overlayFor(lastLevel({ prize_pool: 9999 }), NOW)).not.toBeNull();
    // 10,000 of 20,000: exactly half, which is not LESS than half. Silence.
    expect(overlayFor(lastLevel({ prize_pool: 10000 }), NOW)).toBeNull();
    expect(overlayFor(lastLevel({ prize_pool: 10001 }), NOW)).toBeNull();
  });

  it('no longer announces the 10%-short events the old rule spoke about', () => {
    // 18,000 of a 20,000 guarantee is a 2,000 shortfall: it cleared the old
    // MIN_OVERLAY_FRACTION of 0.1 and is silent now, which is the point of the
    // change.
    expect(overlayFor(lastLevel({ prize_pool: 18000 }), NOW)).toBeNull();
  });

  it('ignores a trivial absolute gap even on a tiny guarantee', () => {
    expect(MIN_OVERLAY_CHIPS).toBe(100);
    expect(overlayFor(lastLevel({ guaranteed_prize: 150, prize_pool: 60 }), NOW)).toBeNull();
  });

  it('never announces an event with no guarantee at all', () => {
    expect(overlayFor(lastLevel({ guaranteed_prize: 0 }), NOW)).toBeNull();
    expect(overlayFor(lastLevel({ guaranteed_prize: null }), NOW)).toBeNull();
  });

  it('never announces once the field has covered the guarantee', () => {
    expect(overlayFor(lastLevel({ prize_pool: 20000 }), NOW)).toBeNull();
    expect(overlayFor(lastLevel({ prize_pool: 25000 }), NOW)).toBeNull();
  });
});

describe('how many more players would close it', () => {
  it('counts against the PRIZE side of the buy-in, not the total', () => {
    const a = overlayFor(lastLevel({ prize_pool: 2000 }), NOW)!;
    expect(a.overlay).toBe(18000);
    expect(a.entriesToClose).toBe(100); // 18000 / 180, not 18000 / 200 = 90
  });

  it('reports zero rather than infinity on a freeroll', () => {
    const a = overlayFor(lastLevel({ buy_in_amount: 0 }), NOW)!;
    expect(a.entriesToClose).toBe(0);
  });
});

describe('ranking: biggest live overlay first', () => {
  it('orders by the size of the overlay', () => {
    const rows: OverlayCandidate[] = [
      lastLevel({ id: 'small', guaranteed_prize: 5000, prize_pool: 0 }),
      lastLevel({ id: 'big', guaranteed_prize: 40000, prize_pool: 0 }),
    ];
    expect(rankOverlayAnnouncements(rows, NOW).map((r) => r.id)).toEqual(['big', 'small']);
  });

  it('drops everything that does not qualify, rather than padding the bar', () => {
    const rows: OverlayCandidate[] = [
      lastLevel({ id: 'future', status: 'REGISTERING', start_time: at(5 * 24 * HOUR) }),
      lastLevel({ id: 'not-last-level', current_level: 1 }),
      lastLevel({ id: 'door-closed', current_level: 4 }),
      lastLevel({ id: 'covered', prize_pool: 20000 }),
      lastLevel({ id: 'no-guarantee', guaranteed_prize: 0 }),
      lastLevel({ id: 'half-paid', prize_pool: 12000 }),
      lastLevel({ id: 'real' }),
    ];
    const ids = rankOverlayAnnouncements(rows, NOW, 10).map((r) => r.id);
    expect(ids).toEqual(['real']);
  });

  it('survives junk without throwing', () => {
    expect(rankOverlayAnnouncements([], NOW)).toEqual([]);
    expect(
      rankOverlayAnnouncements(
        [lastLevel({ start_time: 'not a date', started_at: 'not a date' }), lastLevel({ id: '' })],
        NOW
      )
    ).toEqual([]);
  });
});

describe('the copy leads with the money', () => {
  it('a live overlay says the door is on its last level', () => {
    const a = overlayFor(lastLevel({ prize_pool: 8000 }), NOW)!;
    const msg = overlayMessage(a);
    expect(msg.startsWith('12,000 Overlay Right Now')).toBe(true);
    expect(msg).toContain('20,000 Guaranteed');
    expect(msg).toContain('Last Level Of Late Registration');
    expect(msg).toContain('Jump In Now');
    expect(msg).not.toContain('—'); // house rule: no em dashes in player copy
  });
});

describe('HORSES ARE PLAYERS (CLAUDE.md 10.5)', () => {
  it('neither the overlay maths nor the ticker query filters on is_horse', () => {
    const root = resolve(__dirname, '../..');
    const module = readFileSync(resolve(root, 'src/utils/overlayAnnouncements.ts'), 'utf8');
    const ticker = readFileSync(
      resolve(root, 'src/components/tournament/TournamentStartingTicker.tsx'),
      'utf8'
    );
    /* Comments are stripped first: both files TALK about the law at length,
       and the thing that would be a bug is a horse filter in the CODE. A
       horse's buy-in reaches the prize pool exactly as a human's does, so
       excluding them would invent a shortfall the house is not covering. */
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripComments(module)).not.toMatch(/is_horse|isHorse/);
    expect(stripComments(ticker)).not.toMatch(/is_horse|isHorse/);
  });
});
