/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🟢 SYSTEM STATUS — Health Indicator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows system health status.
 * - Green/Yellow/Red indicator
 * - Maintenance messages
 */

import React from 'react';
import './SystemStatus.css';

export type SystemState = 'operational' | 'degraded' | 'maintenance';

export interface SystemStatusProps {
    status: SystemState;
    message?: string;
}

export function SystemStatus({ status, message }: SystemStatusProps) {
    // If operational and no message, show nothing or minimal dot
    if (status === 'operational' && !message) return null;

    return (
        <div className={`system-status-bar status-${status}`}>
            <div className="status-indicator">
                <span className="status-dot-pulse" />
            </div>
            <span className="status-text">
                {status === 'maintenance' ? 'System Maintenance' :
                    status === 'degraded' ? 'System Issues' :
                        'System Operational'}
            </span>
            {message && <span className="status-message"> — {message}</span>}
        </div>
    );
}

export default SystemStatus;
