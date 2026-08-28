/**
 * THE JACKPOT IS ANNOUNCED ONCE, WHEN IT HAPPENS.
 *
 * Dan 2026-08-26: "the notification keeps resending anytime you refresh or
 * open a page... it should only display once, and at the actual time it
 * happens."
 *
 * The bug was not in the transport. The engine hub RETAINS transient events
 * and re-delivers them to every fresh socket — deliberately, so a player who
 * reconnects mid-hand still receives the showdown reveal — and the client's
 * only de-duplication was `EngineStateClient.lastEventSeq`, which resets on
 * connect by design. A refresh therefore looked exactly like a new jackpot.
 *
 * These tests pin the two gates that replaced it, and specifically pin the
 * REFRESH case, which is the one a module-level guard cannot pass: the module
 * is reinitialised by the page load, so anything held in a plain variable is
 * gone precisely when it is needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldAnnounceBbjHit,
  bbjHitKey,
  BBJ_FRESH_MS,
  __resetBbjSeenForTests,
} from '../../src/lib/bbjHitOnce';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  __resetBbjSeenForTests();
});

describe('a live jackpot is announced', () => {
  it('announces a hit that just happened', () => {
    expect(
      shouldAnnounceBbjHit({ tableId: 't1', handNumber: 42, emittedAt: NOW - 1200, now: NOW })
    ).toBe(true);
  });

  it('announces a hit from an engine that sends no timestamp (older engine)', () => {
    // Compatibility: identity still applies, freshness simply cannot.
    expect(shouldAnnounceBbjHit({ tableId: 't1', handNumber: 42, now: NOW })).toBe(true);
  });

  it('does not reject a hit whose stamp is slightly in the future', () => {
    /* A device clock running behind the engine's makes a live hit look
       future-dated. Rejecting those would suppress the real thing on exactly
       the devices least able to report why. */
    expect(
      shouldAnnounceBbjHit({ tableId: 't1', handNumber: 42, emittedAt: NOW + 5_000, now: NOW })
    ).toBe(true);
  });
});

