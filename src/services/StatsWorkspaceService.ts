import { supabase } from '../lib/supabase';
import { handNotesService, type HandNote } from './HandNotesService';
import { reportError } from '../utils/errorReporter';

export type WorkspaceReportSource = 'player_authored' | 'rule_derived';
export type WorkspaceLeakStatus = 'open' | 'practicing' | 'resolved' | 'dismissed';
export type WorkspaceGoalStatus = 'active' | 'completed' | 'paused' | 'archived';

export interface StatsWorkspaceReport {
  id: string;
  idempotencyKey: string;
  title: string;
  sourceKind: WorkspaceReportSource;
  sourceVersion: string;
  body: Record<string, unknown>;
  evidence: unknown[];
  clubId: string | null;
  rangeDays: number | null;
  updatedAt: string;
}

export interface StatsWorkspaceLeak {
  id: string;
  reportId: string | null;
  leakKey: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  status: WorkspaceLeakStatus;
  snapshot: Record<string, unknown>;
  evidenceHandIds: string[];
  updatedAt: string;
}

export interface StatsWorkspaceGoal {
  id: string;
  title: string;
  metricKey: string;
  direction: 'increase' | 'decrease' | 'maintain';
  baseline: number;
  target: number;
  status: WorkspaceGoalStatus;
  endsAt: string | null;
  updatedAt: string;
}

export interface StatsGoalProgress {
  id: string;
  goalId: string;
  measuredValue: number;
  measuredAt: string;
  evidence: Record<string, unknown>;
}

export interface StatsStudyCollection {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  hands: Array<{ handId: string; addedAt: string; note: HandNote | null }>;
  handsCapped: boolean;
}

export interface StatsWorkspacePreferences {
  dashboardLayout: unknown[];
  privacyPresentationMode: boolean;
}

export interface StatsAlertRule {
  id: string;
  name: string;
  metricKey: string;
  comparator: 'lt' | 'lte' | 'gt' | 'gte';
  threshold: number;
  enabled: boolean;
  cooldownMinutes: number;
  evaluationMode: 'on_stats_refresh';
  updatedAt: string;
  lastEvaluatedAt: string | null;
  lastValue: number | null;
  lastTriggeredAt: string | null;
}

export interface StatsWorkspaceSnapshot {
  reports: StatsWorkspaceReport[];
  leaks: StatsWorkspaceLeak[];
  goals: StatsWorkspaceGoal[];
  progress: StatsGoalProgress[];
  collections: StatsStudyCollection[];
  preferences: StatsWorkspacePreferences;
  alerts: StatsAlertRule[];
  coverage: { capped: boolean; rowLimit: number };
}

export type WorkspaceResult<T> = { ok: true; data: T } | { ok: false; error: string };

const EMPTY_PREFERENCES: StatsWorkspacePreferences = {
  dashboardLayout: [],
  privacyPresentationMode: false,
};
const WORKSPACE_ROW_LIMIT = 100;
const WORKSPACE_FETCH_LIMIT = WORKSPACE_ROW_LIMIT + 1;
const dashboardLayout = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function failure(error: unknown, operation: string): WorkspaceResult<never> {
  reportError(error, `StatsWorkspaceService.${operation}`);
  return { ok: false, error: error instanceof Error ? error.message : 'Workspace Request Failed' };
}

function rpcValue<T>(value: unknown): T {
  return value as T;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]);
      }
    })
  );
  return results;
}

