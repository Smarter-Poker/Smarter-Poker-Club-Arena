import { describe, expect, it } from 'vitest';
import {
  createAppearanceRealtimeObservation,
  observeAppearanceRealtime,
  projectThemeBucketEvidence,
} from '../e2e/support/appearanceRealtimeObservation';

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

describe('table-art expected-field delivery evidence', () => {
  const userId = 'owned-synthetic-player';
  const topic = `realtime:user-theme-settings:${userId}`;
  const expected = { gameType: 'ALL', fields: { table_id: 'carbon_red' } } as const;
  const join = (
    socket: ReturnType<ReturnType<typeof createAppearanceRealtimeObservation>['openSocket']>
  ) => {
    socket.sent(JSON.stringify([null, 'own-join', topic, 'phx_join', {}]));
    socket.received(
      JSON.stringify([
        null,
        'own-join',
        topic,
        'phx_reply',
        {
          status: 'ok',
          response: {
            postgres_changes: [
              {
                id: 42,
                event: '*',
                schema: 'public',
                table: 'user_theme_settings',
                filter: `user_id=eq.${userId}`,
              },
            ],
          },
        },
      ])
    );
  };
  const row = (record: Record<string, unknown>, id = 42) =>
    JSON.stringify([
      null,
      null,
      topic,
      'postgres_changes',
      {
        ids: [id],
        data: { schema: 'public', table: 'user_theme_settings', type: 'UPDATE', record },
      },
    ]);

  it('does not count a subscription acknowledgement as a changed own field', () => {
    const observation = createAppearanceRealtimeObservation(userId, 'table-art', expected);
    join(observation.openSocket());
    expect(observation.state.subscribed).toBe(true);
    expect(observation.state.ownRowChanges).toBe(0);
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: false });
  });

  it('distinguishes own delivered expected fields from foreign, unbound and other-bucket rows', () => {
    const observation = createAppearanceRealtimeObservation(userId, 'table-art', expected);
    const socket = observation.openSocket();
    join(socket);
    socket.received(row({ user_id: 'foreign', game_type: 'ALL', table_id: 'carbon_red' }));
    socket.received(row({ user_id: userId, game_type: 'ALL', table_id: 'carbon_red' }, 7));
    socket.received(row({ user_id: userId, game_type: 'NLH', table_id: 'carbon_red' }));
    expect(observation.state.ownRowChanges).toBe(1);
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: false });
    socket.received(
      row({
        user_id: userId,
        game_type: 'ALL',
        table_id: 'carbon_red',
        authorization: 'never-retain-secret',
      })
    );
    expect(observation.state.ownRowChanges).toBe(2);
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: true });
    expect(observation.state.lastOwnRowMatchesExpected).toBe(true);
    socket.received(row({ user_id: userId, game_type: 'ALL', table_id: 'classic_green' }));
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: true });
    expect(observation.state.lastOwnRowMatchesExpected).toBe(false);
    const safe = JSON.stringify(observation.state);
    expect(safe).not.toContain(userId);
    expect(safe).not.toContain('never-retain-secret');
    expect(safe).not.toContain('carbon_red');
  });

  it('records an exact scoped system error without retaining its message or faking delivery', () => {
    const observation = createAppearanceRealtimeObservation(userId, 'table-art', expected);
    const socket = observation.openSocket();
    join(socket);
    socket.received(
      JSON.stringify([
        null,
        null,
        topic,
        'system',
        { status: 'error', message: 'never-retain-private-details' },
      ])
    );
    expect(observation.state.subscribed).toBe(false);
    expect(observation.state.channelErrors).toBe(1);
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: false });
    expect(JSON.stringify(observation.state)).not.toContain('never-retain-private-details');
  });

  it('cannot use an already-closed socket to claim delivery of the expected row', () => {
    const observation = createAppearanceRealtimeObservation(userId, 'table-art', expected);
    const socket = observation.openSocket();
    join(socket);
    socket.close();
    socket.received(row({ user_id: userId, game_type: 'ALL', table_id: 'carbon_red' }));
    expect(observation.state.subscribed).toBe(false);
    expect(observation.state.ownRowChanges).toBe(0);
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: false });
  });

  it('forgets delivery across a document generation and ignores its old socket', () => {
    const observation = createAppearanceRealtimeObservation(userId, 'table-art', expected);
    const socket = observation.openSocket();
    join(socket);
    socket.received(row({ user_id: userId, game_type: 'ALL', table_id: 'carbon_red' }));
    observation.resetForNavigation();
    socket.received(row({ user_id: userId, game_type: 'ALL', table_id: 'carbon_red' }));
    expect(observation.state.ownRowChanges).toBe(0);
    expect(observation.state.expectedTableArtFields).toEqual({ table_id: false });
    expect(observation.state.lastOwnRowMatchesExpected).toBeNull();
  });
});

it('never replaces an original navigation failure when its Frame is not available', () => {
  const callbacks = new Map<string, (value: any) => void>();
  const page = {
    on: (name: string, callback: (value: any) => void) => callbacks.set(name, callback),
    mainFrame: () => ({}),
  };
  const state = observeAppearanceRealtime(page as any, USER_ID, 'table-art');
  expect(() =>
    callbacks.get('request')!({
      isNavigationRequest: () => true,
      resourceType: () => 'document',
      frame: () => {
        throw new Error('Frame Not Created');
      },
    })
  ).not.toThrow();
  expect(state.generation).toBe(0);
});

it('exposes bounded bucket precedence facts without retaining actor IDs or arbitrary values', () => {
  const rows = [
    {
      game_type: 'ALL',
      table_id: 'carbon_red',
      updated_at: '2026-10-07T12:40:00Z',
      user_id: 'private-actor',
    },
    { game_type: 'NLH', table_id: 'classic_green', updated_at: '2026-10-07T12:41:00Z' },
    { game_type: 'PLO', table_id: 'private-unknown-value', updated_at: 'bad' },
    { game_type: 'private-unknown-bucket', table_id: 'private-unknown-value' },
  ];
  const evidence = projectThemeBucketEvidence(rows, 'carbon_red');
  expect(evidence).toEqual({
    rowCount: 4,
    unrecognizedBuckets: 1,
    buckets: [
      { gameType: 'ALL', feltMatchesExpected: true, updatedAfterAll: false },
      { gameType: 'NLH', feltMatchesExpected: false, updatedAfterAll: true },
      { gameType: 'PLO', feltMatchesExpected: false, updatedAfterAll: null },
    ],
  });
  expect(JSON.stringify(evidence)).not.toContain('private-');
  expect(projectThemeBucketEvidence(null, 'carbon_red')).toBeNull();
  expect(
    projectThemeBucketEvidence(
      Array.from({ length: 20 }, () => rows[0]),
      'carbon_red'
    )?.buckets
  ).toHaveLength(7);
});
