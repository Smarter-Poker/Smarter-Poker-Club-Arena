import { useEffect, useRef } from 'react';
import { ownProfile } from '../lib/ownProfile';
import { readSettingsPageCache, writeSettingsPageCache } from '../lib/settingsPageCache';
import { PROFILE_PREFERENCE_DEFAULTS as defaults } from '../lib/profilePreferenceDefaults';
import { masterBus } from '../core/MasterBus';
import { useUserStore } from '../stores/useUserStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { resolveVipStatus } from '../utils/vipStatus';
import { reportError } from '../utils/errorReporter';
import { useMasterBusBroadcastChannel } from './useMasterBusBroadcastChannel';

type Domain = 'metadata' | 'settings' | 'diamonds';
const DOMAINS: Domain[] = ['metadata', 'settings', 'diamonds'];
const SOURCE = 'profile-account';
const COLUMNS: Record<Domain, string> = {
  metadata: `${PLAYER_NAME_COLUMNS},bio,player_tags,login_streak,is_vip,vip_tier,vip_expires_at`,
  settings:
    'profile_theme:settings->theme,achievement_notifications:settings->achievementNotifications,settlement_alerts:settings->settlementAlerts',
  diamonds: 'diamonds',
};

/** One owner-only carrier, never a row replication subscription or a polling loop. */
export function ProfileAccountSync() {
  const userId = useUserStore((state) => state.user?.id);
  const refreshRef = useRef<(domains: Domain[], notify?: boolean) => void>(() => {});

  useEffect(() => {
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: light)')
        : null;
    const changed = () => {
      const store = useSettingsStore.getState();
      if (store.themePreference === 'auto')
        store.receiveTheme('auto', useUserStore.getState().user?.id);
    };
    changed();
    media?.addEventListener('change', changed);
    return () => media?.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    if (!userId) return;
    let alive = true,
      epoch = 0,
      reading = false,
      scheduled = false,
      notifyMetadata = false;
    const pending = new Set<Domain>();
    const versions: Record<Domain, number> = { metadata: 0, settings: 0, diamonds: 0 };
    let controller: AbortController | null = null;
    const owns = () => alive && useUserStore.getState().user?.id === userId;

    const read = async () => {
      scheduled = false;
      if (!owns() || reading || document.visibilityState === 'hidden' || !pending.size) return;
      reading = true;
      const domains = [...pending];
      pending.clear();
      const announce = notifyMetadata;
      notifyMetadata = false;
      const requestedEpoch = epoch;
      const requestedVersions = { ...versions };
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => {
        request.abort();
        if (owns() && epoch === requestedEpoch)
          reportError(
            new Error('Account profile read timed out'),
            'ProfileAccountSync.Read_failed'
          );
      }, 15_000);
      const current = (domain: Domain) =>
        owns() &&
        epoch === requestedEpoch &&
        versions[domain] === requestedVersions[domain] &&
        !request.signal.aborted;
      try {
        /* The player's own row, through the owner door (ruling 25): the
           `diamonds` domain is their balance, which only its owner reads, and
           a column grant is not per row. */
        const result = await ownProfile(userId)
          .select(`id,${domains.map((domain) => COLUMNS[domain]).join(',')}`)
          .abortSignal(request.signal)
          .maybeSingle();
        if (result.error) throw result.error;
        const row = result.data as unknown as Record<string, unknown> | null;
        if (!row || row.id !== userId) throw new Error('Account profile unavailable');
        if (domains.includes('metadata') && current('metadata')) {
          const owner = useUserStore.getState().user;
          if (owner?.id === userId) {
            const names = Object.fromEntries(
              PLAYER_NAME_COLUMNS.split(',').map((key) => {
                const column = key.trim();
                return [column, row[column]];
              })
            );
            useUserStore.setState({
              user: { ...owner, ...names, vip_status: resolveVipStatus(row) },
            });
            if (announce)
              masterBus.emit('PROFILE_UPDATED', { userId, updates: {}, source: SOURCE });
          }
        }
        if (domains.includes('settings') && current('settings')) {
          const saved = readSettingsPageCache(userId) || {};
          const next: Record<string, unknown> = { ...saved };
          const preference =
            row.profile_theme === 'light' ||
            row.profile_theme === 'dark' ||
            row.profile_theme === 'auto'
              ? row.profile_theme
              : defaults.theme;
          next.theme = preference;
          next.achievementNotifications =
            typeof row.achievement_notifications === 'boolean'
              ? row.achievement_notifications
              : defaults.achievementNotifications;
          next.settlementAlerts =
            typeof row.settlement_alerts === 'boolean'
              ? row.settlement_alerts
              : defaults.settlementAlerts;
          if (!writeSettingsPageCache(userId, next)) {
            reportError(
              new Error('Account settings cache is unavailable'),
              'ProfileAccountSync.Preference_cache_failed'
            );
          }
          useSettingsStore.getState().receiveTheme(preference, userId);
          masterBus.emit('SETTINGS_UPDATED', { userId, settings: next, source: SOURCE });
        }
        if (domains.includes('diamonds') && current('diamonds')) {
          if (!Number.isSafeInteger(row.diamonds) || Number(row.diamonds) < 0)
            throw new Error('Invalid account diamond balance');
          masterBus.emit('DIAMOND_BALANCE_CHANGED', {
            userId,
            newBalance: Number(row.diamonds),
            delta: 0,
            source: SOURCE,
          });
        }
      } catch (error) {
        if (owns() && epoch === requestedEpoch && !request.signal.aborted) {
          reportError(error, 'ProfileAccountSync.Read_failed');
        }
      } finally {
        window.clearTimeout(timeout);
        if (controller === request) controller = null;
        reading = false;
        if (owns() && pending.size) schedule();
      }
    };
    const schedule = () => {
      if (!scheduled && !reading && owns()) {
        scheduled = true;
        queueMicrotask(() => {
          void read();
        });
      }
    };
    const refresh = (domains: Domain[], notify = true) => {
      if (!owns()) return;
      for (const domain of domains) {
        versions[domain] += 1;
        pending.add(domain);
      }
      notifyMetadata ||= notify && domains.includes('metadata');
      schedule();
    };
    refreshRef.current = refresh;
    const visible = () => {
      if (document.visibilityState !== 'hidden') refresh(DOMAINS);
    };
    const off = [
      masterBus.subscribe('PROFILE_UPDATED', ({ payload }) => {
        if (payload.userId === userId && payload.source !== SOURCE) refresh(['metadata'], false);
      }),
      masterBus.subscribe('UI_THEME_CHANGED', ({ payload }) => {
        if (payload.key === 'theme' && (!payload.userId || payload.userId === userId))
          versions.settings += 1;
      }),
      masterBus.subscribe('SETTINGS_UPDATED', ({ payload }) => {
        if (payload.source !== SOURCE && (!payload.userId || payload.userId === userId))
          versions.settings += 1;
      }),
      masterBus.subscribe('DIAMOND_BALANCE_CHANGED', ({ payload }) => {
        if (payload.source !== SOURCE && (!payload.userId || payload.userId === userId))
          versions.diamonds += 1;
      }),
      useUserStore.subscribe((next, previous) => {
        if (next.user?.id === previous.user?.id) return;
        epoch += 1;
        controller?.abort();
        pending.clear();
        if (next.user?.id === userId) refresh(DOMAINS);
      }),
    ];
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    refresh(DOMAINS);
    return () => {
      alive = false;
      epoch += 1;
      controller?.abort();
      pending.clear();
      off.forEach((stop) => stop());
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
      if (refreshRef.current === refresh) refreshRef.current = () => {};
    };
  }, [userId]);

  useMasterBusBroadcastChannel({
    channelName: userId ? `profile-account:${userId}` : null,
    event: 'account_changed',
    private: true,
    onPayload: (message) => {
      const payload = (message as { payload?: { user_id?: unknown; domains?: unknown } })?.payload;
      if (!userId || payload?.user_id !== userId || !Array.isArray(payload.domains)) return;
      const domains = payload.domains.filter((domain): domain is Domain =>
        DOMAINS.includes(domain as Domain)
      );
      if (domains.length) refreshRef.current(domains);
    },
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') refreshRef.current(DOMAINS);
    },
  });
  return null;
}
