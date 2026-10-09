/**
 * LIGHTNING OPERATIONS (Lightning Phase 12, Spec Phase 21: Operator Dashboard)
 * ============================================================================
 * The club operator's view of every Lightning-capable Cluster in the club:
 * which mode it is in (Must Move, Lightning, Pending, Frozen), its epoch, the
 * live eligible population against the ON and OFF thresholds, pool health,
 * holds and instances, orphan holds, open blind obligations, a stuck
 * conversion, why it froze, open alerts and integrity signals, the candidate
 * matcher's verdict, per-leg action latency and the feature flags. One tap
 * opens a Cluster in full (LightningClusterDetail).
 *
 * Data: fn_lightning_operator_overview(p_club_id), SECURITY DEFINER, gated in
 * the database (service_role, a platform admin, or fn_ca_can_review_integrity
 * for this club). The registry's 'control' access is the same set of roles
 * and only decides whether the door is advertised; the server is the gate.
 *
 * LAWS
 *   - No card is shown, anywhere. The doors redact and nothing here renders a
 *     card.
 *   - Horses are players (Law 10.5): no badge, filter or column says which
 *     players are horses. Every count counts everyone.
 *   - Operator vocabulary: Lightning, Must Move, Lightning Fold, Fold & Watch.
 *   - Nothing here moves a player. Opening a Cluster changes this page only.
 *
 * #ClubArenaConsole: one console per view. Clusters print as records between
 * engraved rules with their figures beneath, never as drawn cards; Back and
 * Refresh sit on the two painted plates.
 *
 * Auto-refresh: every 15 s while the tab is visible, never while hidden, and
 * never again after the door answers "not available yet" or "not
 * authorized" (useLightningOperator).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SpadeConsole } from '../../components/console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import { formatStakes } from '../../lib/utils';
import { reportError } from '../../utils/errorReporter';
import {
  agoLabel,
  enumLabel,
  fetchLightningOverview,
  modeBadge,
  verdictLabel,
  type LightningOverview,
  type LightningOverviewCluster,
} from '../../lightning/operator/lightningOperatorApi';
import {
  OVERVIEW_REFRESH_MS,
  usePolledAnswer,
} from '../../lightning/operator/useLightningOperator';
import LightningClusterDetail from './lightning/LightningClusterDetail';
import {
  AnswerState,
  Figure,
  LatencyGrid,
  MODE_INK,
  count,
  onOff,
} from './lightning/lightningOperatorParts';
import styles from './ClubLightningOperationsPage.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stakes and shape line under a Cluster's name. */
export function clusterMeta(c: LightningOverviewCluster): string {
  const parts: string[] = [];
  if (c.variant) parts.push(enumLabel(c.variant));
  if (c.sb !== null && c.bb !== null) parts.push(formatStakes(c.sb, c.bb));
  if (c.handedness !== null) parts.push(`${c.handedness}-Max`);
  return parts.join(' ');
}

/** The warnings a Cluster carries, most serious first. */
export function clusterWarnings(c: LightningOverviewCluster): string[] {
  const out: string[] = [];
  if (c.frozen) {
    out.push(c.frozen.reason ? `Frozen: ${enumLabel(c.frozen.reason)}` : 'Frozen');
  }
  if (c.stuckConversion) {
    const { fromMode, toMode } = c.stuckConversion;
    out.push(
      fromMode && toMode
        ? `Conversion Stuck: ${modeBadge(fromMode).label} To ${modeBadge(toMode).label}`
        : 'Conversion Stuck'
    );
  }
  if ((c.orphanReservations ?? 0) > 0) {
    out.push(
      `${compactChips(c.orphanReservations)} ${c.orphanReservations === 1 ? 'Orphan Hold' : 'Orphan Holds'}`
    );
  }
  return out;
}

function signedOne(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}

