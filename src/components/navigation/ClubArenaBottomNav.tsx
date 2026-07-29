/**
 * ClubArenaBottomNav — Mobile bottom navigation bar
 * Ported from Hub's ClubArenaBottomNav.js → CA TSX
 *
 * Differences from Hub:
 *  - Uses react-router-dom Link instead of next/link
 *  - Uses masterBus instead of eventBus
 *  - Uses direct Supabase instead of Hub auth
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { reportError } from '../../utils/errorReporter';

const FB = {
  primary: '#2374E1',
  cardBg: '#242526',
  textSecondary: '#B0B3B8',
  border: '#3E4042',
};

const iconStyle: React.CSSProperties = { width: 24, height: 24 };

const LobbyIcon = () => (
  <svg style={iconStyle} viewBox="0 0 24 24" fill="currentColor">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
  </svg>
);

const MessagesIcon = () => (
  <svg style={iconStyle} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2z" />
  </svg>
);

const PlayersIcon = () => (
  <svg style={iconStyle} viewBox="0 0 24 24" fill="currentColor">
    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
  </svg>
);

const CashierIcon = () => (
  <svg style={iconStyle} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2z" />
  </svg>
);

const DataIcon = () => (
  <svg style={iconStyle} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
  </svg>
);

const AdminIcon = () => (
  <svg style={iconStyle} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>
);

interface ClubArenaBottomNavProps {
  clubId: string | null;
  userRole?: string | null;
}

export default function ClubArenaBottomNav({ clubId, userRole }: ClubArenaBottomNavProps) {
  const [unreadCount, setUnreadCount] = useState(0);
  const location = useLocation();
  const { user } = useAuthUser();

  const fetchUnread = useCallback(async () => {
    if (!clubId || !user?.id) return;
    try {
      const { count } = await supabase
        .from('social_conversation_participants')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gt('unread_count', 0);

      setUnreadCount(count || 0);
    } catch (e) {
      reportError(e, 'ClubArenaBottomNav.Failed_to_fetch_unread');
    }
  }, [clubId, user?.id]);

  // Hook calls at top level
  useMasterBusSubscription('MESSAGE_RECEIVED', () => setUnreadCount((prev) => prev + 1));
  useMasterBusSubscription('DATA_MUTATED', (payload) => {
    const entity = (payload as any)?.entity;
    if (entity === 'message_read' || entity === 'message_sent') fetchUnread();
  });

  useEffect(() => {
    if (!clubId || !user?.id) return;
    fetchUnread();
  }, [clubId, user?.id, fetchUnread]);

  if (!clubId) return null;

  const activePage = (() => {
    const path = location.pathname.toLowerCase();
    if (path.includes('messages')) return 'messages';
    if (path.includes('members') || path.includes('players')) return 'players';
    if (path.includes('cashier')) return 'cashier';
    if (path.includes('stats') || path.includes('data')) return 'data';
    if (path.includes('admin')) return 'admin';
    return 'lobby';
  })();

  // Short labels prevent truncation at 375px with 6 tabs (CLAUDE.md §9).
  const navItems = [
    { key: 'lobby', label: 'Lobby', to: `/club/${clubId}`, Icon: LobbyIcon },
    {
      key: 'messages',
      label: 'Msgs',
      to: `/club/${clubId}/messages`,
      Icon: MessagesIcon,
      badge: unreadCount,
    },
    { key: 'players', label: 'Players', to: `/club/${clubId}/members`, Icon: PlayersIcon },
    { key: 'cashier', label: 'Cash', to: `/club/${clubId}/cashier`, Icon: CashierIcon },
    { key: 'data', label: 'Data', to: `/club/${clubId}/stats`, Icon: DataIcon },
    ...(!userRole || userRole === 'owner' || userRole === 'admin'
      ? [{ key: 'admin', label: 'Admin', to: `/club/${clubId}/admin`, Icon: AdminIcon }]
      : []),
  ];

  return (
    <nav
      aria-label="Club navigation"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: FB.cardBg,
        borderTop: `1px solid ${FB.border}`,
        boxShadow: '0 -2px 10px rgba(0,0,0,0.3)',
        // Keep the last row of tabs clear of the iPhone home indicator.
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-around', padding: '6px 0' }}>
        {navItems.map(({ key, label, to, Icon, badge }) => {
          const isActive = activePage === key;
          return (
            <Link
              key={key}
              to={to}
              aria-current={isActive ? 'page' : undefined}
              aria-label={
                (badge ?? 0) > 0 ? `${label}, ${badge} unread` : label
              }
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                flex: 1,
                minHeight: 44,
                padding: '8px 4px',
                textDecoration: 'none',
                color: isActive ? FB.primary : FB.textSecondary,
                position: 'relative',
              }}
            >
              <Icon />
              {(badge ?? 0) > 0 && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 12,
                    background: '#E41E3F',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 'bold',
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `2px solid ${FB.cardBg}`,
                  }}
                >
                  {badge! > 9 ? '9+' : badge}
                </div>
              )}
              <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
