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
import { masterBus } from '../core/MasterBus';
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
  players: any[]
): UseTableChatReturn {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatCollapsed, setIsChatCollapsed] = useState(true);
  const [isChatMuted, setIsChatMuted] = useState(false);
  const [activeReactions, setActiveReactions] = useState<ReactionEvent[]>([]);
  const reactionIdRef = useRef(0);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const playersRef = useRef(players);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // Fetch history and listen to Supabase real-time chat (Unified architecture)
  useEffect(() => {
    if (!tableId) return;
    let isMounted = true;

    const loadMessages = async () => {
      const { data } = await supabase
        .from('table_chat')
        .select('id, table_id, user_id, message, created_at, message_type')
        .eq('table_id', tableId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (!isMounted) return;
      if (data) {
        const formatted = data.reverse().map((m: any) => {
          const pName = playersRef.current.find((p) => p && p.id === m.user_id)?.name || 'Player';
          return {
            id: m.id,
            type: (m.message_type === 'dealer'
              ? 'DEALER'
              : m.message_type === 'system'
                ? 'SYSTEM'
                : 'PLAYER') as 'DEALER' | 'SYSTEM' | 'PLAYER',
            playerId: m.user_id,
            playerName: pName,
            content: m.message,
            timestamp: new Date(m.created_at),
          };
        });
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
            // Deduplicate: remove the optimistic local clone, and append the real Supabase record
            let removedOne = false;
            const filtered = prev.filter((msg) => {
              if (
                !removedOne &&
                msg.id.startsWith('msg_') &&
                msg.playerId === m.user_id &&
                msg.content === m.message
              ) {
                removedOne = true;
                return false;
              }
              return true;
            });

            const pName = playersRef.current.find((p) => p && p.id === m.user_id)?.name || 'Player';
            const newMsg: ChatMessage = {
              id: m.id,
              type: (m.message_type === 'dealer'
                ? 'DEALER'
                : m.message_type === 'system'
                  ? 'SYSTEM'
                  : 'PLAYER') as 'DEALER' | 'SYSTEM' | 'PLAYER',
              playerId: m.user_id,
              playerName: pName,
              content: m.message,
              timestamp: new Date(m.created_at),
            };
            return [...filtered.slice(-49), newMsg];
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
  useEffect(() => {
    let isMounted = true;

    const unsubPreAction = masterBus.subscribe('PRE_ACTION_EXECUTED', (event) => {
      const data = event.payload as any;
      if (!isMounted || !data || (tableId && data.tableId !== tableId)) return;

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
    });

    const unsubStraddle = masterBus.subscribe('STRADDLE_TOGGLED', (event) => {
      const data = event.payload as any;
      if (!isMounted || !data || (tableId && data.tableId !== tableId)) return;

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
    });

    const unsubTimeBank = masterBus.subscribe('TIME_BANK_ACTIVATED', (event) => {
      const data = event.payload as any;
      if (!isMounted || !data || (tableId && data.tableId !== tableId)) return;

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
    });

    return () => {
      isMounted = false;
      unsubPreAction();
      unsubStraddle();
      unsubTimeBank();
    };
  }, [tableId]);

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
      const pName = players.find((p) => p && p.id === userId)?.name || 'Player';

      // Optimistically add to local state
      setChatMessages((prev) => [
        ...prev.slice(-49),
        {
          id: tempId,
          type: 'PLAYER' as const,
          playerId: userId,
          playerName: pName,
          content: message,
          timestamp: new Date(),
        },
      ]);

      triggerHaptic('light');

      // Persist to Supabase so mobile and desktop components stay synced
      try {
        const { error } = await supabase.from('table_chat').insert({
          table_id: tableId,
          user_id: userId,
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
    [tableId, userId, players]
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
