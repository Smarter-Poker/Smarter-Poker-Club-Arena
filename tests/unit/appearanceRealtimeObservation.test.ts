import { describe, expect, it } from 'vitest';
import { createAppearanceRealtimeObservation } from '../e2e/support/appearanceRealtimeObservation';

const USER_ID = 'player-a';
const TOPIC = `realtime:profile-appearance:${USER_ID}`;

describe('appearance realtime observation', () => {
  it('accepts only the successful reply to this socket generation join', () => {
    const observation = createAppearanceRealtimeObservation(USER_ID);
    const socket = observation.openSocket();

    socket.sent(JSON.stringify([null, 'join-1', TOPIC, 'phx_join', {}]));
    socket.received(JSON.stringify(['join-1', 'other', TOPIC, 'phx_reply', { status: 'ok' }]));
    expect(observation.state.subscribed).toBe(false);

    socket.received(JSON.stringify(['join-1', 'join-1', TOPIC, 'phx_reply', { status: 'ok' }]));
    expect(observation.state.subscribed).toBe(true);

    socket.received(
      JSON.stringify([
        null,
        null,
        TOPIC,
        'broadcast',
        {
          event: 'appearance_changed',
          payload: { user_id: USER_ID },
        },
      ])
    );
    expect(observation.state.signalReceived).toBe(true);
  });

  it('rejects non-join replies and stale sockets after a document navigation', () => {
    const observation = createAppearanceRealtimeObservation(USER_ID);
    const staleSocket = observation.openSocket();

    staleSocket.sent(JSON.stringify({ ref: 'token-1', topic: TOPIC, event: 'access_token' }));
    staleSocket.received(
      JSON.stringify({
        ref: 'token-1',
        topic: TOPIC,
        event: 'phx_reply',
        payload: { status: 'ok' },
      })
    );
    expect(observation.state.subscribed).toBe(false);

    staleSocket.sent(
      JSON.stringify({ ref: 'join-old', topic: TOPIC, event: 'phx_join', payload: {} })
    );
    observation.resetForNavigation();
    staleSocket.received(
      JSON.stringify({
        ref: 'join-old',
        topic: TOPIC,
        event: 'phx_reply',
        payload: { status: 'ok' },
      })
    );
    expect(observation.state.subscribed).toBe(false);

    const currentSocket = observation.openSocket();
    currentSocket.sent(
      JSON.stringify({ ref: 'join-new', topic: TOPIC, event: 'phx_join', payload: {} })
    );
    currentSocket.received(
      JSON.stringify({
        ref: 'join-new',
        topic: TOPIC,
        event: 'phx_reply',
        payload: { status: 'ok' },
      })
    );
    expect(observation.state.subscribed).toBe(true);

    currentSocket.close();
    expect(observation.state.subscribed).toBe(false);
    expect(observation.state.socketCloses).toBe(1);
  });
});
