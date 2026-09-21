import { useEffect, useState } from 'react';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { useToast } from '../../common/Toast';
import { capture } from '../../../lib/analytics';
import {
  enablePush,
  hasLocalSubscription,
  isIos,
  isIosStandalonePwa,
  isWebPushSupported,
  notificationPermission,
} from '../../../lib/pushClient';
import {
  getDailyMissionAlertPreference,
  setDailyMissionAlertPreference,
} from '../../../services/DailyMissionNotificationService';
import {
  dailyMissionReasonCode,
  recordDailyMissionOperation,
} from '../../../services/DailyMissionTelemetryService';
import { reportError } from '../../../utils/errorReporter';
import { CasinoControlIcon } from '../CasinoControlIcon';

export function MissionAlertsPanel({ userId }: { userId: string }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getDailyMissionAlertPreference(userId), hasLocalSubscription()])
      .then(([preference, subscribed]) => {
        if (cancelled) return;
        setEnabled(preference.enabled);
        setDeviceConnected(subscribed);
        setError(null);
      })
      .catch((err) => {
        reportError(err, 'DailyChallengesPage.alert_preference_load_failed');
        if (!cancelled) setError('Challenge Alert Status Is Temporarily Unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  /** Keep this directly on the click path so iOS preserves the permission gesture. */
  const enableAlerts = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const startedAt = performance.now();
    const pushResultPromise = enablePush();
    try {
      const pushResult = await pushResultPromise;
      if (!pushResult.ok) throw new Error(pushResult.error || 'Push enrollment failed');
      const preference = await setDailyMissionAlertPreference(userId, true);
      setEnabled(preference.enabled);
      setDeviceConnected(true);
      toast.success('Daily Challenge Reset Alerts Are On For This Device');
      capture('daily_mission_alerts_changed', { enabled: true, surface: 'daily_missions' });
      recordDailyMissionOperation({
        userId,
        event: 'alerts_enabled',
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      reportError(err, 'DailyChallengesPage.alert_enable_failed');
      const message = 'Challenge Alerts Could Not Be Enabled. Please Try Again.';
      setError(message);
      toast.error(message);
      recordDailyMissionOperation({
        userId,
        event: 'alerts_failed',
        durationMs: performance.now() - startedAt,
        reasonCode: dailyMissionReasonCode(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const disableAlerts = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const startedAt = performance.now();
    try {
      const preference = await setDailyMissionAlertPreference(userId, false);
      setEnabled(preference.enabled);
      toast.success('Daily Challenge Reset Alerts Are Off');
      capture('daily_mission_alerts_changed', { enabled: false, surface: 'daily_missions' });
      recordDailyMissionOperation({
        userId,
        event: 'alerts_disabled',
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      reportError(err, 'DailyChallengesPage.alert_disable_failed');
      setError('Challenge Alerts Could Not Be Turned Off. Please Try Again.');
      toast.error('Challenge Alerts Could Not Be Turned Off');
      recordDailyMissionOperation({
        userId,
        event: 'alerts_failed',
        durationMs: performance.now() - startedAt,
        reasonCode: dailyMissionReasonCode(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const permission = notificationPermission();
  const unsupportedIos = !isWebPushSupported() && isIos() && !isIosStandalonePwa();
  const unsupportedBrowser = !isWebPushSupported() && !unsupportedIos;
  const deviceNeedsConnection = enabled && !deviceConnected;
  const enrollmentBlocked = permission === 'denied' || unsupportedIos || unsupportedBrowser;
  const status = loading
    ? 'Checking Alert Link'
    : enabled && deviceConnected
      ? 'On For This Device'
      : deviceNeedsConnection
        ? 'Preference On, Device Disconnected'
        : permission === 'denied'
          ? 'Blocked In Browser Settings'
          : unsupportedIos
            ? 'Install App To Enable'
            : unsupportedBrowser
              ? 'Unavailable In This Browser'
              : 'Off Until You Opt In';

  return (
    <aside
      className={styles.alertConsole}
      aria-labelledby="mission-alerts-title"
      aria-busy={loading || busy}
    >
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.alertIcon} aria-hidden="true">
        <CasinoControlIcon
          variant={enabled && deviceConnected ? 'alert-on' : 'alert-off'}
          state={
            loading || busy
              ? 'pending'
              : enabled && deviceConnected
                ? 'active'
                : error
                  ? 'error'
                  : 'idle'
          }
          size="lg"
          className={styles.alertControlIcon}
        />
      </div>
      <div className={styles.alertCopy}>
        <span className={styles.panelLabel}>Daily Cycle Utility / Optional Challenge Alerts</span>
        <h2 id="mission-alerts-title">Daily Reset Alerts</h2>
        <p>
          Get One Alert When A Fresh Daily Challenge Set Opens. This Is Off By Default And Does Not
          Change Seat, Message, Tournament, Or Club Alerts.
        </p>
        {unsupportedIos && (
          <small>
            Add Smarter Poker To Your Home Screen, Then Open The Installed App To Enable.
          </small>
        )}
        {unsupportedBrowser && (
          <small>
            This Browser Does Not Support Challenge Alerts. Use A Supported Browser Or Device.
          </small>
        )}
        {permission === 'denied' && (
          <small>
            Allow Notifications For Smarter Poker In Your Browser Settings, Then Reload.
          </small>
        )}
        {error && (
          <small className={styles.alertError} role="alert">
            {error}
          </small>
        )}
      </div>
      <div className={styles.alertControls}>
        <span className={enabled && deviceConnected ? styles.alertStatusOn : styles.alertStatus}>
          {status}
        </span>
        <button
          type="button"
          className={styles.alertButton}
          onClick={enabled && deviceConnected ? disableAlerts : enableAlerts}
          disabled={loading || busy || (enrollmentBlocked && (!enabled || deviceNeedsConnection))}
        >
          <CasinoControlIcon
            variant={enabled && deviceConnected ? 'alert-off' : 'alert-on'}
            state={
              loading || busy
                ? 'pending'
                : enrollmentBlocked && (!enabled || deviceNeedsConnection)
                  ? 'disabled'
                  : 'active'
            }
            size="sm"
          />
          {busy
            ? 'Updating...'
            : enabled && deviceConnected
              ? 'Turn Off Challenge Alerts'
              : deviceNeedsConnection
                ? 'Reconnect This Device'
                : 'Turn On Challenge Alerts'}
        </button>
        {deviceNeedsConnection && (
          <button
            type="button"
            className={styles.alertSecondaryButton}
            onClick={disableAlerts}
            disabled={loading || busy}
          >
            <CasinoControlIcon
              variant="alert-off"
              state={loading || busy ? 'pending' : 'idle'}
              size="sm"
            />
            Turn Off Without Reconnecting
          </button>
        )}
      </div>
    </aside>
  );
}
