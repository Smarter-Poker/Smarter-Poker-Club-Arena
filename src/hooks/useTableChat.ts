import { isThrowableEventId } from '../throwables/identity';
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
/**
 * 1 message per second. `SEND_COOLDOWN_MS` in TableChat must be >= this, or the
 * compose box clears the input for a message this limiter then discards.
 */
const RATE_LIMIT_MS = 1000;
/** How long a message that failed to send stays visible before it is removed. */
const FAILED_MESSAGE_LINGER_MS = 4000;

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
  /**
   * True when this player may not post here: the host switched chat off, the
   * parent tournament has chat off, or this player is muted at this table.
   * The RLS policy refuses the insert either way - this is so the composer can
   * say so instead of swallowing the message.
   */
  isChatBanned: boolean;
  // Reaction parsing
  activeReactions: ReactionEvent[];
  parseIncomingMessage: (content: string, senderId: string, throwId?: unknown) => boolean;
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
  onThrowReceived?: (
    fromSeat: number,
    toSeat: number,
    throwableId: string,
    throwId?: string
  ) => void
): UseTableChatReturn {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatBanned, setIsChatBanned] = useState(false);
  const [isChatCollapsed, setIsChatCollapsed] = useState(true);
  const [isChatMuted, setIsChatMuted] = useState(false);
  const [activeReactions, setActiveReactions] = useState<ReactionEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const reactionIdRef = useRef(0);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const lastSendTimestampRef = useRef(0);
  const isChatBannedRef = useRef(false);

  /* Dan 2026-08-25: `tables.ban_chat` was read only by the tournament screens.
     A cash host could switch chat off and every player kept talking. The rule
     is enforced in the table_chat INSERT policy, because the send is a direct
     PostgREST call from the browser and there is no server hop to gate; this
     read exists purely so the UI can hide the composer rather than accept a
     message and drop it.

     2026-08-26: this used to read `tables.ban_chat` directly, which is one of
     THREE ways a player can be silenced and the only one it could see. It now
     asks `fn_table_chat_is_silenced`, the same SECURITY DEFINER function the
     RLS policy calls, so the composer and the policy can never disagree:

       - the table's own ban_chat switch;
       - the parent TOURNAMENT's ban_chat, which reached nothing before today
         (3 live tables sat under ban_chat tournaments with the flag unset on
         the table row, and every one of them chatted);
       - this player's own unexpired `table_chat_mutes` row, which was
         enforced nowhere at all.

     The last two cannot be read directly from the browser by the player they
     apply to: `table_chat_mutes` is admin-read-only, so a muted player sees
     zero rows and would conclude they are not muted. */
  useEffect(() => {
    if (!tableId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_table_chat_is_silenced', {
          p_table_id: tableId,
        });
        if (cancelled) return;
        /* An unreadable answer is UNKNOWN, not "not banned" - but the composer
           is a courtesy and the policy is the enforcement, so unknown leaves
           chat enabled rather than silencing a table nobody muted. A refused
           send is then caught below and the player is told. */
        if (error) return;
        const banned = data === true;
        isChatBannedRef.current = banned;
        setIsChatBanned(banned);
      } catch {
        /* a failed read leaves chat enabled - the policy is the enforcement */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId]);
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

    // The persistent chat listener multiplexed off the master table channel
    const unsub = masterBus.subscribe('TABLE_CHAT_INSERT', (event) => {
      const payload = event.payload;
      if (payload.tableId !== tableId) return;

      const m = payload.newRow as any;
      if (!isMounted) return;

      /**
       * SIDE EFFECTS LIVE OUTSIDE THE UPDATER 2026-08-28.
       *
       * The unread bump and the incoming-message chime used to run INSIDE the
       * `setChatMessages` updater. Under React 18 concurrent rendering an
       * updater can be re-invoked on a discarded or rebased render, so one
       * arriving message could tick the badge twice and play the chime twice.
       * A state updater must be pure; these are effects, so they happen here,
       * once, on the event itself.
       */
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
    });

    return () => {
      isMounted = false;
      unsub();
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
    (content: string, senderId: string, throwId?: unknown): boolean => {
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
              onThrowReceivedRef.current?.(
                fromSeat,
                toSeat,
                throwableId,
                isThrowableEventId(throwId) ? throwId.toLowerCase() : undefined
              );
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

  /**
   * The send was refused. Say so, then clean up.
   *
   * This used to be `prev.filter(m => m.id !== tempId)` — the message the
   * player had just watched appear simply vanished, with nothing anywhere to
   * say it had not been sent. `club_chat` already marked a failed row and let
   * it linger before removing it; table chat did not, and the difference was
   * the difference between "the network dropped that one" and "this chat is
   * broken".
   *
   * FAILED_MESSAGE_LINGER_MS is long enough to read and short enough that the
   * transcript does not accumulate corpses.
   */
  const markFailed = useCallback((tempId: string) => {
    setChatMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, isFailed: true } : m)));
    const timer = setTimeout(() => {
      setChatMessages((prev) => prev.filter((m) => m.id !== tempId));
      pendingTimersRef.current.delete(timer);
    }, FAILED_MESSAGE_LINGER_MS);
    pendingTimersRef.current.add(timer);
  }, []);

  const handleSendChatMessage = useCallback(
    async (message: string) => {
      if (!tableId || !userId) return;

      // Rate limiter: enforce 1 message/second
      const now = Date.now();
      // The policy would refuse this anyway; returning here keeps the message
      // in the box instead of optimistically rendering one that never lands.
      if (isChatBannedRef.current) return;
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
          markFailed(tempId);
          /* 42501 is the RLS refusal. A player muted or banned AFTER the
             composer read its answer would otherwise sit there watching every
             message fail with no reason given, so adopt the policy's verdict
             and close the box. The mount read cannot catch this case: a mute
             arrives mid-session and there is no realtime feed for one. */
          if ((error as { code?: string }).code === '42501') {
            isChatBannedRef.current = true;
            setIsChatBanned(true);
          }
        }
      } catch (err) {
        reportError(err, 'useTableChat.Failed_to_send_chat');
        markFailed(tempId);
      }
    },
    [tableId, userId, players, markFailed]
  );

  return {
    chatMessages,
    setChatMessages,
    isChatCollapsed,
    setIsChatCollapsed,
    isChatMuted,
    setIsChatMuted,
    handleSendChatMessage,
    isChatBanned,
    activeReactions,
    parseIncomingMessage,
    unreadCount,
    clearUnread,
  };
}
