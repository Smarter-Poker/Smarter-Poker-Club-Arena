import type { Page } from '@playwright/test';

type PhoenixPayload = {
  status?: unknown;
  user_id?: unknown;
  event?: unknown;
  payload?: { user_id?: unknown };
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

export type AppearanceRealtimeObservationState = {
  subscribed: boolean;
  signalReceived: boolean;
  channelErrors: number;
  socketCloses: number;
  generation: number;
};

/**
 * Observe one owner's private appearance channel without letting a reply from
 * another request, an old document, or a closed socket satisfy readiness.
 */
export function createAppearanceRealtimeObservation(userId: string) {
  const topic = `realtime:profile-appearance:${userId}`;
  const state: AppearanceRealtimeObservationState = {
    subscribed: false,
    signalReceived: false,
    channelErrors: 0,
    socketCloses: 0,
    generation: 0,
  };
  let nextSocketId = 0;
  const sockets = new Map<
    number,
    { generation: number; pendingJoinRefs: Set<string>; joined: boolean }
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
    sockets.clear();
  };

  const openSocket = () => {
    const id = ++nextSocketId;
    const socketState = {
      generation: state.generation,
      pendingJoinRefs: new Set<string>(),
      joined: false,
    };
    sockets.set(id, socketState);

    const sent = (payload: string | Buffer) => {
      if (socketState.generation !== state.generation) return;
      const frame = decodeFrame(payload);
      if (frame?.topic === topic && frame.event === 'phx_join' && frame.ref) {
        socketState.pendingJoinRefs.add(frame.ref);
      }
    };

    const received = (payload: string | Buffer) => {
      if (socketState.generation !== state.generation) return;
      const frame = decodeFrame(payload);
      if (!frame || frame.topic !== topic) return;

      if (frame.event === 'phx_reply' && frame.ref && socketState.pendingJoinRefs.has(frame.ref)) {
        socketState.pendingJoinRefs.delete(frame.ref);
        socketState.joined = frame.payload.status === 'ok';
        if (!socketState.joined) state.channelErrors += 1;
        refreshReadiness();
        return;
      }
      if (frame.event === 'phx_close' || frame.event === 'phx_error') {
        socketState.joined = false;
        if (frame.event === 'phx_error') state.channelErrors += 1;
        refreshReadiness();
        return;
      }
      if (
        socketState.joined &&
        frame.event === 'broadcast' &&
        frame.payload.event === 'appearance_changed' &&
        frame.payload.payload?.user_id === userId
      ) {
        state.signalReceived = true;
      }
    };

    const close = () => {
      sockets.delete(id);
      if (socketState.generation !== state.generation) return;
      state.socketCloses += 1;
      refreshReadiness();
    };

    return { sent, received, close };
  };

  return { state, resetForNavigation, openSocket };
}

export function observeAppearanceRealtime(page: Page, userId: string) {
  const observation = createAppearanceRealtimeObservation(userId);
  // Reset when a real top-level document request begins, before that document
  // can open its socket. History API route changes keep the current transport.
  page.on('request', (request) => {
    if (
      request.isNavigationRequest() &&
      request.resourceType() === 'document' &&
      request.frame() === page.mainFrame()
    ) {
      observation.resetForNavigation();
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
