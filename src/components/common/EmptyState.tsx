/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎭 CLUB ARENA — Empty State Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Reusable component for displaying empty data scenarios with call-to-action
 */

import { ReactNode } from 'react';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
    icon?: string;
    title: string;
    description?: string;
    action?: {
        label: string;
        onClick: () => void;
    };
    children?: ReactNode;
}

export function EmptyState({ icon = '🎰', title, description, action, children }: EmptyStateProps) {
    return (
        <div className={styles.container}>
            <div className={styles.content}>
                <span className={styles.icon}>{icon}</span>
                <h3 className={styles.title}>{title}</h3>
                {description && <p className={styles.description}>{description}</p>}
                {action && (
                    <button className={styles.actionButton} onClick={action.onClick}>
                        {action.label}
                    </button>
                )}
                {children}
            </div>
        </div>
    );
}

// Preset empty states for common scenarios
export function NoClubsEmpty({ onCreate }: { onCreate: () => void }) {
    return (
        <EmptyState
            icon="♠"
            title="No Clubs Yet"
            description="Create your first club or join an existing one to start playing"
            action={{ label: 'Create a Club', onClick: onCreate }}
        />
    );
}

export function NoTablesEmpty({ onCreate }: { onCreate: () => void }) {
    return (
        <EmptyState
            icon="🎴"
            title="No Active Tables"
            description="Create a table to start a game"
            action={{ label: 'Create Table', onClick: onCreate }}
        />
    );
}

export function NoMembersEmpty({ onInvite }: { onInvite: () => void }) {
    return (
        <EmptyState
            icon="👥"
            title="No Members Yet"
            description="Invite players to join your club"
            action={{ label: 'Invite Players', onClick: onInvite }}
        />
    );
}

export function NoHistoryEmpty() {
    return (
        <EmptyState
            icon="📜"
            title="No Hand History"
            description="Your played hands will appear here"
        />
    );
}

export function LoadingState({ message = 'Loading...' }: { message?: string }) {
    return (
        <div className={styles.loadingContainer}>
            <div className={styles.spinner} />
            <p className={styles.loadingText}>{message}</p>
        </div>
    );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <EmptyState
            icon="⚠️"
            title="Something went wrong"
            description={message}
            action={onRetry ? { label: 'Try Again', onClick: onRetry } : undefined}
        />
    );
}
