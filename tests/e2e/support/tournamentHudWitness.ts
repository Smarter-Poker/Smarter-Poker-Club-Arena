import { createClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import { remainingObservationMs } from './observationDeadline';

type Row = Record<string, unknown>;
export type HudClock = {
  tournamentId: string;
  levelIndex: number;
  intervalMs: number;
  remainingMs: number;
  nextIntervalMs: number;
  requiredObservationMs: number;
  observedAt: number;
};
export type HudLevel = { tournamentId: string; levelIndex: number; at: number };

/** Qualification only: unknown, paused, terminal and long clocks are not witnesses. */
export function eligibleHudClock(row: Row, now: number, budgetMs: number): HudClock | null {
  if (row.status !== 'RUNNING' || row.on_break === true || row.accelerated_mtt === true)
    return null;
  if (
    !Number.isSafeInteger(row.current_players) ||
    Number(row.current_players) < 4 ||
    !row.started_at
  )
    return null;
  if (row.addon_period_started_at && Date.parse(String(row.addon_period_ends_at)) > now)
    return null;
  const levelIndex = row.current_level;
  if (typeof levelIndex !== 'number' || !Number.isSafeInteger(levelIndex) || levelIndex < 0)
    return null;
  let levels: unknown = row.blind_structure;
  if (typeof levels === 'string') {
    try {
      levels = JSON.parse(levels);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(levels) || !levels.length) return null;
  // Called only AFTER the mandatory hand/offline/rejoin proof. Both observers
  // remain online from this baseline, so one future named level_up is needed.
  // Refuse an upcoming break; it is not the same event as a blind level.
  const schedule = levels;
  const at = (offset: number) => schedule[Math.min(levelIndex + offset, schedule.length - 1)];
  const level = at(0);
  const next = at(1);
  if (!level || !next || level.isBreak || next.isBreak) return null;
  const durationMs = (entry: Row) => {
    const minutes = Number(entry.durationMinutes ?? entry.duration_minutes);
    return (minutes > 0 ? minutes * 60 : Number(entry.duration)) * 1000;
  };
  const intervalMs = durationMs(level);
  const nextIntervalMs = durationMs(next);
  const startedAt = Date.parse(String(row.level_started_at));
  const remainingMs = startedAt + intervalMs - now;
  // Keep the original 60s reserve: 15s for event delivery, 15s for both
  // rendered assertions and 30s for final health/evidence/cleanup. The outage
  // and peer setup have already consumed the case's ONE fixed deadline.
  const requiredObservationMs = remainingMs + 60_000;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(nextIntervalMs) ||
    nextIntervalMs <= 32_000 ||
    !Number.isFinite(budgetMs) ||
    requiredObservationMs > budgetMs ||
    !Number.isFinite(startedAt) ||
    startedAt > now ||
    remainingMs <= 20_000
  )
    return null;
  if (typeof row.id !== 'string') return null;
  return {
    tournamentId: row.id,
    levelIndex,
    intervalMs,
    remainingMs,
    nextIntervalMs,
    requiredObservationMs,
    observedAt: now,
  };
}

/** Clock reads and rendered setup never restart the case or event budget. */
export function hudEventObservationMs(clock: HudClock, deadline: number, now = Date.now()): number {
  const eventDeadline = clock.observedAt + clock.remainingMs + 15_000;
  const budget = Math.min(eventDeadline - now, remainingObservationMs(deadline, now) - 45_000);
  if (!Number.isFinite(budget) || budget <= 0)
    throw new Error('The recovered HUD has no reserved time for its natural level event');
  return budget;
}

/** A separate LOCAL session of the existing reserved fixture, never a service/owner read. */
export async function createHudClockReader() {
  const email = process.env.SP_EMAIL || '';
  if (!email.startsWith('ca-customization-cert-postdeploy-') || !email.endsWith('@example.invalid'))
    throw new Error('HUD witness requires the existing reserved postdeploy account');
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !process.env.SP_PASS) throw new Error('HUD witness auth is not configured');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: process.env.SP_PASS,
  });
  if (error || data.user?.email !== email) {
    if (data.session) await client.auth.signOut({ scope: 'local' });
    throw new Error('HUD reserved account authentication failed');
  }
  const qualifications: Array<{
    tableId: string;
    clock: HudClock | null;
    row: Row | null;
    budgetMs: number;
  }> = [];
  return {
    qualifications,
    async clocks(tableIds: string[], deadline: number): Promise<Map<string, HudClock>> {
      const tables = await client.from('tables').select('id,tournament_id').in('id', tableIds);
      if (tables.error) throw tables.error;
      const ids = [...new Set((tables.data || []).map((row) => row.tournament_id).filter(Boolean))];
      if (!ids.length) return new Map();
      const tournaments = await client
        .from('tournaments')
        .select(
          'id,status,current_players,current_level,blind_structure,started_at,level_started_at,on_break,accelerated_mtt,addon_period_started_at,addon_period_ends_at'
        )
        .in('id', ids);
      if (tournaments.error) throw tournaments.error;
      const now = Date.now();
      // Auth and both database reads consume the original deadline too.
      const budgetMs = remainingObservationMs(deadline, now);
      const clocks = new Map<string, HudClock>();
      for (const table of tables.data || []) {
        const row = tournaments.data?.find((entry) => entry.id === table.tournament_id);
        const clock = row ? eligibleHudClock(row, now, budgetMs) : null;
        qualifications.push({ tableId: table.id, clock, row: row || null, budgetMs });
        if (clock) clocks.set(table.id, clock);
      }
      return clocks;
    },
    async close() {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
    },
  };
}

