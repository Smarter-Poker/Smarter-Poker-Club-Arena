import { SpadeConsole } from '../console/SpadeConsole';
import type {
  StatsWorkspaceSnapshot,
  WorkspaceLeakStatus,
} from '../../services/StatsWorkspaceService';
import './StatsWorkspacePanel.css';

interface Props {
  isOwnProfile: boolean;
  workspace: StatsWorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onPrivacyModeChange?: (enabled: boolean) => void;
  onLeakStatusChange?: (leakId: string, status: WorkspaceLeakStatus) => void;
  onAlertToggle?: (alertId: string, enabled: boolean) => void;
}

const LEAK_STATUS: Record<WorkspaceLeakStatus, string> = {
  open: 'Open',
  practicing: 'Practicing',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

function latestProgress(workspace: StatsWorkspaceSnapshot, goalId: string): number | null {
  return workspace.progress.find((item) => item.goalId === goalId)?.measuredValue ?? null;
}

export default function StatsWorkspacePanel({
  isOwnProfile,
  workspace,
  loading,
  error,
  onRetry,
  onPrivacyModeChange,
  onLeakStatusChange,
  onAlertToggle,
}: Props) {
  if (!isOwnProfile) {
    return (
      <SpadeConsole eyebrow="Private Stats" title="Study Workspace" pill="Owner Only" foot="foot">
        <p className="sc-copy stats-workspace__state" role="status">
          This Workspace Is Available Only To Its Player.
        </p>
      </SpadeConsole>
    );
  }

  if (loading) {
    return (
      <SpadeConsole eyebrow="Private Stats" title="Study Workspace" pill="Loading" foot="foot">
        <p className="sc-copy stats-workspace__state" role="status">
          Loading Your Saved Workspace.
        </p>
      </SpadeConsole>
    );
  }

  if (error || !workspace) {
    return (
      <SpadeConsole eyebrow="Private Stats" title="Study Workspace" pill="Unavailable" foot="foot">
        <div className="stats-workspace__state" role="alert">
          <p className="sc-copy">Your Saved Workspace Could Not Be Loaded.</p>
          <button type="button" className="stats-workspace__word-action" onClick={onRetry}>
            Try Again
          </button>
        </div>
      </SpadeConsole>
    );
  }

  const isEmpty =
    workspace.reports.length === 0 &&
    workspace.leaks.length === 0 &&
    workspace.goals.length === 0 &&
    workspace.collections.length === 0 &&
    workspace.alerts.length === 0;

  return (
    <SpadeConsole
      eyebrow="Private Stats"
      title="Study Workspace"
      pill={workspace.preferences.privacyPresentationMode ? 'Presentation Safe' : 'Full Detail'}
      foot="foot"
      aria-label="Private Study Workspace"
    >
      <div className="stats-workspace">
        <div className="stats-workspace__intro">
          <p className="sc-copy">
            Reports Are Player-Authored Or Generated From Versioned Rules, Not A Model.
          </p>
          <button
            type="button"
            className="stats-workspace__word-action"
            onClick={() => onPrivacyModeChange?.(!workspace.preferences.privacyPresentationMode)}
          >
            {workspace.preferences.privacyPresentationMode
              ? 'Show Full Detail'
              : 'Use Presentation Mode'}
          </button>
        </div>

        {isEmpty && (
          <p className="sc-copy stats-workspace__state" role="status">
            No Reports, Goals, Study Collections, Or Alerts Have Been Saved Yet.
          </p>
        )}

        <section className="stats-workspace__section" aria-labelledby="workspace-reports-title">
          <h3 id="workspace-reports-title" className="sc-label">
            Saved Analysis Reports
          </h3>
          {workspace.reports.length === 0 ? (
            <p className="sc-copy stats-workspace__muted">No Saved Reports.</p>
          ) : (
            workspace.reports.map((report) => (
              <div className="stats-workspace__row" key={report.id}>
                <span>{report.title}</span>
                <span className="stats-workspace__meta">
                  {report.sourceKind === 'rule_derived' ? 'Rule-Derived' : 'Player-Authored'}
                </span>
              </div>
            ))
          )}
        </section>

        <section className="stats-workspace__section" aria-labelledby="workspace-leaks-title">
          <h3 id="workspace-leaks-title" className="sc-label">
            Leak Lifecycle
          </h3>
          {workspace.leaks.length === 0 ? (
            <p className="sc-copy stats-workspace__muted">No Tracked Leaks.</p>
          ) : (
            workspace.leaks.map((leak) => (
              <div className="stats-workspace__row stats-workspace__row--action" key={leak.id}>
                <span>{leak.title}</span>
                <label>
                  <span className="stats-workspace__sr">Status For {leak.title}</span>
                  <select
                    value={leak.status}
                    onChange={(event) =>
                      onLeakStatusChange?.(leak.id, event.target.value as WorkspaceLeakStatus)
                    }
                    disabled={!onLeakStatusChange}
                  >
                    {Object.entries(LEAK_STATUS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))
          )}
        </section>

        <section className="stats-workspace__section" aria-labelledby="workspace-goals-title">
          <h3 id="workspace-goals-title" className="sc-label">
            Goals And Progress
          </h3>
          {workspace.goals.length === 0 ? (
            <p className="sc-copy stats-workspace__muted">No Measurable Goals.</p>
          ) : (
            workspace.goals.map((goal) => {
              const measured = latestProgress(workspace, goal.id);
              return (
                <div className="stats-workspace__row" key={goal.id}>
                  <span>{goal.title}</span>
                  <span className="stats-workspace__meta">
                    {measured === null ? 'No Reading Yet' : `${measured} Of ${goal.target}`}
                  </span>
                </div>
              );
            })
          )}
        </section>

        <section className="stats-workspace__section" aria-labelledby="workspace-study-title">
          <h3 id="workspace-study-title" className="sc-label">
            Study Collections
          </h3>
          {workspace.collections.length === 0 ? (
            <p className="sc-copy stats-workspace__muted">No Saved Hand Collections.</p>
          ) : (
            workspace.collections.map((collection) => (
              <div className="stats-workspace__row" key={collection.id}>
                <span>{collection.name}</span>
                <span className="stats-workspace__meta">
                  {collection.hands.length} Saved {collection.hands.length === 1 ? 'Hand' : 'Hands'}
                  {collection.hands.some((hand) => hand.note) ? ', With Private Notes' : ''}
                </span>
              </div>
            ))
          )}
        </section>

        <section className="stats-workspace__section" aria-labelledby="workspace-layout-title">
          <h3 id="workspace-layout-title" className="sc-label">
            Saved Dashboard
          </h3>
          <div className="stats-workspace__row">
            <span>Custom Layout</span>
            <span className="stats-workspace__meta">
              {workspace.preferences.dashboardLayout.length} Saved Zones
            </span>
          </div>
        </section>

        <section className="stats-workspace__section" aria-labelledby="workspace-alerts-title">
          <h3 id="workspace-alerts-title" className="sc-label">
            Controlled Alerts
          </h3>
          <p className="sc-copy stats-workspace__muted">Evaluated Only When Stats Refresh.</p>
          {workspace.alerts.map((alert) => (
            <div className="stats-workspace__row stats-workspace__row--action" key={alert.id}>
              <span>
                {alert.name}
                <small className="stats-workspace__muted">
                  {alert.lastEvaluatedAt
                    ? ` Last Checked ${new Date(alert.lastEvaluatedAt).toLocaleString()}`
                    : ' Not Checked Yet'}
                  {alert.lastTriggeredAt ? ' // Triggered' : ''}
                </small>
              </span>
              <button
                type="button"
                className="stats-workspace__word-action"
                disabled={!onAlertToggle}
                onClick={() => onAlertToggle?.(alert.id, !alert.enabled)}
              >
                {alert.enabled ? 'Pause Alert' : 'Enable Alert'}
              </button>
            </div>
          ))}
        </section>
      </div>
    </SpadeConsole>
  );
}
