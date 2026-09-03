/**
 * D3 — THE REVEAL MUST SURVIVE A RECONNECT.
 *
 * Defect (2026-08-25): `emitEvent` began with `const room = this.rooms.get(
 * tableId); if (!room) return;` and nothing retained the message. An EVENT was
 * a single un-replayed packet, and `resync` re-sent only the SNAPSHOT — which
 * carries no multiplier. Any client mid-reconnect at the instant
 * TournamentManagerBase.start() emitted `spin_reveal` lost the wheel forever.
 *
 * These tests pin the retention: bounded, self-expiring, opt-in per event, and
 * never a snapshot field (Law 1.16 — a snapshot must never trigger animation).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

function makeSub(id: string, readyState = 1 /* OPEN */) {
  const outbox: string[] = [];
  const sub: HubSubscriber & {
    outbox: string[];
    close(): void;
    _readyState: number;
    _bufferedAmount: number;
  } = {
    id,
    outbox,
    _readyState: readyState,
    _bufferedAmount: 0,
    get readyState() {
      return this._readyState;
    },
    get bufferedAmount() {
      return this._bufferedAmount;
    },
    send(data: string) {
      outbox.push(data);
    },
    close() {
      this._readyState = 3; // CLOSED
    },
  } as any;
  return sub;
}

const parsed = (sub: { outbox: string[] }) => sub.outbox.map((m) => JSON.parse(m));
const events = (sub: { outbox: string[] }) => parsed(sub).filter((m) => m.type === 'EVENT');

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** What TournamentManagerBase.start() emits, in miniature. */
function reveal(replayUntil: number) {
  return {
    type: 'spin_reveal',
    table_id: TABLE,
    tournament_id: 'tttttttt',
    multiplier: 25,
    reveal_at: Date.now(),
    replay_until: replayUntil,
  };
}

describe('TableStateHub reveal retention (D3)', () => {
  let hub: TableStateHub;

  beforeEach(() => {
    hub = new TableStateHub();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays the reveal to a client that subscribes after it was emitted', () => {
    // Nobody is listening at the moment of the reveal — the exact case the old
    // `if (!room) return` threw away.
    hub.emitEvent(TABLE, reveal(Date.now() + 15_000));

    const late = makeSub('late');
    hub.subscribe(TABLE, late);

    const got = events(late);
    expect(got).toHaveLength(1);
    expect(got[0].payload.type).toBe('spin_reveal');
    expect(got[0].payload.multiplier).toBe(25);
    // Tagged, so the client can tell a catch-up from a live beat.
    expect(got[0].payload.replayed).toBe(true);
  });

  it('replays the reveal on RESYNC, which used to return state and nothing else', () => {
    const sub = makeSub('gapped');
    hub.publish(TABLE, { pot: 0 }); // room + snapshot exist
    hub.emitEvent(TABLE, reveal(Date.now() + 15_000)); // sub is not subscribed yet

    hub.subscribe(TABLE, sub);
    sub.outbox.length = 0; // ignore the subscribe-time snapshot and replay

    const other = makeSub('other');
    hub.resync(TABLE, other);
    const got = events(other);
    expect(got).toHaveLength(1);
    expect(got[0].payload.type).toBe('spin_reveal');
    // The snapshot is unchanged — the multiplier is NOT smuggled into state.
    const snap = parsed(other).find((m) => m.type === 'SNAPSHOT');
    expect(snap.state).toEqual({ pot: 0 });
    expect(JSON.stringify(snap.state)).not.toContain('multiplier');
  });

  it('never hands the same subscriber the reveal twice', () => {
    const sub = makeSub('live');
    hub.subscribe(TABLE, sub);
    hub.emitEvent(TABLE, reveal(Date.now() + 15_000)); // received live
    expect(events(sub)).toHaveLength(1);

    hub.resync(TABLE, sub); // a resync must not restart the wheel
    expect(events(sub)).toHaveLength(1);
  });

  it('replays to a subscriber that was soft-dropped for backpressure', () => {
    const slow = makeSub('slow');
    hub.subscribe(TABLE, slow);
    slow._bufferedAmount = 512 * 1024; // past SOFT, under HARD
    hub.emitEvent(TABLE, reveal(Date.now() + 15_000));
    expect(events(slow)).toHaveLength(0); // dropped, as designed

    slow._bufferedAmount = 0;
    hub.resync(TABLE, slow);
    expect(events(slow)).toHaveLength(1);
  });

  it('stops replaying once the event passes its own deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00Z'));
    hub.emitEvent(TABLE, reveal(Date.now() + 15_000));

    vi.setSystemTime(new Date('2026-08-25T00:00:14Z'));
    const inTime = makeSub('in-time');
    hub.subscribe(TABLE, inTime);
    expect(events(inTime)).toHaveLength(1);

    vi.setSystemTime(new Date('2026-08-25T00:00:16Z'));
    const tooLate = makeSub('too-late');
    hub.subscribe(TABLE, tooLate);
    expect(events(tooLate)).toHaveLength(0);
    expect(hub.replayStats().retainedTables).toBe(0);
  });

  it('retains nothing for an ordinary event that did not ask for it', () => {
    hub.emitEvent(TABLE, { type: 'time_bank_timeout', seat: 3 });
    expect(hub.replayStats().retainedTables).toBe(0);

    const late = makeSub('late');
    hub.subscribe(TABLE, late);
    expect(events(late)).toHaveLength(0);
  });

  it('caps how far into the future an emitter can pin an event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00Z'));
    // An hour is not a reveal window. The hub grants its own ceiling instead.
    hub.emitEvent(TABLE, reveal(Date.now() + 60 * 60 * 1000));

    vi.setSystemTime(new Date('2026-08-25T00:00:59Z'));
    expect(hub.replayStats().retainedTables).toBe(1);
    vi.setSystemTime(new Date('2026-08-25T00:01:01Z'));
    expect(hub.replayStats().retainedTables).toBe(0);
  });

  it('keeps at most a handful of events per table, newest wins', () => {
    const until = Date.now() + 15_000;
    for (let i = 1; i <= 9; i++) {
      hub.emitEvent(TABLE, { type: 'spin_beat', beat: i, replay_until: until });
    }
    const late = makeSub('late');
    hub.subscribe(TABLE, late);
    const got = events(late);
    expect(got).toHaveLength(4);
    expect(got.map((m) => m.payload.beat)).toEqual([6, 7, 8, 9]);
  });

  it('replays the sequence in emission order', () => {
    const until = Date.now() + 15_000;
    hub.emitEvent(TABLE, reveal(until));
    hub.emitEvent(TABLE, { type: 'spin_chips', starting_stack: 500, replay_until: until });
    hub.emitEvent(TABLE, { type: 'spin_button', dealer_seat: 2, replay_until: until });

    const late = makeSub('late');
    hub.subscribe(TABLE, late);
    expect(events(late).map((m) => m.payload.type)).toEqual([
      'spin_reveal',
      'spin_chips',
      'spin_button',
    ]);
  });

  it('does not change what a live subscriber receives', () => {
    const sub = makeSub('live');
    hub.subscribe(TABLE, sub);
    hub.emitEvent(TABLE, reveal(Date.now() + 15_000));
    const got = events(sub);
    expect(got).toHaveLength(1);
    // Live delivery is NOT tagged as a replay.
    expect(got[0].payload.replayed).toBeUndefined();
  });
});
