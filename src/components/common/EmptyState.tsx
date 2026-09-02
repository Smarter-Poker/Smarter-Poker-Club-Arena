/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Empty State Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Reusable component for displaying empty data scenarios with call-to-action
 */

import { ReactNode } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import styles from './EmptyState.module.css';

export type EmptyStateTone = 'empty' | 'error' | 'permission' | 'success';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  icon?: ReactNode;
  eyebrow?: string;
  tone?: EmptyStateTone;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  children?: ReactNode;
}

export function EmptyState({
  icon,
  eyebrow = 'Club Arena',
  tone = 'empty',
  title,
  description,
  action,
  secondaryAction,
  children,
}: EmptyStateProps) {
  const liveRole = tone === 'error' ? 'alert' : 'status';

  return (
    <section
      className={`${styles.container} ${styles[tone]}`}
      role={liveRole}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      <div className={styles.content}>
        <div className={styles.beacon} aria-hidden="true">
          <span className={styles.beaconCore}>{icon || 'SP'}</span>
        </div>
        <span className={styles.eyebrow}>{formatPopupText(eyebrow)}</span>
        <h3 className={styles.title}>{formatPopupText(title)}</h3>
        {description && <p className={styles.description}>{formatPopupText(description)}</p>}
        {(action || secondaryAction) && (
          <div className={styles.actions}>
            {action && (
              <button type="button" className={styles.actionButton} onClick={action.onClick}>
                {formatPopupText(action.label)}
              </button>
            )}
            {secondaryAction && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={secondaryAction.onClick}
              >
                {formatPopupText(secondaryAction.label)}
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

// Preset empty states for common scenarios
export function NoClubsEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon="CLUB"
      eyebrow="Club Network"
      title="No Clubs Yet"
      description="Create Your First Club Or Join An Existing One To Start Playing."
      action={{ label: 'Create Club', onClick: onCreate }}
    />
  );
}

export function NoTablesEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon="TABLE"
      eyebrow="Live Games"
      title="No Active Tables"
      description="Create A Table To Start A Game."
      action={{ label: 'Create Table', onClick: onCreate }}
    />
  );
}

export function NoMembersEmpty({ onInvite }: { onInvite: () => void }) {
  return (
    <EmptyState
      icon="PLAYER"
      eyebrow="Club Roster"
      title="No Members Yet"
      description="Invite Players To Join Your Club."
      action={{ label: 'Invite Players', onClick: onInvite }}
    />
  );
}

export function NoHistoryEmpty() {
  return (
    <EmptyState
      icon="HAND"
      eyebrow="Hand Archive"
      title="No Hand History"
      description="Your Played Hands Will Appear Here."
    />
  );
}

export function LoadingState({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className={styles.loadingContainer} role="status" aria-live="polite">
      <div className={styles.loadingBeacon} aria-hidden="true">
        <span />
      </div>
      <p className={styles.loadingText}>{formatPopupText(message)}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon="FAULT"
      eyebrow="Recovery Required"
      tone="error"
      title="This Surface Could Not Load"
      description={message}
      action={onRetry ? { label: 'Try Again', onClick: onRetry } : undefined}
    />
  );
}

export function PermissionState({
  title = 'Access Restricted',
  description,
  onBack,
}: {
  title?: string;
  description: string;
  onBack?: () => void;
}) {
  return (
    <EmptyState
      icon="LOCK"
      eyebrow="Permission Gate"
      tone="permission"
      title={title}
      description={description}
      action={onBack ? { label: 'Go Back', onClick: onBack } : undefined}
    />
  );
}