/** Retain only named level facts; never auth frames, tokens, or arbitrary payloads. */
export function receivedHudLevel(raw: string, at: number): HudLevel | null {
  try {
    const frame = JSON.parse(raw);
    const topic = Array.isArray(frame) ? frame[2] : frame.topic;
    const event = Array.isArray(frame) ? frame[3] : frame.event;
    const body = Array.isArray(frame) ? frame[4] : frame.payload;
    const match = /^realtime:t-break-([0-9a-f-]{36})$/i.exec(String(topic));
    if (
      !match ||
      event !== 'broadcast' ||
      body?.event !== 'tournament_event' ||
      body?.payload?.type !== 'level_up'
    )
      return null;
    const levelIndex = body.payload.payload?.level;
    if (!Number.isSafeInteger(levelIndex) || levelIndex < 0) return null;
    return { tournamentId: match[1], levelIndex, at };
  } catch {
    return null;
  }
}

export function observeHudLevels(page: Page): HudLevel[] {
  const levels: HudLevel[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const level = receivedHudLevel(String(payload), Date.now());
      if (level) levels.push(level);
    })
  );
  return levels;
}

export function sharedNaturalLevel(
  a: HudLevel[],
  b: HudLevel[],
  id: string,
  baseline: number,
  since: number
) {
  return a.find(
    (first) =>
      first.tournamentId === id &&
      first.levelIndex > baseline &&
      first.at > since &&
      b.some(
        (second) =>
          second.tournamentId === id && second.levelIndex === first.levelIndex && second.at > since
      )
  );
}

export function waitForSharedNaturalLevel(
  read: () => HudLevel | undefined,
  timeoutMs: number,
  signal: AbortSignal
): Promise<HudLevel> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (level?: HudLevel, error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (level) resolve(level);
      else reject(error);
    };
    const abort = () => finish(undefined, new Error('HUD observation retired'));
    const inspect = () => {
      if (signal.aborted) return abort();
      if (Date.now() >= deadline)
        return finish(
          undefined,
          new Error('Qualified MTT produced no shared natural level transition')
        );
      const level = read();
      if (level) return finish(level);
      timer = setTimeout(inspect, 50);
    };
    signal.addEventListener('abort', abort, { once: true });
    inspect();
  });
}
