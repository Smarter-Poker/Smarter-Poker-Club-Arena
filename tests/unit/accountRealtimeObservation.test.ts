import { describe, expect, it } from 'vitest';
import { createAccountRealtimeObservation } from '../e2e/support/accountRealtimeObservation';

describe('production account transport observation', () => {
  it('counts Presence references rather than confusing one device leaving with a player leaving', () => {
    const { state, frame } = createAccountRealtimeObservation('owner', 'union');
    const received = (event: string, payload: unknown) =>
      frame(JSON.stringify([null, null, 'realtime:union:union', event, payload]), false);
    received('presence_state', {
      owner: { metas: [{ phx_ref: 'desktop' }, { phx_ref: 'mobile' }] },
    });
    received('presence_diff', { leaves: { owner: { metas: [{ phx_ref: 'mobile' }] } } });
    expect([...state.peers.get('owner')!]).toEqual(['desktop']);
    received('presence_diff', { joins: { other: { metas: [{ phx_ref: 'other' }] } } });
    expect(state.peers.size).toBe(2);
    received('presence_diff', { leaves: { owner: { metas: [{ phx_ref: 'desktop' }] } } });
    expect([...state.peers.keys()]).toEqual(['other']);
  });

  it('separates SDK heartbeats, own subscription acceptance and actual Presence tracks', () => {
    const { state, frame } = createAccountRealtimeObservation('owner', 'union');
    const send = (topic: string, event: string, payload: unknown, sent = true) =>
      frame(JSON.stringify({ topic, event, payload }), sent);
    send('phoenix', 'heartbeat', {});
    send('realtime:union:union', 'presence', { event: 'track' });
    send('realtime:union:other-union', 'presence', { event: 'track' });
    for (const user of ['other', 'owner'])
      send(
        'realtime:global_db_sync:owner',
        'phx_reply',
        {
          status: 'ok',
          response: { postgres_changes: [{ table: 'club_members', filter: `user_id=eq.${user}` }] },
        },
        false
      );
    expect(state.heartbeats).toBe(1);
    expect(state.presenceTracks).toBe(1);
    expect(state.membershipSubscriptions).toBe(1);
  });
});
