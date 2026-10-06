import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import StatsWorkspacePanel from '../../components/stats/StatsWorkspacePanel';
import { SpadeConsole } from '../../components/console/SpadeConsole';
import {
  statsWorkspaceService,
  type StatsWorkspaceSnapshot,
  type WorkspaceLeakStatus,
} from '../../services/StatsWorkspaceService';
import { BASE_TABS, normalizeDashboardLayout, type StatCategory } from './playerStatsPageModel';

const OWNER_STATS_TABS: StatCategory[] = [
  ...BASE_TABS.slice(0, 3),
  'hands',
  ...BASE_TABS.slice(3),
  'trophies',
  'rake',
  'workspace',
];

interface Props {
  isOwnProfile: boolean;
  onPresentationModeChange?: (enabled: boolean) => void;
  onDashboardLayoutChange?: (layout: string[]) => void;
  ruleReport?: {
    title: string;
    sourceVersion: string;
    body: Record<string, unknown>;
    evidence: unknown[];
    clubId: string | null;
    rangeDays: number | null;
    generatedAt: string;
  } | null;
}

let operationSequence = 0;
const newOperationKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  operationSequence += 1;
  return `${Date.now()}-${operationSequence}`;
};

export default function WorkspaceTab({
  isOwnProfile,
  onPresentationModeChange,
  onDashboardLayoutChange,
  ruleReport = null,
}: Props) {
  const [workspace, setWorkspace] = useState<StatsWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(isOwnProfile);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reportTitle, setReportTitle] = useState('');
  const [reportSummary, setReportSummary] = useState('');
  const [reportEvidenceHand, setReportEvidenceHand] = useState('');
  const [goalId, setGoalId] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalMetric, setGoalMetric] = useState('');
  const [goalTarget, setGoalTarget] = useState('');
  const [goalBaseline, setGoalBaseline] = useState('');
  const [progressGoalId, setProgressGoalId] = useState('');
  const [progressValue, setProgressValue] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [studyCollectionId, setStudyCollectionId] = useState('');
  const [studyHandId, setStudyHandId] = useState('');
  const [layout, setLayout] = useState('overview, performance, hands');
  const [alertName, setAlertName] = useState('');
  const [alertMetric, setAlertMetric] = useState('');
  const [alertThreshold, setAlertThreshold] = useState('');
  const [leakTitle, setLeakTitle] = useState('');
  const [leakHandId, setLeakHandId] = useState('');
  const reportKey = useRef(newOperationKey());
  const loadSequence = useRef(0);
  const mutationPendingRef = useRef(false);
  const [mutationPending, setMutationPending] = useState(false);

  async function guardedMutation<T>(operation: () => Promise<T>): Promise<T | null> {
    if (mutationPendingRef.current) return null;
    mutationPendingRef.current = true;
    setMutationPending(true);
    try {
      return await operation();
    } finally {
      mutationPendingRef.current = false;
      setMutationPending(false);
    }
  }

  const load = useCallback(async () => {
    if (!isOwnProfile) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    const result = await statsWorkspaceService.load();
    if (sequence !== loadSequence.current) return;
    if (result.ok) {
      setWorkspace(result.data);
      const normalizedLayout = normalizeDashboardLayout(
        result.data.preferences.dashboardLayout,
        OWNER_STATS_TABS
      );
      setLayout(normalizedLayout.filter((tab) => tab !== 'workspace').join(', '));
      onPresentationModeChange?.(result.data.preferences.privacyPresentationMode);
      onDashboardLayoutChange?.(normalizedLayout);
    } else setError(result.error);
    setLoading(false);
  }, [isOwnProfile, onPresentationModeChange, onDashboardLayoutChange]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  const finish = async (message: string) => {
    setNotice(message);
    await load();
  };

  const savePlayerReport = async (event: FormEvent) => {
    event.preventDefault();
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveReport({
        idempotencyKey: reportKey.current,
        title: reportTitle,
        sourceKind: 'player_authored',
        sourceVersion: 'player-v1',
        body: { summary: reportSummary },
        evidence: reportEvidenceHand.trim() ? [{ hand_id: reportEvidenceHand.trim() }] : [],
      })
    );
    if (!result) return;
    if (!result.ok) return setNotice('Report Was Not Saved.');
    reportKey.current = newOperationKey();
    setReportTitle('');
    setReportSummary('');
    setReportEvidenceHand('');
    await finish('Player-Authored Report Saved.');
  };

  const saveRuleReport = async () => {
    if (!ruleReport) return;
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveReport({
        idempotencyKey: `rules:${ruleReport.sourceVersion}:${ruleReport.clubId ?? 'all'}:${ruleReport.rangeDays ?? 'all'}:${ruleReport.generatedAt}`,
        title: ruleReport.title,
        sourceKind: 'rule_derived',
        sourceVersion: ruleReport.sourceVersion,
        body: ruleReport.body,
        evidence: ruleReport.evidence,
        clubId: ruleReport.clubId,
        rangeDays: ruleReport.rangeDays,
      })
    );
    if (!result) return;
    setNotice(result.ok ? 'Rule-Derived Report Saved.' : 'Rule-Derived Report Was Not Saved.');
    if (result.ok) await load();
  };

  const saveGoal = async (event: FormEvent) => {
    event.preventDefault();
    const target = Number(goalTarget);
    const baseline = Number(goalBaseline);
    if (!Number.isFinite(target) || !Number.isFinite(baseline))
      return setNotice('Enter A Valid Goal Baseline And Target.');
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveGoal({
        id: goalId || null,
        title: goalTitle,
        metricKey: goalMetric,
        direction: 'increase',
        baseline,
        target,
      })
    );
    if (!result) return;
    if (!result.ok) return setNotice('Goal Was Not Saved.');
    setGoalTitle('');
    setGoalId('');
    setGoalMetric('');
    setGoalTarget('');
    setGoalBaseline('');
    await finish('Goal Saved.');
  };

  const chooseGoal = (id: string) => {
    setGoalId(id);
    if (!id) {
      setGoalTitle('');
      setGoalMetric('');
      setGoalTarget('');
      setGoalBaseline('');
      return;
    }
    const goal = workspace?.goals.find((candidate) => candidate.id === id);
    if (!goal) return;
    setGoalTitle(goal.title);
    setGoalMetric(goal.metricKey);
    setGoalBaseline(String(goal.baseline));
    setGoalTarget(String(goal.target));
  };

  const addProgress = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(progressValue);
    if (!progressGoalId || !Number.isFinite(value))
      return setNotice('Choose A Goal And Valid Reading.');
    const result = await guardedMutation(() =>
      statsWorkspaceService.addGoalProgress(progressGoalId, value)
    );
    if (!result) return;
    setNotice(result.ok ? 'Goal Progress Saved.' : 'Goal Progress Was Not Saved.');
    if (result.ok) await load();
  };

  const saveCollection = async (event: FormEvent) => {
    event.preventDefault();
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveCollection(null, collectionName)
    );
    if (!result) return;
    if (!result.ok) return setNotice('Collection Was Not Saved.');
    setCollectionName('');
    await finish('Study Collection Saved.');
  };

  const addStudyHand = async (event: FormEvent) => {
    event.preventDefault();
    const result = await guardedMutation(() =>
      statsWorkspaceService.addStudyHand(studyCollectionId, studyHandId.trim())
    );
    if (!result) return;
    setNotice(result.ok ? 'Owned Hand Added To Study Collection.' : 'Hand Was Not Added.');
    if (result.ok) {
      setStudyHandId('');
      await load();
    }
  };

  const saveLayout = async (event: FormEvent) => {
    event.preventDefault();
    const dashboardLayout = normalizeDashboardLayout(
      layout.split(',').map((value) => value.trim()),
      OWNER_STATS_TABS
    ).filter((tab) => tab !== 'workspace');
    const result = await guardedMutation(() =>
      statsWorkspaceService.savePreferences({
        dashboardLayout,
        privacyPresentationMode: workspace?.preferences.privacyPresentationMode ?? false,
      })
    );
    if (!result) return;
    setNotice(result.ok ? 'Dashboard Layout Saved.' : 'Dashboard Layout Was Not Saved.');
    if (result.ok) await load();
  };

  const restoreLayout = async () => {
    const result = await guardedMutation(() =>
      statsWorkspaceService.savePreferences({
        dashboardLayout: [],
        privacyPresentationMode: workspace?.preferences.privacyPresentationMode ?? false,
      })
    );
    if (!result) return;
    setLayout(OWNER_STATS_TABS.filter((tab) => tab !== 'workspace').join(', '));
    setNotice(result.ok ? 'Default Dashboard Restored.' : 'Dashboard Was Not Restored.');
    if (result.ok) await load();
  };

  const trackLeak = async (event: FormEvent) => {
    event.preventDefault();
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveLeak({
        leakKey: newOperationKey(),
        title: leakTitle,
        severity: 'medium',
        status: 'open',
        evidenceHandIds: leakHandId.trim() ? [leakHandId.trim()] : [],
      })
    );
    if (!result) return;
    setNotice(result.ok ? 'Leak Added To Your Practice Queue.' : 'Leak Was Not Saved.');
    if (result.ok) {
      setLeakTitle('');
      setLeakHandId('');
      await load();
    }
  };

  const saveAlert = async (event: FormEvent) => {
    event.preventDefault();
    const threshold = Number(alertThreshold);
    if (!Number.isFinite(threshold)) return setNotice('Enter A Valid Alert Threshold.');
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveAlertRule({
        name: alertName,
        metricKey: alertMetric,
        comparator: 'gt',
        threshold,
      })
    );
    if (!result) return;
    setNotice(result.ok ? 'Refresh Alert Saved.' : 'Refresh Alert Was Not Saved.');
    if (result.ok) await load();
  };

  const changePrivacy = async (enabled: boolean) => {
    const dashboardLayout = normalizeDashboardLayout(
      workspace?.preferences.dashboardLayout ?? [],
      OWNER_STATS_TABS
    ).filter((tab) => tab !== 'workspace');
    const result = await guardedMutation(() =>
      statsWorkspaceService.savePreferences({
        dashboardLayout,
        privacyPresentationMode: enabled,
      })
    );
    if (!result) return;
    setNotice(
      result.ok ? 'Presentation Preference Saved.' : 'Presentation Preference Was Not Saved.'
    );
    if (result.ok) await load();
  };

  const changeLeakStatus = async (leakId: string, status: WorkspaceLeakStatus) => {
    const leak = workspace?.leaks.find((item) => item.id === leakId);
    if (!leak) return;
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveLeak({
        leakKey: leak.leakKey,
        title: leak.title,
        severity: leak.severity,
        status,
        snapshot: leak.snapshot,
        evidenceHandIds: leak.evidenceHandIds,
        reportId: leak.reportId,
      })
    );
    if (!result) return;
    setNotice(result.ok ? 'Leak Status Saved.' : 'Leak Status Was Not Saved.');
    if (result.ok) await load();
  };

  const toggleAlert = async (alertId: string, enabled: boolean) => {
    const alert = workspace?.alerts.find((item) => item.id === alertId);
    if (!alert) return;
    const result = await guardedMutation(() =>
      statsWorkspaceService.saveAlertRule({
        id: alert.id,
        name: alert.name,
        metricKey: alert.metricKey,
        comparator: alert.comparator,
        threshold: alert.threshold,
        enabled,
        cooldownMinutes: alert.cooldownMinutes,
      })
    );
    if (!result) return;
    setNotice(result.ok ? 'Alert State Saved.' : 'Alert State Was Not Saved.');
    if (result.ok) await load();
  };

  return (
    <>
      <StatsWorkspacePanel
        isOwnProfile={isOwnProfile}
        workspace={workspace}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onPrivacyModeChange={(enabled) => void changePrivacy(enabled)}
        onLeakStatusChange={(id, status) => void changeLeakStatus(id, status)}
        onAlertToggle={(id, enabled) => void toggleAlert(id, enabled)}
      />
      {isOwnProfile && workspace && (
        <SpadeConsole eyebrow="Private Controls" title="Workspace Builder" pill="Saved" foot="foot">
          <fieldset
            className="stats-workspace-composer"
            aria-label="Workspace Builder"
            aria-busy={mutationPending}
            disabled={mutationPending}
          >
            <form onSubmit={savePlayerReport}>
              <label>
                Report Title
                <input
                  value={reportTitle}
                  onChange={(event) => setReportTitle(event.target.value)}
                  required
                />
              </label>
              <label>
                Report Summary
                <textarea
                  value={reportSummary}
                  onChange={(event) => setReportSummary(event.target.value)}
                  required
                />
              </label>
              <label>
                Player Report Evidence Hand
                <input
                  value={reportEvidenceHand}
                  onChange={(event) => setReportEvidenceHand(event.target.value)}
                />
              </label>
              <button type="submit">Save Player-Authored Report</button>
            </form>
            {ruleReport && (
              <button type="button" onClick={() => void saveRuleReport()}>
                Save Current Rule-Derived Report
              </button>
            )}
            <form onSubmit={trackLeak}>
              <label>
                Leak To Practice
                <input
                  value={leakTitle}
                  onChange={(event) => setLeakTitle(event.target.value)}
                  required
                />
              </label>
              <label>
                Leak Evidence Hand
                <input value={leakHandId} onChange={(event) => setLeakHandId(event.target.value)} />
              </label>
              <button type="submit">Track Leak</button>
            </form>
            <form onSubmit={saveGoal}>
              <label>
                Goal To Edit
                <select value={goalId} onChange={(event) => chooseGoal(event.target.value)}>
                  <option value="">New Goal</option>
                  {workspace.goals.map((goal) => (
                    <option value={goal.id} key={goal.id}>
                      {goal.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Goal Title
                <input
                  value={goalTitle}
                  onChange={(event) => setGoalTitle(event.target.value)}
                  required
                />
              </label>
              <label>
                Metric
                <input
                  value={goalMetric}
                  onChange={(event) => setGoalMetric(event.target.value)}
                  required
                />
              </label>
              <label>
                Current Baseline
                <input
                  inputMode="decimal"
                  value={goalBaseline}
                  onChange={(event) => setGoalBaseline(event.target.value)}
                  required
                />
              </label>
              <label>
                Target
                <input
                  inputMode="decimal"
                  value={goalTarget}
                  onChange={(event) => setGoalTarget(event.target.value)}
                  required
                />
              </label>
              <button type="submit">Save Goal</button>
            </form>
            <form onSubmit={addProgress}>
              <label>
                Goal
                <select
                  value={progressGoalId}
                  onChange={(event) => setProgressGoalId(event.target.value)}
                  required
                >
                  <option value="">Choose Goal</option>
                  {workspace.goals.map((goal) => (
                    <option value={goal.id} key={goal.id}>
                      {goal.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Current Reading
                <input
                  inputMode="decimal"
                  value={progressValue}
                  onChange={(event) => setProgressValue(event.target.value)}
                  required
                />
              </label>
              <button type="submit">Record Progress</button>
            </form>
            <form onSubmit={saveCollection}>
              <label>
                Collection Name
                <input
                  value={collectionName}
                  onChange={(event) => setCollectionName(event.target.value)}
                  required
                />
              </label>
              <button type="submit">Create Study Collection</button>
            </form>
            <form onSubmit={addStudyHand}>
              <label>
                Study Collection
                <select
                  value={studyCollectionId}
                  onChange={(event) => setStudyCollectionId(event.target.value)}
                  required
                >
                  <option value="">Choose Collection</option>
                  {workspace.collections.map((collection) => (
                    <option value={collection.id} key={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Owned Hand Reference
                <input
                  value={studyHandId}
                  onChange={(event) => setStudyHandId(event.target.value)}
                  required
                />
              </label>
              <button type="submit">Add Owned Hand</button>
            </form>
            <form onSubmit={saveLayout}>
              <label>
                Dashboard Zones
                <input value={layout} onChange={(event) => setLayout(event.target.value)} />
              </label>
              <button type="submit">Save Dashboard Layout</button>
            </form>
            <button type="button" onClick={() => void restoreLayout()}>
              Restore Default Dashboard
            </button>
            <form onSubmit={saveAlert}>
              <label>
                Alert Name
                <input
                  value={alertName}
                  onChange={(event) => setAlertName(event.target.value)}
                  required
                />
              </label>
              <label>
                Metric
                <select
                  value={alertMetric}
                  onChange={(event) => setAlertMetric(event.target.value)}
                  required
                >
                  <option value="">Choose Metric</option>
                  <option value="vpip">VPIP</option>
                  <option value="pfr">PFR</option>
                  <option value="three_bet_percent">Three Bet Percent</option>
                  <option value="bb_per_100">BB Per 100</option>
                  <option value="total_profit">Total Profit</option>
                  <option value="rake_paid">Rake Paid</option>
                </select>
              </label>
              <label>
                Alert Above
                <input
                  inputMode="decimal"
                  value={alertThreshold}
                  onChange={(event) => setAlertThreshold(event.target.value)}
                  required
                />
              </label>
              <button type="submit">Save Refresh Alert</button>
            </form>
            <p role="status" aria-live="polite">
              {notice}
            </p>
          </fieldset>
        </SpadeConsole>
      )}
    </>
  );
}
