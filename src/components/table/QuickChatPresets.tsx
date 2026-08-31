/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  QUICK CHAT PRESETS — one-tap table talk
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `QuickChatPresets.css` existed in this directory for months with NO component
 * and no import anywhere in `src` - 307 lines of dead stylesheet. It is built
 * rather than deleted because the chat sheet now has the room the old 280px
 * floating box did not, and because typing on a phone while a hand is running
 * is the reason most table chat goes unused: the software keyboard covers the
 * felt and the action clock does not stop for it. A preset is a single tap.
 *
 * WHAT WAS DELIBERATELY NOT BUILT from that stylesheet: the `.qc-reaction-*`
 * bar. `TableReactions` already owns emoji reactions at this table, gated by
 * Bible V8 `emoji_enabled`, and it broadcasts them as `[REACTION:...]` payloads
 * on the chat feed. A second reaction control here would be a second source of
 * truth for one feature, and the house rules forbid emoji in source anyway.
 * Those rules were removed from the stylesheet in the same change rather than
 * left behind as a second orphan.
 *
 * Every preset goes out through the SAME send path as a typed line, so the
 * rate limit, the profanity filter, the failed-send marking and the seat bubble
 * all behave identically. A preset is text, not a new message type.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import './QuickChatPresets.css';

/**
 * The default phrase set.
 *
 * Short, neutral and unmistakably poker: the point is to say the thing you
 * would have typed, not to open a needling surface. Kept to six so the row
 * wraps to two lines at 375px instead of scrolling.
 */
export const QUICK_CHAT_PRESETS: readonly string[] = [
  'Nice Hand',
  'Good Luck',
  'Well Played',
  'Thank You',
  'One Time',
  'Unlucky',
];

/** Matches TableChat's SEND_COOLDOWN_MS, which matches the hook's RATE_LIMIT_MS. */
const DEFAULT_COOLDOWN_MS = 1000;

export interface QuickChatPresetsProps {
  /**
   * Send one line. Return `false` to say the send was REFUSED (rate limited,
   * chat banned) so the row does not pretend it went out; anything else counts
   * as sent and starts the cooldown.
   */
  onSend: (text: string) => boolean | void;
  /** Chat is banned here, or the viewer is an observer who may not post. */
  disabled?: boolean;
  /** Override the cooldown; TableChat passes its own SEND_COOLDOWN_MS. */
  cooldownMs?: number;
  /** Override the phrase set (tests, and any future per-club list). */
  presets?: readonly string[];
}

export function QuickChatPresets({
  onSend,
  disabled = false,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  presets = QUICK_CHAT_PRESETS,
}: QuickChatPresetsProps) {
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A timer that fires after the sheet closes would setState on a dead tree.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    []
  );

  const handlePreset = useCallback(
    (text: string) => {
      if (disabled || isCoolingDown) return;
      if (onSend(text) === false) return;
      setIsCoolingDown(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setIsCoolingDown(false);
      }, cooldownMs);
    },
    [disabled, isCoolingDown, onSend, cooldownMs]
  );

  const inert = disabled || isCoolingDown;

  return (
    <div className="quick-chat" aria-label="Quick Chat">
      <div className="qc-presets">
        {presets.map((text) => (
          <button
            key={text}
            type="button"
            className={`qc-preset-btn${inert ? ' qc-cooldown' : ''}`}
            onClick={() => handlePreset(text)}
            disabled={inert}
            aria-label={`Send ${text}`}
          >
            <span className="qc-text">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default QuickChatPresets;