export function ClusterRecord({
  cluster: c,
  onOpen,
  now,
}: {
  cluster: LightningOverviewCluster;
  onOpen: (clusterId: string) => void;
  now: number;
}) {
  const badge = modeBadge(c.mode);
  const warnings = clusterWarnings(c);
  const meta = clusterMeta(c);
  return (
    <li className={styles.record} data-cluster-id={c.clusterId}>
      <div className={styles.recordHead}>
        <span className={`${styles.recordName} sc-ink--silver`}>
          {c.name ? titleCase(c.name) : 'Unnamed Cluster'}
        </span>
        <span className={`${styles.mode} sc-ink--${MODE_INK[badge.tone]}`}>{badge.label}</span>
      </div>
      <span className={`${styles.recordMeta} sc-ink--muted`}>
        {meta ? `${meta} ` : ''}
        {badge.detail ? `${badge.detail} ` : ''}
        {c.modeSince ? `Since ${agoLabel(c.modeSince, now)}` : ''}
      </span>
      {warnings.map((w) => (
        <p className={`${styles.warning} sc-ink--red`} key={w} role="status">
          {w}
        </p>
      ))}
      <dl className={styles.figures} aria-label="Conversion">
        <Figure label="Epoch" value={count(c.epoch)} />
        <Figure label="Live Eligible" value={count(c.liveEligible)} ink="white" />
        <Figure label="On At" value={count(c.onThreshold)} />
        <Figure label="Off At" value={count(c.offThreshold)} />
      </dl>
      <span className={`${styles.recordMeta} sc-ink--muted`}>Pool Health</span>
      <dl className={styles.figures} aria-label="Pool Health">
        <Figure label="Joining" value={count(c.pool.joining)} />
        <Figure label="Checking" value={count(c.pool.eligibilityCheck)} />
        <Figure label="Active" value={count(c.pool.active)} />
        <Figure label="Sit Out" value={count(c.pool.sitOut)} />
        <Figure
          label="Disconnected"
          value={count(c.pool.disconnected)}
          ink={(c.pool.disconnected ?? 0) > 0 ? 'gold' : 'silver'}
        />
        <Figure label="Leaving" value={count(c.pool.leaving)} />
        <Figure label="Holds Pending" value={count(c.reservations.pending)} />
        <Figure label="Holds Committed" value={count(c.reservations.committed)} />
      </dl>
      <span className={`${styles.recordMeta} sc-ink--muted`}>Instances</span>
      <dl className={styles.figures} aria-label="Instances">
        <Figure label="Forming" value={count(c.instances.forming)} />
        <Figure label="Reserved" value={count(c.instances.reserved)} />
        <Figure label="Dealing" value={count(c.instances.dealing)} />
        <Figure label="Settling" value={count(c.instances.settling)} />
      </dl>
      <span className={`${styles.recordMeta} sc-ink--muted`}>Safety</span>
      <dl className={styles.figures} aria-label="Safety">
        <Figure
          label="Orphan Holds"
          value={count(c.orphanReservations)}
          ink={(c.orphanReservations ?? 0) > 0 ? 'red' : 'silver'}
        />
        <Figure label="Blind Owed" value={count(c.blindObligationsOpen)} />
        <Figure
          label="Open Alerts"
          value={count(c.openAlerts)}
          ink={(c.openAlerts ?? 0) > 0 ? 'red' : 'silver'}
        />
        <Figure
          label="Integrity"
          value={count(c.integrityOpenSignals)}
          ink={(c.integrityOpenSignals ?? 0) > 0 ? 'gold' : 'silver'}
        />
      </dl>
      <span className={`${styles.recordMeta} sc-ink--muted`}>Matcher And Flags</span>
      <dl className={styles.figures} aria-label="Matcher And Flags">
        <Figure label="Worker" value={c.workerMode ? enumLabel(c.workerMode) : 'Unknown'} />
        <Figure label="Candidate" value={c.shadow ? verdictLabel(c.shadow.verdict) : 'None'} />
        <Figure label="Comparisons" value={count(c.shadow?.comparisons ?? null)} />
        <Figure label="Quality Delta" value={signedOne(c.shadow?.deltaMean)} />
        <Figure label="Lightning" value={c.lightningEnabled ? 'On' : 'Off'} />
        <Figure label="Shadow Matcher" value={onOff(c.flags.shadowMatcher)} />
        <Figure label="Integrity Scan" value={onOff(c.flags.integrityTelemetry)} />
        <Figure label="Auto Rebuy" value={onOff(c.flags.autoRebuy)} />
      </dl>
      {c.latency && Object.keys(c.latency.legs).length > 0 ? (
        <>
          <span className={`${styles.recordMeta} sc-ink--muted`}>
            Action Latency{c.latency.windowTo ? `, ${agoLabel(c.latency.windowTo, now)}` : ''}
          </span>
          <LatencyGrid legs={c.latency.legs} />
        </>
      ) : (
        <span className={`${styles.recordMeta} sc-ink--muted`}>No Latency Windows Yet</span>
      )}
      <div className={styles.words}>
        <button
          type="button"
          className={`${styles.word} sc-ink--white`}
          onClick={() => onOpen(c.clusterId)}
        >
          Open Cluster
        </button>
      </div>
    </li>
  );
}

type Resolution =
  | { key: string; status: 'resolving' }
  | { key: string; status: 'ok'; uuid: string }
  | { key: string; status: 'not_found' }
  | { key: string; status: 'error' };

