/**
 * LIGHTNING PHASE 6: THE ANCHOR TABLE WHILE JOIN LIGHTNING COMPLETES.
 *
 * Between the buy-in landing and the pool session appearing, the anchor table
 * the player bought in through will never deal them a hand. Rather than leave
 * them looking at that felt, the table says one neutral line until the tab
 * moves on, and offers a way to stop waiting. Nothing here describes what the
 * machinery is doing.
 */
import { LIGHTNING_JOINING_TEXT } from '../../lightning/useLightningAnchorHandoff';
import './LightningFoldBar.css';

export default function LightningJoining({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      className="lightning-joining"
      data-testid="lightning-joining"
      role="status"
      aria-live="polite"
    >
      <p className="lightning-joining__text">{LIGHTNING_JOINING_TEXT}</p>
      <button
        type="button"
        className="lightning-joining__cancel"
        data-testid="lightning-joining-cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
