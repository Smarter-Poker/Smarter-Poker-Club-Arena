/**
 * LIGHTNING PHASE 8: THE DECISION QUEUE STRIP.
 *
 * Every Lightning room where the player owes a decision right now, ordered
 * by the time left on the engine's clock, most urgent first. Each entry is a
 * button: one tap brings that room to the front.
 *
 * ═══ CLAUDE.md 10.6: NEVER AUTO-CHANGE TABLES ══════════════════════════════
 * Dan: "YOU CAN NEVER EVER AUTO CHANGE TABLES FOR A USER, THEY MUST CHANGE IT
 * BY THEM SELF." This strip only SIGNALS: it lists, counts down and colours
 * the urgent entries. The view moves only from the entry's onClick. There is
 * no timer, effect or setting here that focuses a room, and there must never
 * be one, however opt-in.
 */
import { useEffect, useState } from 'react';
import {
  lightningDecisionUrgency,
  pruneLightningDecisions,
} from '../../lightning/lightningDecisionQueue';
import { useLightningDecisions } from './useLightningDecisions';
import { getLightningPoolSession } from '../../lightning/lightningSession';
import { serverNow } from '../../utils/serverClock';
import './LightningSession.css';

export interface LightningDecisionQueueProps {
  /** The room on screen now; its own entry is shown as current, not as a door. */
  activeRoomId: string | null;
  /** The player's tap: bring this room to the front. */
  onFocus: (poolSessionId: string) => void;
}

const STREET_LABEL: Record<string, string> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};

export default function LightningDecisionQueue({
  activeRoomId,
  onFocus,
}: LightningDecisionQueueProps) {
  const decisions = useLightningDecisions();
  const [now, setNow] = useState(() => serverNow());
  const any = decisions.length > 0;
  /* The countdown repaints once a second while something is owed, and the
     ticker stops the moment nothing is. It only re-reads the clock. */
  useEffect(() => {
    if (!any) return undefined;
    setNow(serverNow());
    const t = setInterval(() => {
      const n = serverNow();
      pruneLightningDecisions(n);
      setNow(n);
    }, 1000);
    return () => clearInterval(t);
  }, [any]);

  const waiting = decisions.filter((d) => d.poolSessionId !== activeRoomId);
  if (waiting.length === 0) return null;
  return (
    <nav
      className="lightning-queue"
      aria-label="Decision Queue"
      data-testid="lightning-decision-queue"
    >
      <span className="lightning-queue__label">Your Action</span>
      <ol className="lightning-queue__list">
        {waiting.map((d) => {
          const left = Math.max(0, d.deadlineAt - now);
          const urgency = lightningDecisionUrgency(left);
          const name = getLightningPoolSession(d.poolSessionId)?.meta?.name ?? 'Lightning';
          return (
            <li key={d.handId}>
              <button
                type="button"
                className={`lightning-queue__item lightning-queue__item--${urgency}`}
                data-testid="lightning-decision"
                data-room={d.poolSessionId}
                data-urgency={urgency}
                onClick={() => onFocus(d.poolSessionId)}
              >
                <span className="lightning-queue__name">{name}</span>
                <span className="lightning-queue__street">{STREET_LABEL[d.street] ?? ''}</span>
                <span className="lightning-queue__time">
                  {Math.ceil(left / 1000).toLocaleString()}s
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
