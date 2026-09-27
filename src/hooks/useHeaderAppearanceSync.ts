import { useEffect } from 'react';
import { masterBus } from '../core/MasterBus';
import { useUserStore } from '../stores/useUserStore';
import { useHeaderDataStore } from '../stores/useHeaderDataStore';
import { useMasterBusBroadcastChannel } from './useMasterBusBroadcastChannel';

/** One account signal for every route, including tables that hide the main header. */
export function HeaderAppearanceSync() {
  const userId = useUserStore((state) => state.user?.id);
  useEffect(() => {
    if (!userId) return;
    useHeaderDataStore.getState().loadOnce(userId);
    return () => {
      const store = useHeaderDataStore.getState();
      if (store._userId === userId) store.teardown();
    };
  }, [userId]);

  const refresh = () => {
    const store = useHeaderDataStore.getState();
    if (userId && store._userId === userId) {
      void store.refreshAppearance();
      masterBus.emit('PROFILE_UPDATED', { userId, updates: {}, source: 'appearance-signal' });
    }
  };
  useMasterBusBroadcastChannel({
    channelName: userId ? `profile-appearance:${userId}` : null,
    event: 'appearance_changed',
    private: true,
    onPayload: (message) => {
      if ((message as { payload?: { user_id?: unknown } })?.payload?.user_id === userId) refresh();
    },
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') refresh();
    },
  });
  return null;
}
