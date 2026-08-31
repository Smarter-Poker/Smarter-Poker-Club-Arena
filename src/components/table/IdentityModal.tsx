/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IDENTITY MODAL — the table alias, and whether it is being used
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Backed by `user_table_settings.use_alias` / `.table_alias` (see
 * useUserTableSettings), which is the SAME pair TablePage's hero-name
 * derivation reads — so what this dialog says and what the felt shows cannot
 * disagree.
 *
 * AUDIT 2026-08-25: this file existed for weeks with no caller. It is mounted
 * for the first time in this pass, so everything a modal only discovers once a
 * player can reach it was missing and is added here:
 *   - it is PORTALLED. TablePage's tree is full of `transform`/`filter`
 *     ancestors (.table-scaler above all), and a `position: fixed` overlay
 *     rendered inside one is positioned against that ancestor, not the
 *     viewport. Every other overlay at this table portals for the same reason.
 *   - Escape closes it, focus moves in on open, Tab is trapped inside it, and
 *     focus is handed back to whatever opened it. Without that, a keyboard user
 *     opening this from the table menu tabs straight through the felt behind
 *     the backdrop.
 *   - `role="dialog"` + `aria-modal` + a labelled heading, and both controls
 *     carry real accessible names. The toggle was an empty <button> holding two
 *     decorative spans: a screen reader announced nothing at all.
 *   - the alias is TRIMMED before it is compared or saved, so " " is not a
 *     change and " Dan " and "Dan" are the same alias.
 *   - IT EXPLAINS ITSELF. Turning the alias on with no alias typed used to do
 *     nothing visible, because TablePage's derivation is
 *     `use_alias && table_alias` and an empty alias silently falls through to
 *     the real name. The live preview row states the name that will actually
 *     appear, and the state where those two disagree now says so.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import './IdentityModal.css';

/** Matches the `maxLength` on the input and the column the alias is saved to. */
export const TABLE_ALIAS_MAX = 20;

/**
 * One normalizer, used for the comparison, the save and the preview, so the
 * three can never disagree about what the alias "is". Collapses runs of
 * whitespace and strips control characters — a name is rendered into a seat
 * plate, and a tab or a newline there is a broken plate.
 */
export function normalizeAlias(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

interface IdentityModalProps {
  isOpen: boolean;
  onClose: () => void;
  useAlias: boolean;
  tableAlias: string;
  onToggleAlias: () => void;
  onSetAlias: (alias: string) => void;
  /**
   * The name shown at the table when the alias is OFF (or empty). Optional so
   * the dialog is usable without it; a caller that knows the hero's name should
   * pass it, because the preview is the whole point of the row.
   */
  heroName?: string;
}

export function IdentityModal({
  isOpen,
  onClose,
  useAlias,
  tableAlias,
  onToggleAlias,
  onSetAlias,
  heroName,
}: IdentityModalProps) {
  const [aliasInput, setAliasInput] = useState(tableAlias);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAliasInput(tableAlias);
    }
  }, [isOpen, tableAlias]);

  // Focus in on open, back out on close.
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement) || null;
    const node = dialogRef.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])'
      );
      (first || node).focus({ preventScroll: true });
    }
    return () => {
      const back = restoreFocusRef.current;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        back.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const onDialogKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const focusable = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
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

  const cleanAlias = useMemo(() => normalizeAlias(aliasInput), [aliasInput]);
  const isDirty = cleanAlias !== normalizeAlias(tableAlias);
  /** The alias is on but there is nothing to show — the felt falls back. */
  const aliasOnButEmpty = useAlias && cleanAlias.length === 0;
  const shownName = useAlias && cleanAlias ? cleanAlias : heroName || 'Your Usual Name';

  const commit = useCallback(() => {
    if (isDirty) onSetAlias(cleanAlias);
    onClose();
  }, [isDirty, cleanAlias, onSetAlias, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="identity-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="identity-modal-content"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-modal-title"
      >
        <div className="identity-modal-header">
          <h2 id="identity-modal-title">Identity Settings</h2>
          <button className="identity-modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="identity-modal-body">
          <div className="identity-modal-row">
            <label htmlFor="identity-alias-toggle">Use Alias At Tables</label>
            <button
              id="identity-alias-toggle"
              type="button"
              role="switch"
              aria-checked={useAlias}
              aria-label="Use Alias At Tables"
              className={`tsp-toggle ${useAlias ? 'tsp-toggle--on' : 'tsp-toggle--off'}`}
              onClick={onToggleAlias}
            >
              <span className="tsp-toggle__track">
                <span className="tsp-toggle__thumb" />
              </span>
            </button>
          </div>
          <div className="identity-modal-row">
            <label htmlFor="identity-alias-input">Table Alias</label>
            <input
              id="identity-alias-input"
              type="text"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                }
              }}
              placeholder="Enter Your Alias"
              maxLength={TABLE_ALIAS_MAX}
              autoComplete="off"
              spellCheck={false}
              className="identity-alias-input"
            />
          </div>

          {/* THE ROW THAT EXPLAINS THE OTHER TWO. Without it, "alias on, alias
              empty" is a setting that looks applied and changes nothing. */}
          <div className="identity-modal-preview">
            <span className="identity-modal-preview__label">You Appear At The Table As</span>
            <span className="identity-modal-preview__value">{shownName}</span>
            {aliasOnButEmpty && (
              <span className="identity-modal-preview__hint" role="status">
                Type An Alias Above, Or Your Usual Name Is Shown.
              </span>
            )}
          </div>

          <button className="identity-save-btn" onClick={commit}>
            {isDirty ? 'Save' : 'Done'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default IdentityModal;
