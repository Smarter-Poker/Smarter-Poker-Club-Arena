import MessengerDock from './dock/MessengerDock';
import './dock/MessengerDock.css';
import { supabase, getAuthUser } from '../../lib/supabase';
import { getFreshAccessToken } from '../../lib/authToken';
import { masterBus } from '../../core/MasterBus';
import { publicOrigin } from '../../lib/appBase';
import { leaveForHub } from '../../lib/openExternal';
import { broadcastSync, listenBroadcast } from './dock/broadcastDock.mjs';

import { requestForDockActor } from './dock/bindDockRequest.mjs';
const services = {
  supabase,
  getAuthUser,
  broadcastSync,
  listenBroadcast,
  request: (
    path: string,
    options: RequestInit & { actorId?: string; currentActor?: () => string | null } = {}
  ) => requestForDockActor(`${publicOrigin()}${path}`, options, getFreshAccessToken),
  getPreferences: async (actorId: string) => {
    const { data, error } = await supabase
      .from('user_notification_preferences')
      .select('messenger_alerts')
      .eq('user_id', actorId)
      .maybeSingle();
    if (error) throw error;
    return {
      notifications: data?.messenger_alerts !== false,
      readReceipts: localStorage.getItem('messenger-read-receipts') !== 'false',
    };
  },
  openMessenger: (id?: string) => {
    const path = `/hub/messenger${id ? `?conversation=${encodeURIComponent(id)}` : ''}`;
    if (Number(document.body?.dataset.caLiveTables || '0') > 0) {
      masterBus.emit('OPEN_HUB_TAB', { path });
      return;
    }
    leaveForHub(path);
  },
};
export default function MessengerDockHost() {
  return <MessengerDock services={services} />;
}
