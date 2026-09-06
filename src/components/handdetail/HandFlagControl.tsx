/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FLAG THIS HAND — one button, and then the player is told what happened
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 6 of the Previous Hand build plan (2026-09-06). It sits under the
 * expanded hand, beside the private note, because those are the two things a
 * player wants to do with a hand they are staring at: keep a thought, or send
 * it to somebody. One is private forever; this one goes to the club.
 *
 * THE STATUS IS THE FEATURE. A flag that vanishes into a queue is the thing
 * players already had - `ReportPlayerPage` files a report and never speaks
 * again. Once filed, this shows where it got to and, when it is closed, the
 * operator's own words. `fn_ca_resolve_hand_flag` will not close one without
 * them, so there is always something here to read.
 *
 * IT SAYS "SENT" ONLY WHEN IT WAS SENT, the same rule as the note editor and
 * for the same reason: a player who believes an operator has their complaint
 * stops chasing it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  handFlagService,
  FLAG_NOTE_MAX,
  FLAG_NOTE_MIN,
  FLAG_STATUS_LABEL,
  type HandFlag,
} from '../../services/HandFlagService';
import './HandFlagControl.css';

export interface HandFlagControlProps {
  handId: string;
  /** The flag already loaded by the page, when it has one. */
  flag?: HandFlag | null;
  /**
   * True when the page's answer is AUTHORITATIVE for this hand - it asked for
   * these hand ids and this one came back without a row. Absent, a null is
   * only "the page does not know", and this asks before it offers to file a
   * second flag on a hand that already has one.
   */
  flagKnown?: boolean;
  onFiled?: (handId: string, flag: HandFlag | null) => void;
}

type SendState = 'idle' | 'sending' | 'sent' | 'failed';

export default function HandFlagControl({
  handId,
  flag,
  flagKnown,
  onFiled,
}: HandFlagControlProps) {
  const [known, setKnown] = useState<HandFlag | null>(flag ?? null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [state, setState] = useState<SendState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* A different hand is a different flag. Keyed on the HAND so a re-render of
     the page's map cannot reset an open form mid-sentence. */
  useEffect(() => {
    setKnown(flag ?? null);
    setOpen(false);
    setText('');
    setState('idle');
    setProblem(null);
    if (flag == null && !flagKnown) {
      let alive = true;
      void handFlagService.mineFor([handId]).then((map) => {
        if (alive) setKnown(map.get(handId) ?? null);
      });
      return () => {
        alive = false;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handId]);

  /* A flag arriving from the page later still lands. */
  useEffect(() => {
    if (flag) setKnown(flag);
  }, [flag]);

  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
    },
    []
  );

  const send = useCallback(async () => {
    setState('sending');
    setProblem(null);
    const result = await handFlagService.flag(handId, text);
    if (!result.ok) {
      setState('failed');
      setProblem(result.error ?? 'Could Not Send That To The Operators');
      return;
    }
    setKnown(result.flag);
    setState('sent');
    setOpen(false);
    onFiled?.(handId, result.flag);
    if (sentTimer.current) clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setState('idle'), 3000);
  }, [handId, text, onFiled]);

  const enough = text.trim().length >= FLAG_NOTE_MIN;

  /* ALREADY FILED. Show where it got to, not another button. */
  if (known) {
    return (
      <div className={`hand-flag hand-flag--filed is-${known.status}`}>
        <div className="hand-flag__head">
          <span className="hand-flag__title">Sent To The Operators</span>
          <span className={`hand-flag__status is-${known.status}`}>
            {FLAG_STATUS_LABEL[known.status]}
          </span>
        </div>
        <p className="hand-flag__yours">{known.note}</p>
        {known.operatorNote ? (
          <div className="hand-flag__reply">
            <span className="hand-flag__reply-label">The Club Replied</span>
            <p className="hand-flag__reply-body">{known.operatorNote}</p>
          </div>
        ) : (
          <p className="hand-flag__waiting">
            An Operator Has Not Answered This Yet. You Will See Their Reply Here.
          </p>
        )}
        {state === 'sent' && <span className="hand-flag__ok">Sent</span>}
      </div>
    );
  }

  return (
    <div className="hand-flag">
      {!open ? (
        <div className="hand-flag__row">
          <span className="hand-flag__prompt">Something Wrong With This Hand?</span>
          <button type="button" className="hand-flag__btn" onClick={() => setOpen(true)}>
            Flag This Hand
          </button>
        </div>
      ) : (
        <>
          <div className="hand-flag__head">
            <span className="hand-flag__title">Flag This Hand</span>
            <span className="hand-flag__private">Goes To The Club Operators</span>
          </div>
          <textarea
            className="hand-flag__text"
            value={text}
            maxLength={FLAG_NOTE_MAX}
            rows={3}
            autoFocus
            placeholder="What Looked Wrong? The Hand Number And Your Seat Travel With This."
            aria-label="What Looked Wrong With This Hand"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="hand-flag__actions">
            <button
              type="button"
              className="hand-flag__cancel"
              onClick={() => {
                setOpen(false);
                setText('');
                setProblem(null);
                setState('idle');
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="hand-flag__btn"
              onClick={send}
              disabled={state === 'sending' || !enough}
            >
              {state === 'sending' ? 'Sending' : 'Send To The Operators'}
            </button>
          </div>
        </>
      )}
      <div className="hand-flag__status-line" role="status">
        {state === 'failed' && problem && (
          <span className="hand-flag__bad">{problem} Your Words Are Still Here.</span>
        )}
      </div>
    </div>
  );
}
