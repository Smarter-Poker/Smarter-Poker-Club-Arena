import type { Page } from '@playwright/test';

/** Keep only certification counters and Presence references, never auth frames. */
export function createAccountRealtimeObservation(userId: string, unionId: string) {
  const peers = new Map<string, Set<string>>();
  const state = {
    presenceTracks: 0,
    presenceLeaves: 0,
    presenceJoins: 0,
    heartbeats: 0,
    membershipSubscriptions: 0,
    balanceReads: 0,
    membershipReads: 0,
    socketCloses: 0,
    peers,
  };
  const merge = (rows: Record<string, { metas?: Array<{ phx_ref?: string }> }>, remove = false) => {
    for (const [key, value] of Object.entries(rows)) {
      const refs = peers.get(key) || new Set<string>();
      for (const meta of value.metas || []) {
        if (typeof meta.phx_ref !== 'string') continue;
        if (remove) refs.delete(meta.phx_ref);
        else refs.add(meta.phx_ref);
      }
      if (refs.size) peers.set(key, refs);
      else peers.delete(key);
    }
  };
  const frame = (payload: string | Buffer, sent: boolean) => {
    try {
      const parsed = JSON.parse(String(payload));
      const topic = Array.isArray(parsed) ? parsed[2] : parsed.topic;
      const event = Array.isArray(parsed) ? parsed[3] : parsed.event;
      const body = Array.isArray(parsed) ? parsed[4] : parsed.payload;
      if (sent && topic === 'phoenix' && event === 'heartbeat') state.heartbeats++;
      if (
        !sent &&
        topic === `realtime:global_db_sync:${userId}` &&
        event === 'phx_reply' &&
        body?.status === 'ok' &&
        body.response?.postgres_changes?.some(
          (binding: { table?: string; filter?: string }) =>
            binding.table === 'club_members' && binding.filter === `user_id=eq.${userId}`
        )
      )
        state.membershipSubscriptions++;
      if (topic !== `realtime:union:${unionId}`) return;
      if (sent && event === 'presence' && body?.event === 'track') state.presenceTracks++;
      if (sent && event === 'phx_leave') state.presenceLeaves++;
      if (sent && event === 'phx_join') state.presenceJoins++;
      if (!sent && event === 'presence_state' && body) {
        peers.clear();
        merge(body);
      }
      if (!sent && event === 'presence_diff' && body) {
        // A player can have multiple devices. Leaving one reference must not
        // remove the remaining device from the expected rendered count.
        merge(body.leaves || {}, true);
        merge(body.joins || {});
      }
    } catch {
      // Non-JSON transport payloads are outside this observation.
    }
  };
  return { state, frame };
}

export function observeAccountRealtime(page: Page, userId: string, unionId: string) {
  const observation = createAccountRealtimeObservation(userId, unionId);
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/realtime/v1/websocket')) return;
    socket.on('framesent', ({ payload }) => observation.frame(payload, true));
    socket.on('framereceived', ({ payload }) => observation.frame(payload, false));
    socket.on('close', () => observation.state.socketCloses++);
  });
  page.on('response', (response) => {
    if (!response.ok()) return;
    const url = new URL(response.url());
    if (url.pathname.endsWith('/rest/v1/rpc/fn_player_spendable_balance')) {
      observation.state.balanceReads++;
    }
    if (
      response.request().method() === 'GET' &&
      url.pathname.endsWith('/rest/v1/club_members') &&
      url.searchParams.get('user_id') === `eq.${userId}` &&
      url.searchParams.get('select')?.includes('chip_balance')
    )
      observation.state.membershipReads++;
  });
  return observation.state;
}
