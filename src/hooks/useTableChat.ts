/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableChat — Chat State & Handlers
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx to reduce monolith size.
 * Manages chat messages, mute/collapse state, RoomService integration,
 * and reaction message parsing for TableReactions.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { triggerHaptic } from '../services/HapticService';
import { useMasterBusSubscription } from '../hooks/useMasterBusSubscription';
import type { ChatMessage } from '../components/table/TableChat';

// Reaction event type (shared with TableReactions)
export interface ReactionEvent {
  id: string;
  emoji: string;
  seatIndex: number;
  timestamp: number;
}

const REACTION_MSG_REGEX = /^\[REACTION:(.+):(\d+)\]$/;
const THROW_MSG_REGEX = /^\[THROW:.+:\d+\]$/;
const REACTION_LIFETIME_MS = 2500;

export interface UseTableChatReturn {
  chatMessages: ChatMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  isChatCollapsed: boolean;
  setIsChatCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  isChatMuted: boolean;
  setIsChatMuted: React.Dispatch<React.SetStateAction<boolean>>;
  handleSendChatMessage: (message: string) => void;
  // Reaction parsing
  activeReactions: ReactionEvent[];
  parseIncomingMessage: (content: string, senderId: string) => boolean;
}

export function useTableChat(
  tableId: string | undefined,
  userId: string,
  heroName: string
): UseTableChatReturn {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatCollapsed, setIsChatCollapsed] = useState(true);
  const [isChatMuted, setIsChatMuted] = useState(false);
  const [activeReactions, setActiveReactions] = useState<ReactionEvent[]>([]);
  const reactionIdRef = useRef(0);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Fetch history and listen to Supabase real-time chat (Unified architecture)
  useEffect(() => {
    if (!tableId) return;
    let isMounted = true;

    const loadMessages = async () => {
      const { data } = await supabase
        .from('table_chat')
        .select('id, table_id, user_id, message, created_at, sender_id, message_type, username')
        .eq('table_id', tableId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (!isMounted) return;
      if (data) {
        const formatted = data.reverse().map((m: any) => ({
          id: m.id,
          type: (m.message_type === 'dealer'
            ? 'DEALER'
            : m.message_type === 'system'
              ? 'SYSTEM'
              : 'PLAYER') as 'DEALER' | 'SYSTEM' | 'PLAYER',
          playerId: m.sender_id,
          playerName: m.username || 'Player',
          content: m.message,
          timestamp: new Date(m.created_at),
        }));
        setChatMessages(formatted);
      }
    };
    loadMessages();

    // The persistent chat websocket listener
    const channel = supabase
      .channel(`table_chat_hook:${tableId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'table_chat',
          filter: `table_id=eq.${tableId}`,
        },
        (payload) => {
          const m = payload.new as any;
          if (!isMounted) return;

          setChatMessages((prev) => {
            // Deduplicate optimistic inserts
            if (
              prev.some(
                (msg) =>
                  msg.id.startsWith('msg_') &&
                  msg.playerId === m.sender_id &&
                  msg.content === m.message
              )
            ) {
              return prev;
            }

            const newMsg: ChatMessage = {
              id: m.id,
              type: (m.message_type === 'dealer'
                ? 'DEALER'
                : m.message_type === 'system'
                  ? 'SYSTEM'
                  : 'PLAYER') as 'DEALER' | 'SYSTEM' | 'PLAYER',
              playerId: m.sender_id,
              playerName: m.username || 'Player',
              content: m.message,
              timestamp: new Date(m.created_at),
            };
            return [...prev.slice(-49), newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
      pendingTimersRef.current.forEach(clearTimeout);
      pendingTimersRef.current.clear();
    };
  }, [tableId]);

  // ── Bus listeners: receive incoming system events representing game actions ──
  useMasterBusSubscription('PRE_ACTION_EXECUTED', (data: any) => {
    if (data && (!tableId || data.tableId === tableId)) {
      const actionText =
        data.action === 'fold'
          ? 'auto-folded'
          : data.action === 'check'
            ? 'auto-checked'
            : 'auto-called';

      setChatMessages((prev) => {
        const sysMsg: ChatMessage = {
          id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'SYSTEM',
          playerId: data.playerId,
          playerName: 'System',
          content: `Player ${data.playerId.substring(0, 4)} ${actionText}`,
          timestamp: new Date(),
        };
        return [...prev.slice(-49), sysMsg];
      });
    }
  });

  useMasterBusSubscription('STRADDLE_TOGGLED', (data: any) => {
    if (data && (!tableId || data.tableId === tableId)) {
      setChatMessages((prev) => {
        const sysMsg: ChatMessage = {
          id: `sys-straddle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'SYSTEM',
          playerId: data.playerId,
          playerName: 'System',
          content: `Player ${data.playerId.substring(0, 4)} turned ${data.enabled ? 'ON' : 'OFF'} Auto-Straddle`,
          timestamp: new Date(),
        };
        return [...prev.slice(-49), sysMsg];
      });
    }
  });

  useMasterBusSubscription('TIME_BANK_ACTIVATED', (data: any) => {
    if (data && (!tableId || data.tableId === tableId)) {
      setChatMessages((prev) => {
        const sysMsg: ChatMessage = {
          id: `sys-timebank-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'SYSTEM',
          playerId: data.playerId,
          playerName: 'System',
          content: `Player ${data.playerId.substring(0, 4)} activated Time Bank (+${data.addedSeconds}s)`,
          timestamp: new Date(),
        };
        return [...prev.slice(-49), sysMsg];
      });
    }
  });

  // Parse incoming messages — returns true if message was a special command (reaction/throw)
  const parseIncomingMessage = useCallback((content: string, _senderId: string): boolean => {
    // Check for reaction messages
    const reactionMatch = content.match(REACTION_MSG_REGEX);
    if (reactionMatch) {
      // DoS Protection: Cap max concurrent animations to 20
      if (pendingTimersRef.current.size >= 20) return true;

      const emoji = reactionMatch[1];
      const seatIndex = parseInt(reactionMatch[2], 10);
      const reactionId = `rx_${++reactionIdRef.current}`;

      setActiveReactions((prev) => [
        ...prev,
        { id: reactionId, emoji, seatIndex, timestamp: Date.now() },
      ]);

      // Auto-remove after lifetime (tracked for cleanup)
      const timerId = setTimeout(() => {
        setActiveReactions((prev) => prev.filter((r) => r.id !== reactionId));
        pendingTimersRef.current.delete(timerId);
      }, REACTION_LIFETIME_MS);
      pendingTimersRef.current.add(timerId);

      return true; // Don't add to chat
    }

    // Check for throw messages (already handled by throwable system)
    if (THROW_MSG_REGEX.test(content)) {
      return true; // Don't add to chat
    }

    return false; // Normal message — add to chat
  }, []);

  const handleSendChatMessage = useCallback(
    async (message: string) => {
      if (!tableId || !userId) return;

      const tempId = `msg_${Date.now()}`;

      // Optimistically add to local state
      setChatMessages((prev) => [
        ...prev.slice(-49),
        {
          id: tempId,
          type: 'PLAYER' as const,
          playerId: userId,
          playerName: heroName || 'You',
          content: message,
          timestamp: new Date(),
        },
      ]);

      triggerHaptic('light');

      // Persist to Supabase so mobile and desktop components stay synced
      try {
        const { error } = await supabase.from('table_chat').insert({
          table_id: tableId,
          sender_id: userId,
          username: heroName,
          message: message,
          message_type: 'player',
        });

        if (error) {
          console.error('Failed to send chat:', error);
          setChatMessages((prev) => prev.filter((m) => m.id !== tempId));
        }
      } catch (err) {
        setChatMessages((prev) => prev.filter((m) => m.id !== tempId));
      }
    },
    [tableId, userId, heroName]
  );

  return {
    chatMessages,
    setChatMessages,
    isChatCollapsed,
    setIsChatCollapsed,
    isChatMuted,
    setIsChatMuted,
    handleSendChatMessage,
    activeReactions,
    parseIncomingMessage,
  };
}