export default function ClubLightningOperationsPage() {
  const { clubId = '' } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const clusterParam = params.get('cluster');
  const clusterId = clusterParam && UUID.test(clusterParam) ? clusterParam : null;

  /* The route carries the club's slug or its uuid; the doors take a uuid. A
     uuid typed into the URL is accepted as itself; anything else is resolved
     once, exactly as the insurance report resolves it. */
  const [resolution, setResolution] = useState<Resolution>({ key: clubId, status: 'resolving' });
  useEffect(() => {
    let live = true;
    if (UUID.test(clubId)) {
      setResolution({ key: clubId, status: 'ok', uuid: clubId });
      return undefined;
    }
    setResolution({ key: clubId, status: 'resolving' });
    (async () => {
      try {
        const { resolveClubUUIDStrict } = await import('../../utils/strictClubIdResolver');
        const uuid = await resolveClubUUIDStrict(clubId);
        if (live) setResolution({ key: clubId, status: 'ok', uuid });
      } catch (e) {
        if (!live) return;
        if ((e as { name?: string } | null)?.name === 'ClubNotFoundError') {
          setResolution({ key: clubId, status: 'not_found' });
        } else {
          reportError(e, 'ClubLightningOperationsPage.Resolve_failed');
          setResolution({ key: clubId, status: 'error' });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId]);

  const clubUUID = resolution.key === clubId && resolution.status === 'ok' ? resolution.uuid : null;

  /* The overview reads only while it is the view on screen: the Cluster
     detail runs its own loop, and two loops for one operator is waste. */
  const overviewScope = clubUUID && !clusterId ? `overview:${clubUUID}` : null;
  const overview = usePolledAnswer<LightningOverview>(
    overviewScope,
    () => fetchLightningOverview(clubUUID as string),
    OVERVIEW_REFRESH_MS
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const openCluster = (id: string) => setParams({ cluster: id });
  const closeCluster = () => setParams({});

  const clusters = useMemo(
    () => (overview.answer?.status === 'ok' ? overview.answer.data.clusters : []),
    [overview.answer]
  );

  if (resolution.key === clubId && resolution.status === 'not_found') {
    return (
      <div className={styles.page}>
        <SpadeConsole
          className={styles.console}
          family="spade"
          eyebrow="Lightning"
          title="Club Not Found"
          titleId="lightning-operations-title"
          pill="Missing"
          pillInk="muted"
          foot="foot"
        >
          <p className={`sc-copy sc-copy--center ${styles.state}`}>
            No Club Answers To That Address.
          </p>
          <div className={styles.words}>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => navigate('/clubs')}
            >
              Back To Clubs
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  if (clubUUID && clusterId) {
    return (
      <div className={styles.page}>
        <LightningClusterDetail clusterId={clusterId} onBack={closeCluster} />
      </div>
    );
  }

  const answer = overview.answer;
  const pill =
    answer?.status === 'ok'
      ? `${clusters.length} ${clusters.length === 1 ? 'Cluster' : 'Clusters'}`
      : 'Operator';

  return (
    <div className={styles.page}>
      <SpadeConsole
        className={styles.console}
        family="spade"
        eyebrow="Club Operations"
        title="Lightning"
        titleId="lightning-operations-title"
        pill={pill}
        pillInk="blue"
        plates={{
          secondary: { label: 'Back', onClick: () => navigate(`/clubs/${clubId}/operations`) },
          primary: {
            label: overview.loading ? 'Reading' : 'Refresh',
            ink: 'white',
            onClick: overview.refresh,
            disabled: !overviewScope,
          },
        }}
      >
        {resolution.key === clubId && resolution.status === 'error' ? (
          <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`} role="alert">
            The Club Could Not Be Resolved
          </p>
        ) : !answer || answer.status !== 'ok' ? (
          <AnswerState answer={answer} onRetry={overview.refresh} />
        ) : (
          <>
            <p className={`${styles.freshness} sc-ink--muted`}>
              {overview.refreshedAt
                ? `Updated ${agoLabel(new Date(overview.refreshedAt).toISOString(), now)}`
                : 'Reading Lightning'}
              {', Refreshes Every 15 Seconds While Open'}
            </p>
            {answer.data.truncated ? (
              <p className={`${styles.freshness} sc-ink--gold`}>Showing The First 200 Clusters</p>
            ) : null}
            {clusters.length === 0 ? (
              <p className={`sc-copy sc-copy--center ${styles.state}`}>
                No Lightning-Capable Games In This Club Yet
              </p>
            ) : (
              <ul className={styles.records} aria-label="Lightning Clusters">
                {clusters.map((c) => (
                  <ClusterRecord key={c.clusterId} cluster={c} onOpen={openCluster} now={now} />
                ))}
              </ul>
            )}
          </>
        )}
      </SpadeConsole>
    </div>
  );
}
