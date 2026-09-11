import { describe, expect, it } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

const TABLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function subscriber(
  id: string,
  policy: Pick<HubSubscriber, 'userId' | 'viewerRole' | 'observerShowCards'>
): HubSubscriber & { outbox: string[] } {
  const outbox: string[] = [];
  return {
    id,
    ...policy,
    readyState: 1,
    outbox,
    send(data: string) {
      outbox.push(data);
    },
  };
}

function latest(sub: { outbox: string[] }): any {
  return JSON.parse(sub.outbox.at(-1)!);
}

function showdownState(pot = 100) {
  return {
    table_id: TABLE,
    stage: 'showdown',
    pot,
    community_cards: [{ rank: 'A', suit: 's' }],
    revealed_dead_cards: [{ rank: 'Q', suit: 'h' }],
    players: [
      { user_id: 'hero', cards: [{ rank: 'K', suit: 's' }] },
      { user_id: 'villain', cards: [{ rank: 'J', suit: 'd' }] },
    ],
  };
}

describe('TableStateHub viewer privacy', () => {
  it('fans one authoritative state into seated and restricted observer snapshots', () => {
    const hub = new TableStateHub();
    const seated = subscriber('seated', {
      userId: 'hero',
      viewerRole: 'seated',
      observerShowCards: false,
    });
    const observer = subscriber('observer', {
      userId: 'watcher',
      viewerRole: 'observer',
      observerShowCards: false,
    });
    hub.subscribe(TABLE, seated);
    hub.subscribe(TABLE, observer);

    hub.publish(TABLE, showdownState());

    expect(latest(seated).state.revealed_dead_cards).toEqual([{ rank: 'Q', suit: 'h' }]);
    expect(latest(seated).state.players.map((player: any) => player.cards)).toEqual([
      [{ rank: 'K', suit: 's' }],
      [{ rank: 'J', suit: 'd' }],
    ]);
    expect(latest(observer).state.revealed_dead_cards).toEqual([]);
    expect(latest(observer).state.players.map((player: any) => player.cards)).toEqual([[], []]);
    expect(observer.outbox[0]).not.toContain('"rank":"K"');
    expect(observer.outbox[0]).not.toContain('"rank":"Q"');
  });

  it('allows an explicit observer_show_cards=true observer and fails closed when metadata is incomplete', () => {
    const hub = new TableStateHub();
    const optedIn = subscriber('opted-in', {
      userId: 'watcher-1',
      viewerRole: 'observer',
      observerShowCards: true,
    });
    const missingPolicy = subscriber('missing-policy', {
      userId: 'watcher-2',
      viewerRole: 'observer',
    });
    const missingRole = subscriber('missing-role', {
      userId: 'watcher-3',
      observerShowCards: true,
    });
    hub.subscribe(TABLE, optedIn);
    hub.subscribe(TABLE, missingPolicy);
    hub.subscribe(TABLE, missingRole);

    hub.publish(TABLE, showdownState());

    expect(latest(optedIn).state.players[0].cards).toEqual([{ rank: 'K', suit: 's' }]);
    expect(latest(missingPolicy).state.players[0].cards).toEqual([]);
    expect(latest(missingPolicy).state.revealed_dead_cards).toEqual([]);
    expect(latest(missingRole).state.players[0].cards).toEqual([]);
    expect(latest(missingRole).state.revealed_dead_cards).toEqual([]);
  });

  it('builds observer deltas from observer baselines and advances seq on hidden-only changes', () => {
    const hub = new TableStateHub();
    const observer = subscriber('observer', {
      userId: 'watcher',
      viewerRole: 'observer',
      observerShowCards: false,
    });
    hub.subscribe(TABLE, observer);
    const first = showdownState();
    first.players[0].cards = [];
    first.revealed_dead_cards = [];
    hub.publish(TABLE, first);

    hub.publish(TABLE, showdownState());
    const hiddenOnly = latest(observer);
    expect(hiddenOnly).toMatchObject({ type: 'DELTA', seq: 2, prev: 1, patch: [] });
    expect(observer.outbox.at(-1)).not.toContain('"rank":"K"');
    expect(observer.outbox.at(-1)).not.toContain('"rank":"Q"');

    hub.publish(TABLE, showdownState(125));
    const publicChange = latest(observer);
    expect(publicChange).toMatchObject({ type: 'DELTA', seq: 3, prev: 2 });
    expect(publicChange.patch).toEqual([{ op: 'replace', path: '/pot', value: 125 }]);
  });

  it('reprojects late subscribe and RESYNC snapshots instead of replaying the shared state', () => {
    const hub = new TableStateHub();
    hub.publish(TABLE, showdownState());
    const observer = subscriber('observer', {
      userId: 'watcher',
      viewerRole: 'observer',
      observerShowCards: false,
    });

    hub.subscribe(TABLE, observer);
    expect(latest(observer).state.players[0].cards).toEqual([]);
    observer.outbox.length = 0;

    expect(hub.resync(TABLE, observer)).toBe(true);
    expect(latest(observer).type).toBe('SNAPSHOT');
    expect(latest(observer).state.players[0].cards).toEqual([]);
    expect(latest(observer).state.revealed_dead_cards).toEqual([]);
  });

  it('scrubs card-bearing shared events for restricted live and replay subscribers', () => {
    const hub = new TableStateHub();
    const observer = subscriber('observer', {
      userId: 'watcher',
      viewerRole: 'observer',
      observerShowCards: false,
    });
    hub.subscribe(TABLE, observer);
    hub.emitEvent(TABLE, {
      type: 'showdown_cards_revealed',
      replay_until: Date.now() + 30_000,
      reveals: [{ user_id: 'hero', cards: [{ rank: 'K', suit: 's' }] }],
    });
    expect(latest(observer).payload.reveals[0].cards).toEqual([]);
    expect(observer.outbox.at(-1)).not.toContain('"rank":"K"');

    const late = subscriber('late', {
      userId: 'late-watcher',
      viewerRole: 'observer',
      observerShowCards: false,
    });
    hub.subscribe(TABLE, late);
    expect(latest(late).payload.replayed).toBe(true);
    expect(latest(late).payload.reveals[0].cards).toEqual([]);

    hub.emitEvent(TABLE, {
      type: 'insurance_offers',
      offers: [
        {
          playerId: 'hero',
          holeCards: [{ rank: 'K', suit: 's' }],
          opponents: [{ playerId: 'villain', holeCards: [{ rank: 'J', suit: 'd' }] }],
        },
      ],
    });
    const insurance = latest(observer);
    expect(insurance.payload.offers[0].holeCards).toEqual([]);
    expect(insurance.payload.offers[0].opponents[0].holeCards).toEqual([]);
  });

  it('never elevates a DB-authorized observer from an engine snapshot roster', () => {
    const hub = new TableStateHub();
    const viewer = subscriber('viewer', {
      // The engine may still carry this user through the hand after their
      // durable seat row was closed. Roster presence is not authorization.
      userId: 'hero',
      viewerRole: 'observer',
      observerShowCards: false,
    });
    hub.subscribe(TABLE, viewer);
    hub.publish(TABLE, showdownState());
    expect(latest(viewer).state.players[0].cards).toEqual([]);
    expect(viewer.viewerRole).toBe('observer');
    expect(latest(viewer).state.revealed_dead_cards).toEqual([]);
  });
});
