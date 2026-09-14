/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER BLOCK MODAL — Confirmation for Blocking a Player
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ── ON THE SPADE CONSOLE (#ClubArenaConsole) ────────────────────────────────
 * This was a rounded card washed in a red gradient, with a bordered "!" tile
 * stuck beside the heading, red disc markers down a bullet list, a bordered
 * text box for the reason and two rounded buttons underneath. It is now Dan's
 * approved spade master, cut into head / rails / foot by SpadeConsole: the
 * heading engraved in the header well, SURE? in the well's painted pill slot,
 * what a block does printed as rows on the black glass, the reason field a
 * groove cut into that glass, and the two actions on the painted plates in
 * the foot - CANCEL on steel, BLOCK PLAYER in red ink on the blue glass.
 *
 * Nothing about the behaviour changed. The focus trap, the Escape guard that
 * refuses while a request is in flight, the returned focus, the submitting
 * ref, the submit error and its `role="alert"` are all the ones that were here.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { SpadeConsole } from '../console/SpadeConsole';
import './PlayerBlockModal.css';

interface PlayerBlockModalProps {
  playerName: string;
  onConfirm: (reason?: string) => void | Promise<void>;
  onCancel: () => void;
}

/** What a block does. Rows on the glass, never a bulleted list with markers. */
const BLOCK_EFFECTS = [
  'Prevent Them From Messaging You',
  'Remove Them From Your Friends List',
  'Hide Them From Your Friend Suggestions',
  'Block Friend Requests Between You',
] as const;

export default function PlayerBlockModal({
  playerName,
  onConfirm,
  onCancel,
}: PlayerBlockModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const submittingRef = useRef(submitting);
  const titleId = useId();
  const reasonId = useId();
  onCancelRef.current = onCancel;
  submittingRef.current = submitting;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submittingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeys);
    return () => {
      document.removeEventListener('keydown', handleDialogKeys);
      previouslyFocused?.focus();
    };
  }, []);

  const handleConfirm = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await onConfirm(reason.trim() || undefined);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Player could not be blocked.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="block-modal-overlay" onClick={() => !submitting && onCancel()}>
      <div
        ref={dialogRef}
        className="block-modal ac-popup"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={submitting || undefined}
      >
        <SpadeConsole
          as="div"
          eyebrow="Player Safety"
          title={`Block ${playerName}?`}
          titleId={titleId}
          pill="Sure?"
          pillInk="red"
          plates={{
            secondary: {
              label: 'Cancel',
              onClick: onCancel,
              disabled: submitting,
            },
            primary: {
              label: submitting ? 'Blocking' : 'Block Player',
              ink: 'red',
              onClick: handleConfirm,
              disabled: submitting,
            },
          }}
        >
          <span className="block-warning sc-label sc-ink--blue">Blocking This Player Will</span>
          <ul className="block-effects">
            {BLOCK_EFFECTS.map((effect) => (
              <li key={effect} className="block-effect sc-copy">
                {effect}
              </li>
            ))}
          </ul>

          {/* A groove cut into the glass, not a bordered box. */}
          <div className="block-reason-field">
            <label htmlFor={reasonId} className="block-reason-label sc-label sc-ink--blue">
              Reason (Optional)
            </label>
            <input
              id={reasonId}
              className="block-reason-input"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why Are You Blocking This Player?"
              maxLength={200}
              autoFocus
            />
          </div>

          {submitError && (
            <p className="block-modal-error sc-copy sc-ink--red" role="alert">
              {submitError}
            </p>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}
