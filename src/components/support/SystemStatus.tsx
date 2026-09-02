/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SYSTEM STATUS — Health Indicator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows the same live Supabase readiness check as /health.
 */

import { useSystemHealth } from '../../hooks/useSystemHealth';
import styles from './SystemStatus.module.css';

export function SystemStatus() {
  const { health, isChecking, retry } = useSystemHealth();
  const isOperational = health?.status === 'ok';

  return (
    <section
      className={`${styles.status} ${!isChecking && !isOperational ? styles.degraded : ''}`}
      aria-label="Club Arena System Status"
      aria-live="polite"
    >
      <div className={styles.signal} aria-hidden="true">
        <span />
      </div>
      <div className={styles.copy}>
        <span className={styles.label}>Live Platform Check</span>
        <strong>
          {isChecking
            ? 'Checking Systems'
            : isOperational
              ? 'Systems Operational'
              : 'Service Degraded'}
        </strong>
        <span>
          {isChecking
            ? 'Confirming The Live Data Circuit'
            : isOperational
              ? `Supabase Responded In ${health?.latencyMs ?? 0} Ms`
              : 'The Data Circuit Did Not Respond Normally'}
        </span>
      </div>
      {!isChecking && !isOperational && (
        <button type="button" onClick={retry}>
          Check Again
        </button>
      )}
    </section>
  );
}

export default SystemStatus;
