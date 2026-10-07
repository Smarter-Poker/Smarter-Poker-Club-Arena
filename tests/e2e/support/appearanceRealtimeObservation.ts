import type { Page } from '@playwright/test';

type PhoenixPayload = {
  status?: unknown;
  user_id?: unknown;
  event?: unknown;
  payload?: { user_id?: unknown };
  response?: {
    postgres_changes?: Array<{
      id?: unknown;
      event?: unknown;
      schema?: unknown;
      table?: unknown;
      filter?: unknown;
    }>;
  };
  ids?: unknown[];
  data?: { schema?: unknown; table?: unknown; type?: unknown; record?: Record<string, unknown> };
};

type PhoenixFrame = {
  ref: string | null;
  topic: string;
  event: string;
  payload: PhoenixPayload;
};

function decodeFrame(payload: string | Buffer): PhoenixFrame | null {
  try {
    const frame = JSON.parse(String(payload));
    const rawRef = Array.isArray(frame) ? frame[1] : frame.ref;
    return {
      ref: rawRef == null ? null : String(rawRef),
      topic: String(Array.isArray(frame) ? frame[2] : frame.topic || ''),
      event: String(Array.isArray(frame) ? frame[3] : frame.event || ''),
      payload: (Array.isArray(frame) ? frame[4] : frame.payload) || {},
    };
  } catch {
    return null;
  }
}

type TableArtField =
  | 'theme_id'
  | 'table_id'
  | 'button_id'
  | 'background_id'
  | 'cards_id'
  | 'face_deck_id';
export type ExpectedTableArtChange = {
  gameType: string;
  fields: Partial<Record<TableArtField, string>>;
};

export type AppearanceRealtimeObservationState = {
  subscribed: boolean;
  signalReceived: boolean;
  channelErrors: number;
  socketCloses: number;
  generation: number;
  ownRowChanges: number;
  expectedTableArtFields: Partial<Record<TableArtField, boolean>> | null;
  lastOwnRowMatchesExpected: boolean | null;
};

/**
 * Observe one owner's private appearance channel without letting a reply from
 * another request, an old document, or a closed socket satisfy readiness.
 */
