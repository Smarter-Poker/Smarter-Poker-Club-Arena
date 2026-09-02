/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableVoice — the React face of the table's WebRTC voice mesh
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The engine lives in `services/VoiceSignalService.ts`; this is the binding.
 * Everything interesting - signalling, the mesh, speaking detection, the
 * eligibility gates - is documented there.
 *
 * WHY THE SESSION IS NOT OWNED BY THIS HOOK
 * ─────────────────────────────────────────
 * Two places need the same voice room at the same time: the controls in the
 * chat sheet header (which need `join`, `isMuted`, `error`) and the felt (which
 * needs `speakingPlayerIds` for the seat bubbles). If the hook owned the mesh,
 * mounting it twice would open the microphone twice and give every remote
 * player two copies of the local audio. So the mesh lives in a refcounted
 * registry keyed by table and player, and any number of components may call
 * this hook against the same table for exactly one mesh.
 *
 * That is what makes the TablePage wiring a one-liner: call this hook there for
 * `speakingPlayerIds` and hand them to `useSeatChatBubbles`. VoiceControls is
 * already calling it; the second call is a subscriber, not a second room.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acquireVoiceSession,
  readTalkMode,
  writeTalkMode,
  type TableVoiceSession,
  type VoiceError,
  type VoicePeerState,
  type VoiceSessionState,
  type VoiceStatus,
  type VoiceTalkMode,
} from '../services/VoiceSignalService';

/** Stable empty array, so a table with voice off never re-renders its consumers. */
const NO_SPEAKERS: string[] = [];
const NO_PEERS: Record<string, VoicePeerState> = {};

const IDLE_STATE: VoiceSessionState = {
  isAvailable: false,
  isJoined: false,
  isMuted: true,
  isTransmitting: false,
  speakingPlayerIds: NO_SPEAKERS,
  peerStates: NO_PEERS,
  error: null,
  status: 'idle',
};

export interface UseTableVoiceOptions {
  /** The table whose voice room this is. Undefined means no room. */
  tableId?: string;
  /** The local player. Empty for an observer with no account. */
  userId?: string;
  /**
   * The caller's permission for voice to exist here at all. False on a
   * tournament table and until the player has opted in; false tears the mesh
   * down. It is NOT the same thing as `isAvailable`, which is the session's own
   * verdict after it has asked the database whether this player may speak.
   */
  enabled?: boolean;
}

export interface UseTableVoiceResult {
  /** Voice is possible here and this player is allowed to use it. */
  isAvailable: boolean;
  isJoined: boolean;
  isMuted: boolean;
  isTransmitting: boolean;
  /**
   * Everyone audible right now. Referentially STABLE while the set is unchanged
   * - hand it straight to `useSeatChatBubbles({ speakingPlayerIds })`.
   */
  speakingPlayerIds: string[];
  peerStates: Record<string, VoicePeerState>;
  error: VoiceError | null;
  status: VoiceStatus;
  /** 'hold' is press-and-hold; 'latch' keeps the mic open until tapped again. */
  talkMode: VoiceTalkMode;
  setTalkMode: (mode: VoiceTalkMode) => void;
  join: () => Promise<boolean>;
  leave: () => void;
  setMuted: (muted: boolean) => void;
  startTalking: () => void;
  stopTalking: () => void;
}

export function useTableVoice(options: UseTableVoiceOptions = {}): UseTableVoiceResult {
  const { tableId, userId, enabled = true } = options;

  const [state, setState] = useState<VoiceSessionState>(IDLE_STATE);
  const sessionRef = useRef<TableVoiceSession | null>(null);
  const [talkMode, setTalkModeState] = useState<VoiceTalkMode>(() =>
    userId ? readTalkMode(userId) : 'hold'
  );

  const active = Boolean(enabled && tableId && userId);

  useEffect(() => {
    if (!active || !tableId || !userId) {
      sessionRef.current = null;
      setState(IDLE_STATE);
      return;
    }

    const { session, release } = acquireVoiceSession(tableId, userId);
    sessionRef.current = session;
    setState(session.getState());
    const unsubscribe = session.subscribe(setState);
    // Ask the eligibility questions once per mount. The session caches the
    // answer, so a second consumer of the same room costs nothing.
    void session.checkEligibility();

    return () => {
      unsubscribe();
      // The mesh only dies when the LAST holder lets go, so the felt unmounting
      // its bubble subscription does not hang up the chat header's microphone.
      release();
      sessionRef.current = null;
    };
  }, [active, tableId, userId]);

  useEffect(() => {
    if (userId) setTalkModeState(readTalkMode(userId));
  }, [userId]);

  const setTalkMode = useCallback(
    (mode: VoiceTalkMode) => {
      setTalkModeState(mode);
      if (userId) writeTalkMode(userId, mode);
      // Switching modes never leaves the microphone open behind the player's
      // back: dropping out of latch closes it.
      if (mode === 'hold') sessionRef.current?.stopTalking();
    },
    [userId]
  );

  const join = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return false;
    return session.join();
  }, []);

  const leave = useCallback(() => {
    sessionRef.current?.leave();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    sessionRef.current?.setMuted(muted);
  }, []);

  const startTalking = useCallback(() => {
    sessionRef.current?.startTalking();
  }, []);

  const stopTalking = useCallback(() => {
    sessionRef.current?.stopTalking();
  }, []);

  return {
    isAvailable: state.isAvailable,
    isJoined: state.isJoined,
    isMuted: state.isMuted,
    isTransmitting: state.isTransmitting,
    speakingPlayerIds: state.speakingPlayerIds,
    peerStates: state.peerStates,
    error: state.error,
    status: state.status,
    talkMode,
    setTalkMode,
    join,
    leave,
    setMuted,
    startTalking,
    stopTalking,
  };
}

export default useTableVoice;