describe('the same hit is never announced twice', () => {
  it('a second delivery of the same hit is silent', () => {
    const hit = { tableId: 't1', handNumber: 42, emittedAt: NOW - 500, now: NOW };
    expect(shouldAnnounceBbjHit(hit)).toBe(true);
    expect(shouldAnnounceBbjHit(hit)).toBe(false);
    expect(shouldAnnounceBbjHit(hit)).toBe(false);
  });

  it('SURVIVES A PAGE REFRESH — the reported bug, in one test', () => {
    /* This is the case a module-level guard structurally cannot cover: a
       reload reinitialises the module, so the only thing that can remember
       is storage. The hit is still INSIDE its freshness window here, which
       is exactly when a player refreshes — they just saw a jackpot and want
       to look at the table again. */
    const hit = { tableId: 't1', handNumber: 42, emittedAt: NOW - 2_000, now: NOW };
    expect(shouldAnnounceBbjHit(hit)).toBe(true);

    // The reload: in-memory state is gone, sessionStorage is not.
    __simulateReload();

    expect(
      shouldAnnounceBbjHit({ ...hit, now: NOW + 3_000 }),
      'the jackpot re-announced itself after a refresh'
    ).toBe(false);
  });

  it('a DIFFERENT hand on the same table is a different hit', () => {
    expect(shouldAnnounceBbjHit({ tableId: 't1', handNumber: 42, now: NOW })).toBe(true);
    expect(shouldAnnounceBbjHit({ tableId: 't1', handNumber: 43, now: NOW })).toBe(true);
  });

  it('the same hand number on a different table is a different hit', () => {
    expect(shouldAnnounceBbjHit({ tableId: 't1', handNumber: 42, now: NOW })).toBe(true);
    expect(shouldAnnounceBbjHit({ tableId: 't2', handNumber: 42, now: NOW })).toBe(true);
  });

  it('four mounted tables receiving one broadcast announce it once', () => {
    // The multi-table case the old 5-second module window existed for.
    const hit = { tableId: 'other', handNumber: 7, emittedAt: NOW, now: NOW };
    const results = [1, 2, 3, 4].map(() => shouldAnnounceBbjHit(hit));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('a stale replay is not announced at all', () => {
  it('rejects a retained event older than the freshness window', () => {
    expect(
      shouldAnnounceBbjHit({
        tableId: 't1',
        handNumber: 42,
        emittedAt: NOW - (BBJ_FRESH_MS + 1),
        now: NOW,
      }),
      'an hours-old retained event was announced as news'
    ).toBe(false);
  });

  it('rejects it even for a player who has never seen it before', () => {
    /* Identity alone would happily show a first-time viewer an hour-old
       jackpot, once, as though it had just happened. Freshness is the gate
       that covers this; the fresh session below proves identity is not what
       is doing the work here. */
    __simulateReload();
    expect(
      shouldAnnounceBbjHit({
        tableId: 'never-seen',
        handNumber: 999,
        emittedAt: NOW - 60 * 60 * 1000,
        now: NOW,
      })
    ).toBe(false);
  });

  it('a rejected stale hit is not remembered, so the live one still lands', () => {
    /* Order matters: the stale replay must not "use up" the identity and
       silence the genuine announcement that follows it. */
    const stale = {
      tableId: 't9',
      handNumber: 5,
      emittedAt: NOW - (BBJ_FRESH_MS + 5_000),
      now: NOW,
    };
    expect(shouldAnnounceBbjHit(stale)).toBe(false);
    expect(shouldAnnounceBbjHit({ tableId: 't9', handNumber: 5, emittedAt: NOW, now: NOW })).toBe(
      true
    );
  });
});

describe('requireStamp — the login-path banner refuses unprovable hits (Dan 2026-08-28)', () => {
  it('refuses an unstamped event when the caller demands a stamp', () => {
    expect(
      shouldAnnounceBbjHit({ tableId: 't1', handNumber: 7, requireStamp: true, now: NOW })
    ).toBe(false);
  });

  it('does NOT mark an unstamped refusal as seen — a stamped copy may still announce', () => {
    shouldAnnounceBbjHit({ tableId: 't1', handNumber: 8, requireStamp: true, now: NOW });
    expect(
      shouldAnnounceBbjHit({
        tableId: 't1',
        handNumber: 8,
        emittedAt: NOW - 1_000,
        requireStamp: true,
        now: NOW,
      })
    ).toBe(true);
  });

  it('a fresh stamped event still announces with requireStamp', () => {
    expect(
      shouldAnnounceBbjHit({
        tableId: 't1',
        handNumber: 9,
        emittedAt: NOW - 5_000,
        requireStamp: true,
        now: NOW,
      })
    ).toBe(true);
  });

  it('a stale stamped event is still refused with requireStamp', () => {
    expect(
      shouldAnnounceBbjHit({
        tableId: 't1',
        handNumber: 10,
        emittedAt: NOW - 10 * 60_000,
        requireStamp: true,
        now: NOW,
      })
    ).toBe(false);
  });

  it('without requireStamp an unstamped event keeps the legacy identity-only path', () => {
    expect(shouldAnnounceBbjHit({ tableId: 't1', handNumber: 11, now: NOW })).toBe(true);
    expect(shouldAnnounceBbjHit({ tableId: 't1', handNumber: 11, now: NOW })).toBe(false);
  });
});

describe('it never takes the table down', () => {
  it('still de-duplicates when storage throws (Safari private mode)', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      const hit = { tableId: 't1', handNumber: 42, now: NOW };
      expect(() => shouldAnnounceBbjHit(hit)).not.toThrow();
      expect(shouldAnnounceBbjHit(hit), 'in-memory de-duplication stopped working').toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('builds a stable key even with nothing to build it from', () => {
    expect(bbjHitKey(undefined, undefined)).toBe('unknown:0');
    expect(bbjHitKey('t1', 42)).toBe('t1:42');
  });

  it('caps what it remembers so storage cannot grow without bound', () => {
    for (let i = 0; i < 120; i++) {
      shouldAnnounceBbjHit({ tableId: 't', handNumber: i, now: NOW });
    }
    const stored = JSON.parse(sessionStorage.getItem('sp-bbj-seen-hits') || '[]');
    expect(stored.length).toBeLessThanOrEqual(50);
    // and the most recent is always the one kept
    expect(stored).toContain('t:119');
  });
});

/**
 * A page reload, as far as this module can tell: the in-memory Set is gone,
 * sessionStorage survives. Re-importing the module under vitest would give a
 * fresh Set but also a fresh storage read, which is exactly the same thing —
 * this is the cheaper expression of it and does not depend on module cache
 * behaviour that could change under a bundler upgrade.
 */
function __simulateReload(): void {
  const kept = sessionStorage.getItem('sp-bbj-seen-hits');
  __resetBbjSeenForTests();
  if (kept) sessionStorage.setItem('sp-bbj-seen-hits', kept);
}
