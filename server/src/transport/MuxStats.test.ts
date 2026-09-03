/**
 * /ws-metrics could not see the beta it was meant to measure.
 *
 * `ca_ws_mux` has been "off, pending a soak" for two sessions. The reason it
 * never got soaked is that nothing could tell you whether it was on: the
 * endpoint reported `totalSubscribers` and `activeConnections`, and neither
 * distinguishes a client holding four per-table sockets from one holding a
 * single mux socket with four subscriptions — which is the ONLY thing the beta
 * changes.
 *
 * muxStats() counts what the transport already tracks per connection. Counts
 * only: /ws-metrics is unauthenticated, so no user ids and no payloads.
 */
import { describe, it, expect } from 'vitest';
import { EngineWebSocketServer } from './EngineWebSocketServer.js';

type Conn = { isMux?: boolean; subs?: Map<string, unknown> };

/**
 * Drive the REAL method against a hand-built connection map, rather than
 * re-implementing the counting in the test. `connections` is private, so the
 * instance is reached through `unknown` — the alternative is widening
 * production visibility purely for a test.
 */
function stats(conns: Conn[]) {
  const server = Object.create(EngineWebSocketServer.prototype) as unknown as {
    connections: Map<object, Conn>;
    muxStats(): {
      muxSockets: number;
      singleSockets: number;
      muxSubscriptions: number;
      maxSubsOnOneSocket: number;
    };
  };
  server.connections = new Map(conns.map((c) => [{}, c]));
  return server.muxStats();
}

describe('muxStats', () => {
  it('reports zeroes on an idle transport', () => {
    expect(stats([])).toEqual({
      muxSockets: 0,
      singleSockets: 0,
      muxSubscriptions: 0,
      maxSubsOnOneSocket: 0,
    });
  });

  it('counts per-table sockets as single, not mux', () => {
    const s = stats([{}, {}, {}]);
    expect(s.singleSockets).toBe(3);
    expect(s.muxSockets).toBe(0);
    expect(s.muxSubscriptions).toBe(0);
  });

  it('separates the two populations during a staged rollout', () => {
    // The shape a soak actually produces: most users still per-table, a few on
    // the mux. Being able to see BOTH at once is the point.
    const s = stats([
      {},
      {},
      {
        isMux: true,
        subs: new Map([
          ['t1', 1],
          ['t2', 1],
        ]),
      },
      { isMux: true, subs: new Map([['t1', 1]]) },
    ]);
    expect(s).toEqual({
      muxSockets: 2,
      singleSockets: 2,
      muxSubscriptions: 3,
      maxSubsOnOneSocket: 2,
    });
  });

  it('shows the saving the beta exists to make: 4 tables on 1 socket', () => {
    const four = new Map([
      ['a', 1],
      ['b', 1],
      ['c', 1],
      ['d', 1],
    ]);
    const s = stats([{ isMux: true, subs: four }]);
    expect(s.muxSockets).toBe(1);
    expect(s.muxSubscriptions).toBe(4);
    expect(s.maxSubsOnOneSocket).toBe(4);
  });

  it('tolerates a mux socket that has not subscribed yet', () => {
    const s = stats([{ isMux: true }]);
    expect(s.muxSockets).toBe(1);
    expect(s.muxSubscriptions).toBe(0);
  });
});
