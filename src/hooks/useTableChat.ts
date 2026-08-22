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
import { soundService } from '../services/SoundService';
import type { ChatMessage } from '../components/table/TableChat';
import { reportError } from '../utils/errorReporter';

// Reaction event type (shared with TableReactions)
export interface ReactionEvent {
  id: string;
  emoji: string;
  seatIndex: number;
  timestamp: number;
}

const REACTION_MSG_REGEX = /^\[REACTION:(.+):(\d+)\]$/;
const THROW_MSG_REGEX = /^\[THROW:(.+):(\d+)\]$/;
const REACTION_LIFETIME_MS = 2500;
const RATE_LIMIT_MS = 1000; // 1 message per second

// ── Basic profanity filter (client-side, additive safety net) ──
const PROFANITY_LIST = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
  'pussy',
  'cunt',
  'nigger',
  'faggot',
  'retard',
  'whore',
  'slut',
];
const PROFANITY_REGEX = new RegExp(`\\b(${PROFANITY_LIST.join('|')})\\b`, 'gi');
function censorMessage(text: string): string {
  return text.replace(PROFANITY_REGEX, (match) => match[0] + '*'.repeat(match.length - 1));
}

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
  // Unread tracking
  unreadCount: number;
  clearUnread: () => void;
}

export function useTableChat(
  tableId: string | undefined,
  userId: string,
  players: any[],
  // VISIBLE FIX 2026-08-15: throws were send-only. The thrower rendered a local
  // animation and broadcast `[THROW:id:seat]` over chat, but the ONLY inbound
  // consumer matched the message and dropped it, so nobody else ever saw the
  // throw they had just paid a diamond for. This callback hands a parsed throw
  // to the animation layer.
  onThrowReceived?: (fromSeat: number, toSeat: number, throwableId: string) => void
): UseTableChatReturn {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatCollapsed, setIsChatCollapsed] = useState(true);
  const [isChatMuted, setIsChatMuted] = useState(false);
  const [activeReactions, setActiveReactions] = useState<ReactionEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const reactionIdRef = useRef(0);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const lastSendTimestampRef = useRef(0);
  const onThrowReceivedRef = useRef(onThrowReceived);
  useEffect(() => {
    onThrowReceivedRef.current = onThrowReceived;
  }, [onThrowReceived]);
  const isChatCollapsedRef = useRef(isChatCollapsed);
  const isChatMutedRef = useRef(isChatMuted);

  // Keep refs in sync with state for use in subscription callbacks
  useEffect(() => {
    isChatCollapsedRef.current = isChatCollapsed;
    // When user opens chat, clear unread
    if (!isChatCollapsed) setUnreadCount(0);
  }, [isChatCollapsed]);
  useEffect(() => {
    isChatMutedRef.current = isChatMuted;
  }, [isChatMuted]);

  const clearUnread = useCallback(() => setUnreadCount(0), []);

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
            // Track unread if chat is collapsed
            if (isChatCollapsedRef.current && m.user_id !== userId) {
              setUnreadCount((c) => c + 1);
            }
            // Warm notification ping for incoming messages from other players
            // (skip our own echoes, system/dealer injections, and reaction/throw encodings)
            const isRealPlayerMsg =
              m.user_id !== userId &&
              m.message_type !== 'system' &&
              m.message_type !== 'dealer' &&
              !REACTION_MSG_REGEX.test(m.message || '') &&
              !THROW_MSG_REGEX.test(m.message || '');
            if (isRealPlayerMsg && !isChatMutedRef.current) {
              soundService.playChatMessage();
            }
            return [...filtered.slice(-49), newMsg];
          });
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.debug('[useTableChat] Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.debug('[useTableChat] Realtime channel timed out');
        }
      });

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

    // ── Dealer Narration: announce hand winners ──
    const unsubHandWon = masterBus.subscribe('HAND_WON', (event) => {
      const data = event.payload as any;
      if (!isMounted || !data || (tableId && data.tableId && data.tableId !== tableId)) return;
      const winnerNames = (data.winners || []).map((wId: string) => {
        const p = playersRef.current.find((pl) => pl && pl.id === wId);
        return p?.name || wId.substring(0, 6);
      });
      const potStr = typeof data.pot === 'number' ? ` - pot ${data.pot.toLocaleString()}` : '';
      const msg =
        winnerNames.length > 1
          ? `${winnerNames.join(' & ')} split the pot${potStr}`
          : `${winnerNames[0] || 'Unknown'} wins${potStr}`;
      setChatMessages((prev) => [
        ...prev.slice(-49),
        {
          id: `dealer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'DEALER',
          playerName: 'Dealer',
          content: msg,
          timestamp: new Date(),
        },
      ]);
    });

    const unsubShowdown = masterBus.subscribe('SHOWDOWN_START', (event) => {
      const data = event.payload as any;
      if (!isMounted || !data || (tableId && data.tableId && data.tableId !== tableId)) return;
      const showdownPlayers = (data.players || [])
        .filter((p: any) => p.isWinner)
        .map((p: any) => `${p.username || 'Player'} (${p.handName || 'Unknown'})`);
      if (showdownPlayers.length > 0) {
        setChatMessages((prev) => [
          ...prev.slice(-49),
          {
            id: `dealer-sd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'DEALER',
            playerName: 'Dealer',
            content: `Showdown: ${showdownPlayers.join(' vs ')}`,
            timestamp: new Date(),
          },
        ]);
      }
    });

    return () => {
      isMounted = false;
      unsubPreAction();
      unsubStraddle();
      unsubTimeBank();
      unsubHandWon();
      unsubShowdown();
    };
  }, [tableId]);

  // Parse incoming messages — returns true if message was a special command (reaction/throw)
  const parseIncomingMessage = useCallback(
    (content: string, senderId: string): boolean => {
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

      // Throw messages: render the incoming throw for everyone EXCEPT the
      // thrower, who already animated it locally when they sent it.
      const throwMatch = content.match(THROW_MSG_REGEX);
      if (throwMatch) {
        if (senderId && senderId !== userId) {
          // DoS guard, same ceiling as reactions.
          if (pendingTimersRef.current.size < 20) {
            const throwableId = throwMatch[1];
            const toSeat = parseInt(throwMatch[2], 10);
            // players[] is seat-ordered (index 0 = seat 1), matching the rest of
            // the table; resolve the thrower's seat from their id.
            const fromIdx = players.findIndex((pl) => pl && pl.id === senderId);
            const fromSeat = fromIdx >= 0 ? fromIdx + 1 : 0;
            if (Number.isFinite(toSeat) && toSeat > 0) {
              onThrowReceivedRef.current?.(fromSeat, toSeat, throwableId);
            }
          }
        }
        return true; // Don't add to chat
      }

      return false; // Normal message — add to chat
      // players/userId are read through refs where they must stay fresh.
    },
    [players, userId]
  );

  const handleSendChatMessage = useCallback(
    async (message: string) => {
      if (!tableId || !userId) return;

      // Rate limiter: enforce 1 message/second
      const now = Date.now();
      if (now - lastSendTimestampRef.current < RATE_LIMIT_MS) return;
      lastSendTimestampRef.current = now;

      // Apply profanity filter
      const cleanMessage = censorMessage(message);

      const tempId = `msg_${now}`;
      const pName = players.find((p) => p && p.id === userId)?.name || 'Player';

      // Optimistically add to local state
      setChatMessages((prev) => [
        ...prev.slice(-49),
        {
          id: tempId,
          type: 'PLAYER' as const,
          playerId: userId,
          playerName: pName,
          content: cleanMessage,
          timestamp: new Date(),
        },
      ]);

      triggerHaptic('light');

      // Persist to Supabase so mobile and desktop components stay synced
      try {
        const { error } = await supabase.from('table_chat').insert({
          table_id: tableId,
          user_id: userId,
          message: cleanMessage,
          message_type: 'player',
        });

        if (error) {
          reportError(error, 'useTableChat.Failed_to_send_chat');
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
    unreadCount,
    clearUnread,
  };
}
