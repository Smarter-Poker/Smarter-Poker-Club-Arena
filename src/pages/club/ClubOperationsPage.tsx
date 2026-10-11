import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getClubOperationBadge,
  getClubOperationGroups,
} from '../../config/clubOperationsNavigation';
import { ErrorState, LoadingState, PermissionState } from '../../components/common/EmptyState';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { useClubOperationsOverview } from '../../hooks/useClubOperationsOverview';
import { roleLabel } from '../../types/clubRoles';
import { formatInt } from '../../utils/clubDashboard';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../../components/console/SpadeConsole';
import { freshnessLabel } from '../../utils/clubOperationsFreshness';
import styles from './ClubOperationsPage.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FRESHNESS_TICK_MS = 15_000;

export { ago, freshnessLabel } from '../../utils/clubOperationsFreshness';

interface Tile {
  id: string;
  label: string;
  value: string;
  sub?: string;
}

export default function ClubOperationsPage() {
  const { clubId = '' } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const access = useClubNavigationAccess(clubId);
  const workspace = useClubWorkspace();

  /* The overview RPC takes a uuid. The workspace has already resolved this
     route's club, so use its answer; a uuid typed straight into the URL is
     accepted as itself. Anything else stays null and the page renders its
     tools without live readings rather than sending a slug to a uuid
     argument - the defect that left the whole Anti-Cheat page reading zero. */
  const clubUUID = useMemo(() => {
    if (workspace.clubUUID && (clubId === workspace.routeClubId || clubId === workspace.clubUUID)) {
      return workspace.clubUUID;
    }
    return UUID.test(clubId) ? clubId : null;
  }, [clubId, workspace.clubUUID, workspace.routeClubId]);

  /* Only ask for a reading the viewer is entitled to. The RPC refuses a
     non-staff caller anyway, but firing it to be told no is a wasted round
     trip and a misleading `club_capability_denied` in the telemetry. */
  const {
    overview,
    loading: overviewLoading,
    error: overviewError,
    denied: overviewDenied,
    refreshedAt,
    refresh,
  } = useClubOperationsOverview(
    access.isClubStaff && !access.loading && !access.error ? clubUUID : null
  );

  /* The freshness line is a relative time, so it has to be re-rendered by
     something other than the next read or it silently ages on screen. */
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(
    () => (access.isClubStaff ? getClubOperationGroups(clubId, access) : []),
    [access, clubId]
  );

  const toolPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      for (const item of group.items) map.set(item.id, item.path);
    }
    return map;
  }, [groups]);

  const tiles = useMemo<Tile[]>(() => {
    if (!overview) return [];
    const k = overview.kpis;
    const list: Tile[] = [
      {
        id: 'members',
        label: 'Members',
        value: formatInt(k.members),
        sub: `${formatInt(k.members_new_7d)} Joined This Week`,
      },
      { id: 'online', label: 'Online Now', value: formatInt(k.online_now) },
      {
        id: 'seated',
        label: 'Players Seated',
        value: formatInt(k.seated_now),
        sub: 'Counted As People, Not Seats',
      },
      {
        id: 'tables',
        label: 'Live Tables',
        value: formatInt(k.live_tables),
        sub: `${formatInt(k.running_tables)} Running, ${formatInt(k.waiting_tables)} Waiting`,
      },
      {
        id: 'tournaments',
        label: 'Tournaments',
        value: formatInt(k.tournaments_registering + k.tournaments_running),
        sub: `${formatInt(k.tournaments_registering)} Registering`,
      },
      { id: 'hands', label: 'Hands Today', value: formatInt(k.hands_today) },
    ];
    if (access.canViewFinance && typeof k.rake_today === 'number') {
      list.push({ id: 'rake', label: 'Cash Rake Today', value: compactChips(k.rake_today) });
    }
    if (access.canViewFinance && typeof k.club_bank === 'number') {
      list.push({
        id: 'bank',
        label: 'Club Bank',
        value: compactChips(k.club_bank),
        sub:
          typeof k.member_chips === 'number'
            ? `${compactChips(k.member_chips)} In Member Wallets`
            : undefined,
      });
    }
    return list;
  }, [overview, access.canViewFinance]);

  if (access.loading) {
    return <LoadingState message="Authorizing Club Operations" />;
  }

  if (access.error) {
    return <ErrorState message={access.error} onRetry={access.reload} />;
  }

  if (!access.isClubStaff) {
    return (
      <PermissionState
        title="Club Operations Is Restricted"
        description="This Workspace Is Available To Club Owners, Administrators, And Authorized Agent Staff."
        onBack={() => navigate(`/clubs/${clubId}`)}
      />
    );
  }

  const accessLabel = access.isPlatformStaff ? 'Platform Staff' : roleLabel(access.clubRole);
  const alerts = (overview?.alerts ?? []).filter((alert) => toolPath.has(alert.tool));
  const counts = overview?.counts ?? null;

  return (
    <div className={styles.page}>
      <SpadeConsole
        className={styles.hero}
        eyebrow="Club Command Network"
        title="Club Operations"
        titleAs="h1"
        pill={accessLabel}
        foot="plates"
        plates={{
          secondary: { label: 'Open Club Lobby', onClick: () => navigate(`/clubs/${clubId}`) },
          primary: {
            label: 'View Dashboard',
            onClick: () => navigate(`/clubs/${clubId}/dashboard-full`),
          },
        }}
      >
        <p className={styles.lede}>
          One Controlled Entry Point For The People, Money, Safety, And House Systems You Are
          Authorized To Operate.
        </p>
        <div className={styles.freshness}>
          <button
            type="button"
            className={styles.refresh}
            onClick={refresh}
            disabled={overviewLoading || overviewDenied || !clubUUID}
            aria-label="Refresh Club Readings"
          >
            {overviewLoading ? 'Reading' : 'Refresh'}
          </button>
          <span className={styles.freshnessNote} role="status">
            {freshnessLabel({
              error: !!overviewError,
              denied: overviewDenied,
              loading: overviewLoading,
              refreshedAt,
              now: tick,
            })}
          </span>
        </div>

        {tiles.length === 0 && overviewLoading && (
          <section className={styles.pulse} aria-label="Reading The Club" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((slot) => (
              <article className={`${styles.pulseTile} ${styles.pulseSkeleton}`} key={slot}>
                <span className={styles.skeletonLabel} aria-hidden="true" />
                <span className={styles.skeletonValue} aria-hidden="true" />
              </article>
            ))}
          </section>
        )}

        {tiles.length > 0 && (
          <section className={styles.pulse} aria-label="Live Club Readings">
            {tiles.map((tile) => (
              <article className={styles.pulseTile} key={tile.id}>
                <p className={styles.pulseLabel}>{tile.label}</p>
                <p className={styles.pulseValue}>{tile.value}</p>
                {tile.sub && <p className={styles.pulseSub}>{tile.sub}</p>}
              </article>
            ))}
          </section>
        )}

        {alerts.length > 0 && (
          <section
            className={styles.alerts}
            aria-label="Work Waiting In This Club"
            aria-live="polite"
          >
            <p className={styles.alertsTitle}>Waiting For You</p>
            <ul className={styles.alertList}>
              {alerts.map((alert) => {
                const destination = toolPath.get(alert.tool);
                const body = (
                  <>
                    <span
                      className={`${styles.alertPip} ${styles[alert.severity]}`}
                      aria-hidden="true"
                    />
                    <span className={styles.alertTitle}>{titleCase(alert.title)}</span>
                    {alert.count > 0 && (
                      <span className={styles.alertCount}>{formatInt(alert.count)}</span>
                    )}
                    {destination && (
                      <span className={styles.alertArrow} aria-hidden="true">
                        &rsaquo;
                      </span>
                    )}
                  </>
                );
                return (
                  <li key={alert.id}>
                    {destination ? (
                      <Link className={styles.alertRow} to={destination}>
                        {body}
                      </Link>
                    ) : (
                      <span className={styles.alertRow}>{body}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </SpadeConsole>

      <div className={styles.groups}>
        {groups.map((group) => {
          const groupTotal = group.items.reduce(
            (total, item) => total + getClubOperationBadge(item, counts),
            0
          );
          return (
            <SpadeConsole
              className={styles.group}
              key={group.id}
              aria-labelledby={`ops-${group.id}`}
              titleId={`ops-${group.id}`}
              eyebrow={group.eyebrow}
              title={group.label}
              crest="flat"
              foot="foot"
            >
              <p className={styles.groupDescription}>{group.description}</p>
              {groupTotal > 0 && (
                <p className={styles.groupSignal}>{formatInt(groupTotal)} Waiting</p>
              )}
              <ul className={styles.toolGrid}>
                {group.items.map((item) => {
                  const descriptionId = `ops-${item.id}-description`;
                  /* A tile shows its OWN queue. The group panel above carries
                     the rollup, so passing no scope here keeps the same number
                     from appearing three times in one group. */
                  const signal = getClubOperationBadge(item, counts);
                  return (
                    <li key={item.id}>
                      <Link className={styles.tool} to={item.path} aria-describedby={descriptionId}>
                        <span className={styles.toolLabel}>{item.label}</span>
                        {signal > 0 ? (
                          <span className={styles.toolBadge} aria-label={`${signal} Waiting`}>
                            {formatInt(signal)}
                          </span>
                        ) : (
                          <span className={styles.toolArrow} aria-hidden="true">
                            &rsaquo;
                          </span>
                        )}
                        <span className={styles.toolDescription} id={descriptionId}>
                          {item.description}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </SpadeConsole>
          );
        })}
      </div>
    </div>
  );
}
