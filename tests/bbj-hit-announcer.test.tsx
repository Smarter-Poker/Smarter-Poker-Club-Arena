/**
 * THE CLUB-WIDE JACKPOT POP-UP IS DRAWN ONCE, WHERE IT CAN BE SEEN
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ full audit, 2026-09-05.
 *
 * Dan: "everyone currently playing in the club or union get a pop up on
 * screen." The card used to be rendered by TablePage. MultiTablePage keeps up
 * to four of those mounted and hides the inactive ones with display:none, and
 * `shouldAnnounceBbjHit` marks a hit as seen for the FIRST subscriber that
 * asks - so when a hidden slot ran first, the card went into a display:none
 * subtree and every visible table was told "already announced". Nothing
 * appeared, exactly when the player had more than one table open.
 *
 * BBJHitAnnouncer is now the single owner, mounted once in PersistentTableLayer
 * beside the table container. These pins say: one subscriber, one card, the
 * gate still applies, the hitting table on screen is skipped, and the source
 * files still agree on who renders what.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const playBadBeatJackpot = vi.fn();
vi.mock('../src/services/SoundService', () => ({
  soundService: {
    isEnabled: () => true,
    playBadBeatJackpot: (...a: unknown[]) => playBadBeatJackpot(...a),
  },
}));

/* tests/setup.ts mocks the bus with a no-op subscribe. This test is ABOUT the
   subscription, so it gets a tiny real one: synchronous dispatch, subscribe
   returns an unsubscribe, nothing else. */
vi.mock('../src/core/MasterBus', () => {
  const subs = new Map<string, Set<(e: { type: string; payload: unknown }) => void>>();
  return {
    masterBus: {
      subscribe: (type: string, handler: (e: { type: string; payload: unknown }) => void) => {
        if (!subs.has(type)) subs.set(type, new Set());
        subs.get(type)!.add(handler);
        return () => subs.get(type)?.delete(handler);
      },
      subscribeDebounced: () => () => undefined,
      emit: (type: string, payload: unknown) => {
        subs.get(type)?.forEach((h) => h({ type, payload }));
      },
    },
  };
});

import { masterBus } from '../src/core/MasterBus';
import { __resetBbjSeenForTests } from '../src/lib/bbjHitOnce';
import BBJHitAnnouncer from '../src/components/bbj/BBJHitAnnouncer';

const HIT = {
  tableId: 'table-hit',
  tableName: 'NLH 1/2 Classic',
  gameVariant: 'nlh',
  bigBlind: 2,
  winnerName: 'RiverRat',
  amount: 13049.59,
  handNumber: 6237804,
  emittedAt: 0,
};

function mount(path = '/table/table-here') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BBJHitAnnouncer />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBbjSeenForTests();
});

describe('BBJHitAnnouncer', () => {
  it('draws the card once for a fresh hit at another table, and plays the fanfare', () => {
    mount();
    act(() => {
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: Date.now() });
    });
    expect(screen.getByText('RiverRat')).toBeTruthy();
    expect(screen.getByText(/NLH 1\/2 Classic/)).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(playBadBeatJackpot).toHaveBeenCalledTimes(1);
  });

  it('draws it once even when both producers deliver the same hit (socket + Realtime)', () => {
    mount();
    const stamp = Date.now();
    act(() => {
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: stamp });
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: stamp });
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(playBadBeatJackpot).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale replay (Dan 2026-08-28: no banners minutes, hours or days later)', () => {
    mount();
    act(() => {
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: Date.now() - 6 * 60 * 60 * 1000 });
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(playBadBeatJackpot).not.toHaveBeenCalled();
  });

  it('refuses an unstamped event - it cannot be proven live', () => {
    mount();
    act(() => {
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: undefined });
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('skips the table that is on screen - it plays its own ten-second celebration', () => {
    mount('/table/table-hit');
    act(() => {
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: Date.now() });
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('still announces off the table route (the cashier, the lobby) - the player is still playing', () => {
    mount('/club/some-club/cashier');
    act(() => {
      masterBus.emit('BBJ_HIT_GLOBAL', { ...HIT, emittedAt: Date.now() });
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

describe('who renders the card (source pins)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

  it('PersistentTableLayer mounts the announcer exactly once, outside the table ErrorBoundary', () => {
    const src = read('src/components/table/PersistentTableLayer.tsx');
    expect(src.match(/<BBJHitAnnouncer \/>/g)).toHaveLength(1);
    expect(src.indexOf('<BBJHitAnnouncer />')).toBeLessThan(src.indexOf('<ErrorBoundary'));
    // Lazy, not static: this layer is in the entry chunk every player
    // downloads before first paint, and the CI entry-chunk guard refuses a
    // static import of the card and its dependencies there.
    expect(src).toMatch(/lazyWithRetry\(\(\) => import\('\.\.\/bbj\/BBJHitAnnouncer'\)\)/);
    expect(src).not.toMatch(/^import BBJHitAnnouncer from/m);
  });

  it('TablePage no longer renders the card or consumes BBJ_HIT_GLOBAL - it only produces it', () => {
    const src = read('src/pages/TablePage.tsx');
    expect(src).not.toMatch(/<BBJHitNotification/);
    expect(src).not.toMatch(/useMasterBusSubscription\(\s*'BBJ_HIT_GLOBAL'/);
    /* BOTH PRODUCERS ARE STILL WIRED, and one of them MOVED (BBJ phase 3.1,
       2026-09-06). TablePage keeps the fast path - the engine's socket
       announcement, which reaches every live table in the club or union. The
       second producer used to be TablePage's own `bbj_pools` subscription,
       inferring a hit from `hit_count` going up; it is now the `bbj_winners`
       INSERT in lib/bbjHitFeed, which is one row per jackpot rather than
       40,219 row updates a day, and which the LOBBY can subscribe to as well.
       The count here was 3 because that old path emitted twice - once
       enriched, once as a fallback that set `tableId: ''` and was therefore
       dropped by this very component on its first line. */
    expect(src).toMatch(/eventType === 'bbj_hit_global'/);
    expect((src.match(/masterBus\.emit\('BBJ_HIT_GLOBAL'/g) || []).length).toBe(1);

    const feed = read('src/lib/bbjHitFeed.ts');
    expect(feed).toMatch(/table: 'bbj_winners'/);
    expect(feed).toMatch(/masterBus\.emit\('BBJ_HIT_GLOBAL'/);
  });

  it('the engine fans bbj_hit_global out to sibling cash tables after the payout lands', () => {
    const src = read('server/src/engine/ServerTableEngineSettlement.ts');
    const payoutAt = src.indexOf("type: 'bbj_payout_complete'");
    const fanoutAt = src.indexOf("type: 'bbj_hit_global'");
    expect(payoutAt).toBeGreaterThan(0);
    expect(fanoutAt).toBeGreaterThan(payoutAt);
    expect(src).toMatch(/liveCashTableIdsInClubs\(/);
    expect(src).toMatch(/resolveJackpotSiblingClubIds\(/);
  });

  it('the pop-up reads the amount to a screen reader, not the formatter', () => {
    const src = read('src/components/bbj/BBJHitNotification.tsx');
    expect(src).toMatch(
      /aria-label=\{`Bad Beat Jackpot Hit\. \$\{winnerName\} Won \$\{amountText\}/
    );
  });
});
