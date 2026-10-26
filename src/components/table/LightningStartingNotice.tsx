/**
 * LIGHTNING TRANSITION: THE TABLE WHILE ITS GAME SWITCHES INTO LIGHTNING.
 *
 * Dan approved, 2026-10-26: "show Lightning Is Starting during the switch".
 * While a MUST MOVE game converts (pending_on) every table finishes the hand in
 * play and deals no other; this line says why the felt has gone quiet, until
 * the conversion's own notice ("Your Game Is Now Lightning", with VIEW GAME)
 * takes over. Words only. Nothing here navigates, ever (CLAUDE.md 10.6).
 */
import { LIGHTNING_STARTING_TEXT } from '../../lightning/lightningHand';
import './LightningFoldBar.css';

export default function LightningStartingNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="lightning-ending" data-testid="lightning-starting" role="status">
      {LIGHTNING_STARTING_TEXT}
    </p>
  );
}
