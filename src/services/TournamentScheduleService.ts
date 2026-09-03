/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT SCHEDULE SERVICE (2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Client wrapper for the recurring-tournament schedule RPCs
 * (supabase/migrations/20260822100100_tournament_schedules.sql):
 *
 *   fn_upsert_tournament_schedule(p_schedule jsonb)  -- create/update
 *   fn_delete_tournament_schedule(p_schedule_id)     -- soft delete (active=false)
 *
 * A schedule row describes WHEN tournaments should exist; the engine's spawner
 * creates the tournaments from `config`, which carries the SAME key shapes as
 * fn_create_tournament's p_config (build it with
 * tournamentService.buildRpcConfig and strip startTime — the spawner owns it).
 *
 * Writes are union-owner / union-admin / club-admin gated server-side; reads
 * are plain authenticated selects (RLS allows read only).
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface TournamentScheduleRow {
  id: string;
  union_id: string | null;
  club_id: string;
  name: string;
  description: string | null;
  active: boolean;
  /** 0=Sunday .. 6=Saturday, UTC. */
  days_of_week: number[];
  /** 'HH:MM' 24h, UTC. */
  start_times_utc: string[];
  interval_minutes: number | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TournamentScheduleDraft {
  /** Present = update that row; absent = create. */
  id?: string;
  unionId?: string | null;
  clubId: string;
  name: string;
  description?: string;
  active?: boolean;
  daysOfWeek: number[];
  startTimesUtc: string[];
  intervalMinutes?: number | null;
  /** fn_create_tournament p_config shape, WITHOUT startTime. */
  config: Record<string, unknown>;
}

const SCHEDULE_ERRORS: Record<string, string> = {
  not_authenticated: 'You need to be signed in to manage schedules.',
  not_authorised: 'Only the union owner or an admin can manage this schedule.',
  schedule_not_found: 'That schedule no longer exists.',
  schedule_must_be_object: 'Schedule payload was malformed.',
  club_id_required: 'A schedule needs a club.',
  name_required: 'Give the schedule a name.',
  config_must_be_object: 'The tournament configuration is missing.',
  days_of_week_required: 'Pick at least one day of the week.',
  days_of_week_out_of_range: 'Days of week must be Sunday through Saturday.',
  start_time_format_invalid: 'Start times must be HH:MM, 24-hour, UTC.',
  start_times_or_interval_required: 'Add at least one start time, or a repeat interval.',
  interval_minutes_out_of_range: 'The repeat interval must be 5 to 1440 minutes.',
};

function scheduleErrorText(code: string | undefined): string {
  return SCHEDULE_ERRORS[code ?? ''] ?? 'Could not save the schedule.';
}

class TournamentScheduleService {
  /** Create or update a schedule. Returns the schedule id. Throws on refusal. */
  async upsert(draft: TournamentScheduleDraft): Promise<string> {
    const { data, error } = await supabase.rpc('fn_upsert_tournament_schedule', {
      p_schedule: {
        id: draft.id ?? null,
        unionId: draft.unionId ?? null,
        clubId: draft.clubId,
        name: draft.name,
        description: draft.description ?? null,
        active: draft.active ?? true,
        daysOfWeek: draft.daysOfWeek,
        startTimesUtc: draft.startTimesUtc,
        intervalMinutes: draft.intervalMinutes ?? null,
        config: draft.config,
      },
    });
    if (error) {
      reportError(error, 'TournamentScheduleService.upsert');
      throw new Error('Could not save the schedule.');
    }
    const res = data as { ok?: boolean; schedule_id?: string; error?: string } | null;
    if (!res?.ok || !res.schedule_id) {
      throw new Error(scheduleErrorText(res?.error));
    }
    return res.schedule_id;
  }

  /** Flip active on an existing schedule without touching anything else. */
  async setActive(scheduleId: string, active: boolean): Promise<void> {
    if (active) {
      const { data, error } = await supabase.rpc('fn_upsert_tournament_schedule', {
        p_schedule: { id: scheduleId, active: true },
      });
      if (error) {
        reportError(error, 'TournamentScheduleService.setActive');
        throw new Error('Could not update the schedule.');
      }
      const res = data as { ok?: boolean; error?: string } | null;
      if (!res?.ok) throw new Error(scheduleErrorText(res?.error));
      return;
    }
    await this.deactivate(scheduleId);
  }

  /** Soft delete: sets active=false. Spawn history is preserved server-side. */
  async deactivate(scheduleId: string): Promise<void> {
    const { data, error } = await supabase.rpc('fn_delete_tournament_schedule', {
      p_schedule_id: scheduleId,
    });
    if (error) {
      reportError(error, 'TournamentScheduleService.deactivate');
      throw new Error('Could not deactivate the schedule.');
    }
    const res = data as { ok?: boolean; error?: string } | null;
    if (!res?.ok) throw new Error(scheduleErrorText(res?.error));
  }

  /** All schedules owned by a union, newest first. */
  async listForUnion(unionId: string): Promise<TournamentScheduleRow[]> {
    const { data, error } = await supabase
      .from('tournament_schedules')
      .select(
        'id, union_id, club_id, name, description, active, days_of_week, start_times_utc, interval_minutes, config, created_at, updated_at'
      )
      .eq('union_id', unionId)
      .order('created_at', { ascending: false });
    if (error) {
      reportError(error, 'TournamentScheduleService.listForUnion');
      return [];
    }
    return (data as TournamentScheduleRow[]) || [];
  }
}

export const tournamentScheduleService = new TournamentScheduleService();
export default tournamentScheduleService;
