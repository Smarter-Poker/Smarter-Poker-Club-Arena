/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CREATE UNION - a club owner opens a network, on the master
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #ClubArenaConsole (2026-09-14). This was a rounded translucent card built
 * out of `--surface-card`, `--radius-xl` and `--space-*`, and it had three
 * defects that only a render shows:
 *
 *   1. IT WAS NOT A DIALOG. No `role="dialog"`, no `aria-modal`, no Escape,
 *      no focus trap and no focus return. `metallic-popups.css` scopes every
 *      control it dresses to `[role='dialog']`, so both fields rendered as
 *      RAW BROWSER INPUTS - white boxes with a monospace placeholder - on a
 *      black sheet. The missing role was not only an accessibility defect,
 *      it was the reason the form looked unfinished.
 *   2. Its tokens are declared in design-system.css / globals.css, neither of
 *      which main.tsx imports, so `--radius-xl`, `--space-6` and
 *      `--surface-card` were undefined at runtime.
 *   3. Its toast copy was sentence case ("You must be logged in to create a
 *      union") in a product where every string a player reads is Title Case.
 *
 * It is now Dan's approved spade master: the frame, the header well and both
 * action plates are painted, and this component prints CREATE UNION into the
 * well, the two fields on the black glass between the rails, and CANCEL /
 * CREATE UNION onto the two plates. Two actions, so the foot carries plates.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { unionService } from '../../services/UnionService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './CreateUnionModal.module.css';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';

interface CreateUnionModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function CreateUnionModal({ onClose, onSuccess }: CreateUnionModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** Synchronous guard: two taps can land before React paints `loading`. */
  const busyRef = useRef(false);

  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    onClose();
  }, [onClose]);

  /* Escape closes, focus moves in on open and is handed back on close. Without
     it a keyboard user tabs straight through the page behind the backdrop. */
  useEffect(() => {
    restoreFocusRef.current = (document.activeElement as HTMLElement) || null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const back = restoreFocusRef.current;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        back.focus({ preventScroll: true });
      }
    };
  }, [requestClose]);

  const onDialogKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const focusable = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user?.id) {
      toast.error('You Must Be Signed In To Create A Union');
      return;
    }
    if (busyRef.current) return;

    const ownerId = user.id;

    busyRef.current = true;
    setLoading(true);
    try {
      await unionService.createUnion(name, description, ownerId);
      toast.success('Union Created');
      onSuccess();
    } catch (error) {
      reportError(error, 'CreateUnionModal.Failed_to_create_union');
      toast.error('Could Not Create That Union. Please Try Again.');
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  const canSubmit = name.trim().length > 0 && !loading;

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className={styles.sheet}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-union-title"
        onKeyDown={onDialogKeyDown}
      >
        <form onSubmit={handleSubmit}>
          <SpadeConsole
            className={styles.console}
            /* The club medallion: a union is a network of CLUBS, and the crest
               is the one thing this standard lets a surface vary. */
            crest="club"
            eyebrow="Union"
            title="Create Union"
            titleId="create-union-title"
            pill="New"
            pillInk="blue"
            foot="plates"
            plates={{
              secondary: {
                label: 'Cancel',
                ink: 'silver',
                onClick: requestClose,
                disabled: loading,
              },
              primary: {
                label: loading ? 'Creating' : 'Create Union',
                ink: 'white',
                type: 'submit',
                disabled: !canSubmit,
              },
            }}
          >
            <p className={styles.copy}>
              A Union Is A Network Of Clubs That Share One Bank, One Jackpot And One Player
              Directory. You Become Its Owner.
            </p>

            <label className={styles.field} htmlFor="create-union-name">
              <span className={styles.label}>Union Name</span>
              <input
                id="create-union-name"
                type="text"
                maxLength={80}
                className={styles.input}
                placeholder="E.G. Global Poker Alliance"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={loading}
                required
                autoFocus
              />
            </label>

            <label className={styles.field} htmlFor="create-union-description">
              <span className={styles.label}>Description (Optional)</span>
              <textarea
                id="create-union-description"
                className={styles.input}
                maxLength={400}
                placeholder="Briefly Describe Your Union's Purpose And Region"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loading}
                rows={4}
              />
            </label>
          </SpadeConsole>
        </form>
      </div>
    </div>
  );
}
