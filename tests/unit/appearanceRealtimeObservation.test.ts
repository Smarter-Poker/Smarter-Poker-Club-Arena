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

describe('table-art realtime observation', () => {
  const topic = `realtime:user-theme-settings:${USER_ID}`;
  const binding = {
    id: 42,
    event: '*',
    schema: 'public',
    table: 'user_theme_settings',
    filter: `user_id=eq.${USER_ID}`,
  };
  const reply = (value: unknown) =>
    JSON.stringify([
      null,
      'join-1',
      topic,
      'phx_reply',
      { status: 'ok', response: { postgres_changes: [value] } },
    ]);
  const change = (id: number, owner = USER_ID) =>
    JSON.stringify([
      null,
      null,
      topic,
      'postgres_changes',
      {
        ids: [id],
        data: {
          schema: 'public',
          table: 'user_theme_settings',
          type: 'UPDATE',
          record: { user_id: owner, cards_id: 'classic_blue' },
        },
      },
    ]);

  it('does not mistake a profile broadcast or unbound join for table-art delivery', () => {
    const observation = createAppearanceRealtimeObservation(USER_ID, 'table-art');
    const socket = observation.openSocket();
    socket.sent(
      JSON.stringify([null, 'join-1', topic, 'phx_join', { access_token: 'never-retain-this' }])
    );
    socket.received(reply({ ...binding, filter: 'user_id=eq.other' }));
    socket.received(change(42));
    expect(observation.state.subscribed).toBe(false);
    expect(observation.state.signalReceived).toBe(false);
    expect(observation.state.channelErrors).toBe(1);
    expect(JSON.stringify(observation.state)).not.toContain('never-retain-this');
  });

  it('refuses malformed bindings without interrupting the journey observer', () => {
    const observation = createAppearanceRealtimeObservation(USER_ID, 'table-art');
    const socket = observation.openSocket();
    socket.sent(JSON.stringify([null, 'join-1', topic, 'phx_join', {}]));
    expect(() => socket.received(reply(null))).not.toThrow();
    expect(observation.state.subscribed).toBe(false);
  });

  it('requires a correlated own-table binding and its own row event', () => {
    const observation = createAppearanceRealtimeObservation(USER_ID, 'table-art');
    const socket = observation.openSocket();
    socket.sent(JSON.stringify([null, 'join-1', topic, 'phx_join', {}]));
    socket.received(reply(binding));
    expect(observation.state.subscribed).toBe(true);
    socket.received(change(7));
    socket.received(change(42, 'other-player'));
    socket.received(
      JSON.stringify([
        null,
        null,
        TOPIC,
        'broadcast',
        { event: 'appearance_changed', payload: { user_id: USER_ID } },
      ])
    );
    expect(observation.state.signalReceived).toBe(false);
    socket.received(change(42));
    expect(observation.state.signalReceived).toBe(true);
    observation.resetForNavigation();
    socket.received(reply(binding));
    socket.received(change(42));
    expect(observation.state.subscribed).toBe(false);
    expect(observation.state.signalReceived).toBe(false);
  });
});
