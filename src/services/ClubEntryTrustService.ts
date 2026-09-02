import { supabase } from '../lib/supabase';

export type ClubEntryFlow = 'create' | 'find' | 'join' | 'action_bar';
export interface ClubEntryFlags {
  create_club: boolean;
  find_player: boolean;
  join_club: boolean;
}

const DEFAULT_FLAGS: ClubEntryFlags = {
  create_club: true,
  find_player: true,
  join_club: true,
};

function sessionId(): string {
  const key = 'club-arena:entry-session';
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export async function getClubEntryFlags(): Promise<ClubEntryFlags> {
  const { data, error } = await supabase.rpc('fn_get_club_entry_flags');
  if (error || !data || typeof data !== 'object') return DEFAULT_FLAGS;
  const flags = data as Record<string, unknown>;
  return {
    create_club: flags.create_club !== false,
    find_player: flags.find_player !== false,
    join_club: flags.join_club !== false,
  };
}

/** Fire-and-forget, privacy-filtered telemetry. Never blocks a user workflow. */
export function trackClubEntryEvent(
  flow: ClubEntryFlow,
  eventName: string,
  options: {
    outcome?: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'viewed';
    durationMs?: number;
    metadata?: Record<string, string | number | null>;
  } = {}
): void {
  void supabase
    .rpc('fn_track_club_entry_event', {
      p_session_id: sessionId(),
      p_flow: flow,
      p_event_name: eventName,
      p_outcome: options.outcome ?? null,
      p_duration_ms: options.durationMs ?? null,
      p_metadata: options.metadata ?? {},
    })
    .then(
      () => undefined,
      () => undefined
    );
}

export const ClubEntryTrustService = {
  getFlags: getClubEntryFlags,
  track: trackClubEntryEvent,
};