export const statsWorkspaceService = {
  async loadPreferences(): Promise<WorkspaceResult<StatsWorkspacePreferences>> {
    try {
      const { data, error } = await supabase
        .from('ca_stats_workspace_preferences')
        .select('dashboard_layout, privacy_presentation_mode')
        .maybeSingle();
      if (error) throw error;
      return {
        ok: true,
        data: data
          ? {
              dashboardLayout: dashboardLayout(data.dashboard_layout),
              privacyPresentationMode: data.privacy_presentation_mode,
            }
          : EMPTY_PREFERENCES,
      };
    } catch (error) {
      return failure(error, 'loadPreferences');
    }
  },

  async load(): Promise<WorkspaceResult<StatsWorkspaceSnapshot>> {
    try {
      const [reports, leaks, goals, progress, collections, preferences, alerts] = await Promise.all(
        [
          supabase
            .from('ca_stats_workspace_reports')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT),
          supabase
            .from('ca_stats_workspace_leaks')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT),
          supabase
            .from('ca_stats_workspace_goals')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT),
          supabase
            .from('ca_stats_workspace_goal_progress')
            .select('*')
            .order('measured_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT),
          supabase
            .from('ca_stats_workspace_collections')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT),
          supabase.from('ca_stats_workspace_preferences').select('*').maybeSingle(),
          supabase
            .from('ca_stats_workspace_alert_rules')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT),
        ]
      );

      const failed = [reports, leaks, goals, progress, collections, preferences, alerts].find(
        (result) => result.error
      );
      if (failed?.error) throw failed.error;

      const collectionRows = (collections.data ?? []).slice(0, WORKSPACE_ROW_LIMIT);
      const collectionHandResults = await mapWithConcurrency(
        collectionRows,
        6,
        async (collection) =>
          await supabase
            .from('ca_stats_workspace_collection_hands')
            .select('*')
            .eq('collection_id', collection.id)
            .order('added_at', { ascending: false })
            .limit(WORKSPACE_FETCH_LIMIT)
      );
      const failedHands = collectionHandResults.find((result) => result.error);
      if (failedHands?.error) throw failedHands.error;
      const capped =
        [reports, leaks, goals, progress, collections, alerts].some(
          (result) => (result.data?.length ?? 0) > WORKSPACE_ROW_LIMIT
        ) ||
        collectionHandResults.some((result) => (result.data?.length ?? 0) > WORKSPACE_ROW_LIMIT);
      const handRows = collectionHandResults.flatMap((result) =>
        (result.data ?? []).slice(0, WORKSPACE_ROW_LIMIT)
      );
      const notes = await handNotesService.listFor(handRows.map((row) => row.hand_id));
      const collectionItems = collectionRows.map((row, index) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        updatedAt: row.updated_at,
        hands: (collectionHandResults[index].data ?? [])
          .slice(0, WORKSPACE_ROW_LIMIT)
          .map((hand) => ({
            handId: hand.hand_id,
            addedAt: hand.added_at,
            note: notes.get(hand.hand_id) ?? null,
          })),
        handsCapped: (collectionHandResults[index].data?.length ?? 0) > WORKSPACE_ROW_LIMIT,
      }));

      return {
        ok: true,
        data: {
          reports: (reports.data ?? []).slice(0, WORKSPACE_ROW_LIMIT).map((row) => ({
            id: row.id,
            idempotencyKey: row.idempotency_key,
            title: row.title,
            sourceKind: row.source_kind as WorkspaceReportSource,
            sourceVersion: row.source_version,
            body: row.body as Record<string, unknown>,
            evidence: row.evidence as unknown[],
            clubId: row.club_id,
            rangeDays: row.range_days,
            updatedAt: row.updated_at,
          })),
          leaks: (leaks.data ?? []).slice(0, WORKSPACE_ROW_LIMIT).map((row) => ({
            id: row.id,
            reportId: row.report_id,
            leakKey: row.leak_key,
            title: row.title,
            severity: row.severity as StatsWorkspaceLeak['severity'],
            status: row.status as WorkspaceLeakStatus,
            snapshot: row.snapshot as Record<string, unknown>,
            evidenceHandIds: row.evidence_hand_ids,
            updatedAt: row.updated_at,
          })),
          goals: (goals.data ?? []).slice(0, WORKSPACE_ROW_LIMIT).map((row) => ({
            id: row.id,
            title: row.title,
            metricKey: row.metric_key,
            direction: row.direction as StatsWorkspaceGoal['direction'],
            baseline: Number(row.baseline),
            target: Number(row.target),
            status: row.status as WorkspaceGoalStatus,
            endsAt: row.ends_at,
            updatedAt: row.updated_at,
          })),
          progress: (progress.data ?? []).slice(0, WORKSPACE_ROW_LIMIT).map((row) => ({
            id: row.id,
            goalId: row.goal_id,
            measuredValue: Number(row.measured_value),
            measuredAt: row.measured_at,
            evidence: row.evidence as Record<string, unknown>,
          })),
          collections: collectionItems,
          preferences: preferences.data
            ? {
                dashboardLayout: dashboardLayout(preferences.data.dashboard_layout),
                privacyPresentationMode: preferences.data.privacy_presentation_mode,
              }
            : EMPTY_PREFERENCES,
          alerts: (alerts.data ?? []).slice(0, WORKSPACE_ROW_LIMIT).map((row) => ({
            id: row.id,
            name: row.name,
            metricKey: row.metric_key,
            comparator: row.comparator as StatsAlertRule['comparator'],
            threshold: Number(row.threshold),
            enabled: row.enabled,
            cooldownMinutes: row.cooldown_minutes,
            evaluationMode: 'on_stats_refresh',
            updatedAt: row.updated_at,
            lastEvaluatedAt: row.last_evaluated_at,
            lastValue: row.last_value === null ? null : Number(row.last_value),
            lastTriggeredAt: row.last_triggered_at,
          })),
          coverage: { capped, rowLimit: WORKSPACE_ROW_LIMIT },
        },
      };
    } catch (error) {
      return failure(error, 'load');
    }
  },

  async saveReport(input: {
    idempotencyKey: string;
    title: string;
    sourceKind: WorkspaceReportSource;
    sourceVersion: string;
    body?: Record<string, unknown>;
    evidence?: unknown[];
    clubId?: string | null;
    rangeDays?: number | null;
  }): Promise<WorkspaceResult<string>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_report_save', {
        p_idempotency_key: input.idempotencyKey,
        p_title: input.title,
        p_source_kind: input.sourceKind,
        p_source_version: input.sourceVersion,
        p_body: input.body ?? {},
        p_evidence: input.evidence ?? [],
        p_club_id: input.clubId ?? null,
        p_range_days: input.rangeDays ?? null,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<string>(data) };
    } catch (error) {
      return failure(error, 'saveReport');
    }
  },

  async saveLeak(input: {
    leakKey: string;
    title: string;
    severity: StatsWorkspaceLeak['severity'];
    status: WorkspaceLeakStatus;
    snapshot?: Record<string, unknown>;
    evidenceHandIds?: string[];
    reportId?: string | null;
  }): Promise<WorkspaceResult<string>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_leak_save', {
        p_leak_key: input.leakKey,
        p_title: input.title,
        p_severity: input.severity,
        p_status: input.status,
        p_snapshot: input.snapshot ?? {},
        p_evidence_hand_ids: input.evidenceHandIds ?? [],
        p_report_id: input.reportId ?? null,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<string>(data) };
    } catch (error) {
      return failure(error, 'saveLeak');
    }
  },

  async saveGoal(input: {
    id?: string | null;
    title: string;
    metricKey: string;
    direction: StatsWorkspaceGoal['direction'];
    baseline: number;
    target: number;
    status?: WorkspaceGoalStatus;
    endsAt?: string | null;
  }): Promise<WorkspaceResult<string>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_goal_save', {
        p_goal_id: input.id ?? null,
        p_title: input.title,
        p_metric_key: input.metricKey,
        p_direction: input.direction,
        p_baseline: input.baseline,
        p_target: input.target,
        p_status: input.status ?? 'active',
        p_ends_at: input.endsAt ?? null,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<string>(data) };
    } catch (error) {
      return failure(error, 'saveGoal');
    }
  },

  async addGoalProgress(
    goalId: string,
    measuredValue: number,
    evidence: Record<string, unknown> = {}
  ) {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_goal_progress_add', {
        p_goal_id: goalId,
        p_measured_value: measuredValue,
        p_evidence: evidence,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<string>(data) } as WorkspaceResult<string>;
    } catch (error) {
      return failure(error, 'addGoalProgress');
    }
  },

  async saveCollection(id: string | null, name: string, description = '') {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_collection_save', {
        p_collection_id: id,
        p_name: name,
        p_description: description,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<string>(data) } as WorkspaceResult<string>;
    } catch (error) {
      return failure(error, 'saveCollection');
    }
  },

  async addStudyHand(collectionId: string, handId: string): Promise<WorkspaceResult<boolean>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_study_add', {
        p_collection_id: collectionId,
        p_hand_id: handId,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<boolean>(data) };
    } catch (error) {
      return failure(error, 'addStudyHand');
    }
  },

  async savePreferences(preferences: StatsWorkspacePreferences): Promise<WorkspaceResult<boolean>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_preferences_save', {
        p_dashboard_layout: preferences.dashboardLayout,
        p_privacy_presentation_mode: preferences.privacyPresentationMode,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<boolean>(data) };
    } catch (error) {
      return failure(error, 'savePreferences');
    }
  },

  async saveAlertRule(input: {
    id?: string | null;
    name: string;
    metricKey: string;
    comparator: StatsAlertRule['comparator'];
    threshold: number;
    enabled?: boolean;
    cooldownMinutes?: number;
  }): Promise<WorkspaceResult<string>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_alert_rule_save', {
        p_rule_id: input.id ?? null,
        p_name: input.name,
        p_metric_key: input.metricKey,
        p_comparator: input.comparator,
        p_threshold: input.threshold,
        p_enabled: input.enabled ?? true,
        p_cooldown_minutes: input.cooldownMinutes ?? 1440,
      });
      if (error) throw error;
      return { ok: true, data: rpcValue<string>(data) };
    } catch (error) {
      return failure(error, 'saveAlertRule');
    }
  },

  async evaluateAlerts(metricValues: Record<string, number>): Promise<WorkspaceResult<number>> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_stats_workspace_alerts_evaluate', {
        p_metric_values: metricValues,
      });
      if (error) throw error;
      return { ok: true, data: Number(data ?? 0) };
    } catch (error) {
      return failure(error, 'evaluateAlerts');
    }
  },
};

export default statsWorkspaceService;
