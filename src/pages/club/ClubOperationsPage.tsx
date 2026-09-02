import type { CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getClubOperationGroups } from '../../config/clubOperationsNavigation';
import { ErrorState, LoadingState, PermissionState } from '../../components/common/EmptyState';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import { roleLabel } from '../../types/clubRoles';
import styles from './ClubOperationsPage.module.css';

type ArtStyle = CSSProperties & { '--operations-art': string };

export default function ClubOperationsPage() {
  const { clubId = '' } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const access = useClubNavigationAccess(clubId);

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

  const groups = getClubOperationGroups(clubId, access);
  const accessLabel = access.isPlatformStaff ? 'Platform Staff' : roleLabel(access.clubRole);

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
        </div>
        <div className={styles.heroMachine} aria-hidden="true">
          <div className={styles.heroMachineCore} />
          <span className={styles.heroMachineLabel}>Command Deck</span>
        </div>
      </header>

      <div className={styles.groups}>
        {groups.map((group) => {
          const artStyle: ArtStyle = { '--operations-art': `url("${group.art}")` };
          return (
            <section className={styles.group} key={group.id} aria-labelledby={`ops-${group.id}`}>
              <div className={styles.groupIdentity}>
                <span className={styles.groupNode} aria-hidden="true" />
                <p>{group.eyebrow}</p>
                <h2 id={`ops-${group.id}`}>{group.label}</h2>
                <p className={styles.groupDescription}>{group.description}</p>
                <div className={styles.groupArt} style={artStyle} aria-hidden="true" />
              </div>
              <ul className={styles.toolGrid}>
                {group.items.map((item) => {
                  const descriptionId = `ops-${item.id}-description`;
                  return (
                    <li key={item.id}>
                      <Link className={styles.tool} to={item.path} aria-describedby={descriptionId}>
                        <span className={styles.toolLabel}>{item.label}</span>
                        <span className={styles.toolArrow} aria-hidden="true">
                          ›
                        </span>
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
