/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VOICE CONTROLS — the microphone in the chat sheet header
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: "there should also be a microphone for voice as well", then
 * "FULL VOICE, BUILD IT OR FIND A OPEN SOURCE".
 *
 * The contract TableChat mounts, unchanged from the stub this replaces:
 *
 *     <VoiceControls tableId={tableId} userId={myPlayerId ?? ''} />
 *
 * Everything below the surface is `useTableVoice`, and the mesh itself is
 * `services/VoiceSignalService.ts`. This file is the twenty pixels of it a
 * player actually touches.
 *
 * THE SHAPE OF THE CONTROL, AND WHY
 * ─────────────────────────────────
 * It shares a 375px-wide header row with a title and a close X, so it gets
 * three buttons and a line of text, and not one thing more.
 *
 *   MIC    joins the room on the first press; after that it is the talk button.
 *   MODE   Hold or Lock. A phone player cannot hold a button down and act on
 *          their hand at the same time, so latching is not a nicety here, it is
 *          the only way voice and poker coexist on one thumb.
 *   END    leaves the room. It exists because closing the chat sheet does NOT
 *          leave voice: the felt keeps its own subscription for the speaking
 *          bubbles, so without this button a player could close chat believing
 *          they had hung up while their microphone was still in the room.
 *
 * DEFAULT MUTED, ALWAYS
 * ─────────────────────
 * Joining opens the room, not the microphone. `useTableVoice` reports
 * `isMuted: true` from the first frame and the local audio track is disabled at
 * the wire until the player deliberately opens it. This is a real-money table.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import './VoiceControls.css';
import { useTableVoice } from '../../hooks/useTableVoice';
import type { VoiceError } from '../../services/VoiceSignalService';

export interface VoiceControlsProps {
  /** The table whose voice room this is. */
  tableId?: string;
  /** The local player. Empty string for an observer with no account. */
  userId: string;
}

/**
 * Header-sized summary of a failure. The full sentence goes in `title` (and in
 * the aria-label) so nothing is lost; this is what fits beside a close button.
 *
 * House rule (Dan 2026-08-20): First Letter Of Every Word Capitalized, and no
 * em dashes.
 */
const SHORT_REASON: Record<VoiceError['code'], string> = {
  unsupported: 'Voice Unavailable',
  'insecure-context': 'Voice Needs Https',
  'permission-denied': 'Mic Blocked',
  'permission-dismissed': 'Mic Not Allowed Yet',
  'no-device': 'No Microphone',
  'not-seated': 'Sit To Talk',
  'tournament-table': 'Cash Tables Only',
  silenced: 'Voice Off For You',
  'signalling-failed': 'Voice Unreachable',
  'connection-failed': 'A Player Could Not Connect',
};

