/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGES PAGE — Club-Internal Messaging Hub (SNGINE-inspired)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Club-scoped messaging - NOT connected to smarter.poker social messaging
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import ConversationList from '../components/messaging/ConversationList';
import MessageThread from '../components/messaging/MessageThread';
import ClubBottomNav from '../components/club/ClubBottomNav';
import './MessagesPage.css';

export default function MessagesPage() {
  useEffect(() => {
    document.title = 'Messages | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const { clubId: routeClubId, conversationId } = useParams<{
    clubId?: string;
    conversationId?: string;
  }>();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    conversationId || null
  );
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  // Fetch actual user role for this club so ClubBottomNav shows correct tabs
  useEffect(() => {
    if (!clubId || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', clubId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!cancelled && data?.role) {
          setUserRole(data.role as typeof userRole);
        }
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id]);

  // Note: clubId is optional now - ConversationList shows both personal and club widget

  const handleSelectConversation = (id: string) => {
    setSelectedConversation(id);
    if (isMobile) {
      navigate(`/messages/${id}`);
    }
  };

  const handleBack = () => {
    setSelectedConversation(null);
    if (isMobile) {
      navigate('/messages');
    }
  };

  // Mobile: Show either list or thread
  if (isMobile) {
    if (selectedConversation || conversationId) {
      return (
        <div className="messages-page full-height">
          <MessageThread
            conversationId={selectedConversation || conversationId!}
            onBack={handleBack}
          />
        </div>
      );
    }
    return (
      <div className="messages-page">
        <div className="messages-content">
          <ConversationList
            clubId={clubId}
            onSelectConversation={handleSelectConversation}
            selectedId={selectedConversation || undefined}
          />
        </div>
        {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
      </div>
    );
  }

  // Desktop: Split view
  return (
    <div className="messages-page">
      <div className="messages-split-view">
        <aside className="messages-sidebar">
          <ConversationList
            clubId={clubId}
            onSelectConversation={handleSelectConversation}
            selectedId={selectedConversation || undefined}
          />
        </aside>
        <main className="messages-main">
          {selectedConversation ? (
            <MessageThread conversationId={selectedConversation} onBack={handleBack} />
          ) : (
            <div className="messages-empty">
              <span className="empty-icon">◈</span>
              <p>Select a conversation to start chatting</p>
            </div>
          )}
        </main>
      </div>
      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}
