import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import { formatChips, formatInt } from '../../utils/clubDashboard';
import styles from './ClubOperationsPage.module.css';

type ArtStyle = CSSProperties & { '--operations-art': string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FRESHNESS_TICK_MS = 15_000;

/**
 * Title Cased "how long ago". `formatAgo` in utils/clubDashboard returns
 * "just now" / "12s ago", which is correct for the pages already using it and
 * wrong for a page whose every word is capitalized, so the casing lives here
 * rather than changing a helper five other surfaces read.
 */
export function freshnessLabel(then: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 10) return 'Updated Just Now';
  if (secs < 60) return `Updated ${secs}s Ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Updated ${mins}m Ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Updated ${hours}h Ago`;
  return `Updated ${Math.floor(hours / 24)}d Ago`;
}

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
    if (typeof k.rake_today === 'number') {
      list.push({ id: 'rake', label: 'Fees Today', value: formatChips(k.rake_today) });
    }
    if (typeof k.club_bank === 'number') {
      list.push({
        id: 'bank',
        label: 'Club Bank',
        value: formatChips(k.club_bank),
        sub:
          typeof k.member_chips === 'number'
            ? `${formatChips(k.member_chips)} In Member Wallets`
            : undefined,
      });
    }
    return list;
  }, [overview]);

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
  const alerts = overview?.alerts ?? [];
  const counts = overview?.counts ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.signalRow}>
            <span className={styles.signal} aria-hidden="true" />
            <span>Live Permission Map</span>
            <span className={styles.accessBadge}>{accessLabel}</span>
          </div>
          <p className={styles.eyebrow}>Club Command Network</p>
          <h1>Club Operations</h1>
          <p className={styles.lede}>
            One Controlled Entry Point For The People, Money, Safety, And House Systems You Are
            Authorized To Operate.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} to={`/clubs/${clubId}`}>
              Open Club Lobby
            </Link>
            <Link className={styles.secondaryAction} to={`/clubs/${clubId}/dashboard-full`}>
              View Dashboard
            </Link>
          </div>
          <div className={styles.freshness}>
            <button type="button" className={styles.refresh} onClick={refresh}>
              {overviewLoading ? 'Reading' : 'Refresh'}
            </button>
            <span className={styles.freshnessNote}>
              {overviewError
                ? 'Live Readings Unavailable'
                : refreshedAt
                  ? freshnessLabel(refreshedAt, tick)
                  : overviewLoading
                    ? 'Reading The Club'
                    : 'Awaiting First Reading'}
            </span>
          </div>
        </div>
        <div className={styles.heroMachine} aria-hidden="true">
          <div className={styles.heroMachineCore} />
          <span className={styles.heroMachineLabel}>Command Deck</span>
        </div>
      </header>

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
        <section className={styles.alerts} aria-label="Work Waiting In This Club">
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
                  <span className={styles.alertTitle}>{alert.title}</span>
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

      <div className={styles.groups}>
        {groups.map((group) => {
          const artStyle: ArtStyle = { '--operations-art': `url("${group.art}")` };
          const groupTotal = group.items.reduce(
            (total, item) => total + getClubOperationBadge(item, counts, group.items),
            0
          );
          return (
            <section className={styles.group} key={group.id} aria-labelledby={`ops-${group.id}`}>
              <div className={styles.groupIdentity}>
                <span className={styles.groupNode} aria-hidden="true" />
                <p>{group.eyebrow}</p>
                <h2 id={`ops-${group.id}`}>{group.label}</h2>
                <p className={styles.groupDescription}>{group.description}</p>
                {groupTotal > 0 && (
                  <p className={styles.groupSignal}>{formatInt(groupTotal)} Waiting</p>
                )}
                <div className={styles.groupArt} style={artStyle} aria-hidden="true" />
              </div>
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
