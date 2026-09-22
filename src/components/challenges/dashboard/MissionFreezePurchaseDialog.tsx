import type { RefObject } from 'react';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { CasinoControlIcon } from '../CasinoControlIcon';
import { DiamondMark, FreezeVaultGraphic } from './MissionArtwork';

export function MissionFreezePurchaseDialog({
  diamondBalance,
  buyingFreeze,
  dialogRef,
  onDismiss,
  onConfirmPurchase,
}: {
  diamondBalance: number;
  buyingFreeze: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
  onConfirmPurchase: () => void;
}) {
  return (
    <div
      className={styles.celebrateOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="freeze-purchase-title"
      aria-describedby="freeze-purchase-description"
      onClick={onDismiss}
    >
      <div
        ref={dialogRef}
        className={`${styles.celebrateCard} ${styles.freezeDialogCard}`}
        data-dialog-card="fixed-frame"
        onClick={(event) => event.stopPropagation()}
      >
        <span className={styles.bevelFrame} data-dialog-frame="fixed" aria-hidden="true" />
        <div className={styles.celebrateCardScroll} data-dialog-scroll="true">
          <FreezeVaultGraphic />
          <span className={styles.panelLabel}>Streak Protection Desk</span>
          <h2 id="freeze-purchase-title" className={styles.celebrateTitle} tabIndex={-1}>
            Secure A Streak Freeze?
          </h2>
          <p id="freeze-purchase-description" className={styles.freezeDialogDescription}>
            One Freeze Protects Your Current Run Through One Missed Daily Challenge Cycle.
          </p>
          <div className={styles.freezePurchaseLedger}>
            <div>
              <span>Vault Price</span>
              <strong className={styles.balanceWithGem}>
                <DiamondMark /> 5,000 Diamonds
              </strong>
            </div>
            <div>
              <span>Balance After Purchase</span>
              <strong className={styles.balanceWithGem}>
                <DiamondMark /> {Math.max(0, diamondBalance - 5000).toLocaleString()} Diamonds
              </strong>
            </div>
          </div>
          <div className={styles.freezeDialogActions}>
            <button
              type="button"
              className={styles.cancelButton}
              disabled={buyingFreeze}
              onClick={onDismiss}
            >
              <CasinoControlIcon variant="keep" state="idle" size="sm" />
              Keep My Diamonds
            </button>
            <button
              type="button"
              className={styles.confirmButton}
              onClick={onConfirmPurchase}
              disabled={buyingFreeze}
              aria-busy={buyingFreeze}
            >
              <CasinoControlIcon
                variant="freeze"
                state={buyingFreeze ? 'pending' : 'attention'}
                size="sm"
              />
              {buyingFreeze ? 'Confirming Purchase...' : 'Buy Streak Freeze'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