export function VoiceControls({ tableId, userId }: VoiceControlsProps) {
  const voice = useTableVoice({ tableId, userId, enabled: Boolean(tableId && userId) });
  const {
    isAvailable,
    isJoined,
    isMuted,
    isTransmitting,
    speakingPlayerIds,
    peerStates,
    error,
    status,
    talkMode,
    setTalkMode,
    join,
    leave,
    startTalking,
    stopTalking,
  } = voice;

  /**
   * A pointer that went down on the mic must be released even if it comes up
   * somewhere else entirely (the player's thumb slides off the button, or the
   * chat sheet closes under them). Without this the microphone latches open by
   * accident, which is the one failure this whole component exists to prevent.
   */
  const holdingRef = useRef(false);

  const releaseHold = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    stopTalking();
  }, [stopTalking]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('pointerup', releaseHold);
    window.addEventListener('pointercancel', releaseHold);
    window.addEventListener('blur', releaseHold);
    return () => {
      window.removeEventListener('pointerup', releaseHold);
      window.removeEventListener('pointercancel', releaseHold);
      window.removeEventListener('blur', releaseHold);
      // Unmounting with the button held is the same thing as letting go.
      if (holdingRef.current) {
        holdingRef.current = false;
        stopTalking();
      }
    };
  }, [releaseHold, stopTalking]);

  const othersSpeaking = useMemo(
    () => speakingPlayerIds.filter((id) => id !== userId),
    [speakingPlayerIds, userId]
  );

  const failedPeers = useMemo(
    () => Object.values(peerStates).filter((s) => s === 'failed').length,
    [peerStates]
  );

  const handleMicDown = useCallback(() => {
    if (!isJoined || talkMode !== 'hold') return;
    holdingRef.current = true;
    startTalking();
  }, [isJoined, talkMode, startTalking]);

  const handleMicClick = useCallback(() => {
    if (!isJoined) {
      void join();
      return;
    }
    if (talkMode === 'latch') {
      if (isMuted) startTalking();
      else stopTalking();
    }
    // In hold mode the click is the tail of a press that the pointer handlers
    // have already opened and closed. Doing anything here would toggle it back.
  }, [isJoined, talkMode, isMuted, join, startTalking, stopTalking]);

  const handleMicKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!isJoined || talkMode !== 'hold') return;
      if (e.key !== ' ' && e.key !== 'Enter') return;
      if (e.repeat) return;
      e.preventDefault();
      holdingRef.current = true;
      startTalking();
    },
    [isJoined, talkMode, startTalking]
  );

  const handleMicKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      releaseHold();
    },
    [releaseHold]
  );

  // Nothing to say yet. Rendering a spinner for the eligibility round trip
  // would flash on every chat open for a player who cannot use voice anyway.
  if (status === 'checking' && !isJoined && !error) return null;

  // Not allowed here. One quiet line, never a button that cannot work.
  if (!isAvailable && !isJoined) {
    if (!error) return null;
    return (
      <span
        className="voice-controls voice-controls--note"
        title={error.message}
        role="status"
        aria-label={error.message}
      >
        {SHORT_REASON[error.code] ?? 'Voice Unavailable'}
      </span>
    );
  }

  const connecting = status === 'connecting';
  const micLabel = !isJoined
    ? 'Join Table Voice'
    : talkMode === 'hold'
      ? 'Hold To Talk'
      : isMuted
        ? 'Turn Microphone On'
        : 'Turn Microphone Off';

  const roster = !isJoined
    ? 'Voice Off'
    : connecting
      ? 'Connecting'
      : othersSpeaking.length > 0
        ? `${othersSpeaking.length} Talking`
        : isTransmitting
          ? 'You Are Live'
          : failedPeers > 0
            ? 'A Player Could Not Connect'
            : 'Muted';

  return (
    <div className="voice-controls" data-testid="voice-controls">
      <button
        type="button"
        className={`voice-controls__mic${isTransmitting ? ' voice-controls__mic--live' : ''}${
          isJoined ? ' voice-controls__mic--joined' : ''
        }`}
        aria-label={micLabel}
        title={micLabel}
        aria-pressed={isJoined && talkMode === 'latch' ? !isMuted : undefined}
        disabled={connecting}
        onPointerDown={handleMicDown}
        onPointerUp={releaseHold}
        onPointerCancel={releaseHold}
        onPointerLeave={releaseHold}
        onClick={handleMicClick}
        onKeyDown={handleMicKeyDown}
        onKeyUp={handleMicKeyUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* No emoji anywhere in source (house rule: bare emoji break the SWC
            compiler). The microphone is drawn, and the slash over it when muted
            is drawn too, so the state does not depend on colour alone. */}
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" fill="currentColor" />
          <path
            d="M5 11a7 7 0 0 0 14 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M12 18v3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {isJoined && isMuted ? (
            <path
              d="M4 4l16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          ) : null}
        </svg>
      </button>

      {isJoined ? (
        <button
          type="button"
          className="voice-controls__mode"
          aria-label={
            talkMode === 'hold' ? 'Switch To Locked Microphone' : 'Switch To Hold To Talk'
          }
          aria-pressed={talkMode === 'latch'}
          title={talkMode === 'hold' ? 'Hold To Talk' : 'Locked Open'}
          onClick={() => setTalkMode(talkMode === 'hold' ? 'latch' : 'hold')}
        >
          {talkMode === 'hold' ? 'Hold' : 'Lock'}
        </button>
      ) : null}

      {isJoined ? (
        <button
          type="button"
          className="voice-controls__end"
          aria-label="Leave Table Voice"
          title="Leave Table Voice"
          onClick={() => {
            holdingRef.current = false;
            leave();
          }}
        >
          {/* U+2715, the same multiplication X the chat close uses. Written as
              an HTML entity, exactly as TableChat writes its own close, so no
              non-ASCII glyph sits in the source. */}
          &#10005;
        </button>
      ) : null}

      <span
        className={`voice-controls__roster${
          othersSpeaking.length > 0 ? ' voice-controls__roster--active' : ''
        }`}
        role="status"
        aria-live="polite"
      >
        {roster}
      </span>
    </div>
  );
}

export default VoiceControls;