export function createAppearanceRealtimeObservation(
  userId: string,
  carrier: 'profile' | 'table-art' = 'profile',
  expected?: ExpectedTableArtChange
) {
  const topic =
    carrier === 'profile'
      ? `realtime:profile-appearance:${userId}`
      : `realtime:user-theme-settings:${userId}`;
  const state: AppearanceRealtimeObservationState = {
    subscribed: false,
    signalReceived: false,
    channelErrors: 0,
    socketCloses: 0,
    generation: 0,
    ownRowChanges: 0,
    expectedTableArtFields:
      expected && carrier === 'table-art'
        ? Object.fromEntries(Object.keys(expected.fields).map((field) => [field, false]))
        : null,
    lastOwnRowMatchesExpected: null,
  };
  let nextSocketId = 0;
  const sockets = new Map<
    number,
    { generation: number; pendingJoinRefs: Set<string>; joined: boolean; bindingIds: Set<unknown> }
  >();

  const refreshReadiness = () => {
    state.subscribed = [...sockets.values()].some(
      (socket) => socket.generation === state.generation && socket.joined
    );
  };

  const resetForNavigation = () => {
    state.generation += 1;
    state.subscribed = false;
    state.signalReceived = false;
    state.ownRowChanges = 0;
    state.lastOwnRowMatchesExpected = null;
    if (state.expectedTableArtFields) {
      for (const field of Object.keys(state.expectedTableArtFields) as TableArtField[]) {
        state.expectedTableArtFields[field] = false;
      }
    }
    sockets.clear();
  };

  const openSocket = () => {
    const id = ++nextSocketId;
    const socketState = {
      generation: state.generation,
      pendingJoinRefs: new Set<string>(),
      joined: false,
      bindingIds: new Set<unknown>(),
    };
    sockets.set(id, socketState);

    const sent = (payload: string | Buffer) => {
      if (socketState.generation !== state.generation || !sockets.has(id)) return;
      const frame = decodeFrame(payload);
      if (frame?.topic === topic && frame.event === 'phx_join' && frame.ref) {
        socketState.pendingJoinRefs.add(frame.ref);
      }
    };

    const received = (payload: string | Buffer) => {
      if (socketState.generation !== state.generation || !sockets.has(id)) return;
      const frame = decodeFrame(payload);
      if (!frame || frame.topic !== topic) return;

      if (frame.event === 'phx_reply' && frame.ref && socketState.pendingJoinRefs.has(frame.ref)) {
        socketState.pendingJoinRefs.delete(frame.ref);
        const bindings = frame.payload.response?.postgres_changes;
        const binding = (Array.isArray(bindings) ? bindings : []).find(
          (value) =>
            value &&
            typeof value === 'object' &&
            value.event === '*' &&
            value.schema === 'public' &&
            value.table === 'user_theme_settings' &&
            value.filter === `user_id=eq.${userId}`
        );
        socketState.joined =
          frame.payload.status === 'ok' &&
          (carrier === 'profile' || typeof binding?.id === 'number');
        socketState.bindingIds.clear();
        if (socketState.joined && binding) socketState.bindingIds.add(binding.id);
        if (!socketState.joined) state.channelErrors += 1;
        refreshReadiness();
        return;
      }
      if (
        frame.event === 'phx_close' ||
        frame.event === 'phx_error' ||
        (frame.event === 'system' && frame.payload.status === 'error')
      ) {
        socketState.joined = false;
        if (frame.event === 'phx_error' || frame.event === 'system') state.channelErrors += 1;
        refreshReadiness();
        return;
      }
      if (
        carrier === 'table-art' &&
        socketState.joined &&
        frame.event === 'postgres_changes' &&
        Array.isArray(frame.payload.ids) &&
        frame.payload.ids.some((id) => socketState.bindingIds.has(id)) &&
        frame.payload.data?.schema === 'public' &&
        frame.payload.data.table === 'user_theme_settings' &&
        ['INSERT', 'UPDATE'].includes(String(frame.payload.data.type)) &&
        frame.payload.data.record?.user_id === userId
      ) {
        state.signalReceived = true;
        state.ownRowChanges = Math.min(1000, state.ownRowChanges + 1);
        if (expected && state.expectedTableArtFields) {
          const row = frame.payload.data.record;
          const entries = Object.entries(expected.fields) as [TableArtField, string][];
          const ownBucket = row.game_type === expected.gameType;
          state.lastOwnRowMatchesExpected =
            ownBucket &&
            entries.length > 0 &&
            entries.every(([field, value]) => row[field] === value);
          for (const [field, value] of entries) {
            if (ownBucket && row[field] === value) state.expectedTableArtFields[field] = true;
          }
        }
      }
      if (
        carrier === 'profile' &&
        socketState.joined &&
        frame.event === 'broadcast' &&
        frame.payload.event === 'appearance_changed' &&
        frame.payload.payload?.user_id === userId
      ) {
        state.signalReceived = true;
      }
    };

    const close = () => {
      if (!sockets.has(id)) return;
      sockets.delete(id);
      socketState.joined = false;
      socketState.bindingIds.clear();
      socketState.pendingJoinRefs.clear();
      if (socketState.generation !== state.generation) return;
      state.socketCloses += 1;
      refreshReadiness();
    };

    return { sent, received, close };
  };

  return { state, resetForNavigation, openSocket };
}

export function observeAppearanceRealtime(
  page: Page,
  userId: string,
  carrier: 'profile' | 'table-art' = 'profile',
  expected?: ExpectedTableArtChange
) {
  const observation = createAppearanceRealtimeObservation(userId, carrier, expected);
  // Reset when a real top-level document request begins, before that document
  // can open its socket. History API route changes keep the current transport.
  page.on('request', (request) => {
    if (!request.isNavigationRequest() || request.resourceType() !== 'document') return;
    // Playwright can expose a navigation request before its Frame exists.
    // Diagnostic observation must never replace the journey's original error.
    try {
      if (request.frame() === page.mainFrame()) observation.resetForNavigation();
    } catch {
      return;
    }
  });
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/realtime/v1/websocket')) return;
    const observedSocket = observation.openSocket();
    socket.on('framesent', ({ payload }) => observedSocket.sent(payload));
    socket.on('framereceived', ({ payload }) => observedSocket.received(payload));
    socket.on('close', observedSocket.close);
  });
  return observation.state;
}

/** Bounded failure evidence for the account's seven buckets, without row IDs. */
export function projectThemeBucketEvidence(rows: unknown, expectedFelt: string) {
  if (!Array.isArray(rows)) return null;
  const buckets = ['ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'];
  const ownRows = rows.filter((row) => row && typeof row === 'object');
  const all = ownRows.find((row) => row.game_type === 'ALL');
  const date = (value: unknown) =>
    typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const allAt = date(all?.updated_at);
  return {
    rowCount: Math.min(1000, ownRows.length),
    unrecognizedBuckets: Math.min(
      1000,
      ownRows.filter((row) => !buckets.includes(row.game_type)).length
    ),
    buckets: ownRows
      .filter((row) => buckets.includes(row.game_type))
      .slice(0, 7)
      .map((row) => {
        const at = date(row.updated_at);
        return {
          gameType: row.game_type as string,
          feltMatchesExpected: row.table_id === expectedFelt,
          updatedAfterAll: allAt !== null && at !== null ? at > allAt : null,
        };
      }),
  };
}
