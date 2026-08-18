/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ INFO MODAL — opened by tapping the jackpot amount at the table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "we should be showing the last 5 jackpots, what the hands were, what the
 * payouts were, who got paid what (PokerBros style) ... displayed inside one of
 * the pages when you click on the BBJ amount at the top of a table."
 *
 * Three tabs: the recent hits (default — it is what the tap is for), the
 * qualifying hand for EVERY game we spread, and the payout ladder for EVERY
 * stakes tier. When opened from a table, that table's game and stakes rows are
 * marked "YOUR GAME" / "YOUR STAKES" and a summary of what a hit would pay
 * right here sits at the top of the payouts tab. Opened from the lobby (no
 * table context) the same tabs show the full tables without the highlight.
 */

import { useEffect, useState } from 'react';
import BBJRecentHits from './BBJRecentHits';
import BBJRulesPanel from './BBJRulesPanel';
import { getBBJQualifyingInfo, getBBJPayoutPercentForBB } from '../../config/RakeConfig';
import './BBJInfoModal.css';

export interface BBJInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  poolId: string | null;
  poolAmount: number;
  /** Table's game variant (key or display name). Omit when opened from a lobby. */
  gameType?: string | null;
  /** Table's big blind, for the "what this table pays" figure. Omit in a lobby. */
  bigBlind?: number;
  currentUserName?: string | null;
}

export function BBJInfoModal({
  isOpen,
  onClose,
  poolId,
  poolAmount,
  gameType,
  bigBlind = 0,
  currentUserName,
}: BBJInfoModalProps) {
  const [tab, setTab] = useState<'hits' | 'qualifying' | 'payouts'>('hits');

  // Escape closes; body scroll locked while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // A lobby opens this with no table context — then we show the full tables
  // only, with nothing marked "yours", instead of inventing a stake.
  const hasTableContext = !!gameType && bigBlind > 0;
  const info = getBBJQualifyingInfo(gameType);
  const pct = getBBJPayoutPercentForBB(bigBlind);
  const tableShare = (poolAmount * pct) / 100;

  return (
    <div className="bbj-modal__backdrop" onClick={onClose} role="presentation">
      <div
        className="bbj-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Bad Beat Jackpot"
      >
        <div className="bbj-modal__header">
          <div className="bbj-modal__title">
            <span className="bbj-modal__label">BAD BEAT JACKPOT</span>
            <span className="bbj-modal__amount">
              ${Math.trunc(poolAmount).toLocaleString('en-US')}
            </span>
          </div>
          <button className="bbj-modal__close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="bbj-modal__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'hits'}
            className={`bbj-modal__tab${tab === 'hits' ? ' is-active' : ''}`}
            onClick={() => setTab('hits')}
          >
            Last 5 jackpots
          </button>
          <button
            role="tab"
            aria-selected={tab === 'qualifying'}
            className={`bbj-modal__tab${tab === 'qualifying' ? ' is-active' : ''}`}
            onClick={() => setTab('qualifying')}
          >
            Qualifying hands
          </button>
          <button
            role="tab"
            aria-selected={tab === 'payouts'}
            className={`bbj-modal__tab${tab === 'payouts' ? ' is-active' : ''}`}
            onClick={() => setTab('payouts')}
          >
            Payouts
          </button>
        </div>

        <div className="bbj-modal__body">
          {tab === 'hits' && (
            <BBJRecentHits poolId={poolId} limit={5} currentUserName={currentUserName} />
          )}

          {tab === 'qualifying' && (
            <div className="bbj-modal__rules">
              {hasTableContext && (
                <div className="bbj-modal__here">
                  {info.eligible ? (
                    <>
                      <span className="bbj-modal__rule-label">At this table</span>
                      <p className="bbj-modal__rule-text">{info.shortLabel}</p>
                      {info.subLabel && <p className="bbj-modal__rule-sub">{info.subLabel}</p>}
                    </>
                  ) : (
                    <p className="bbj-modal__rule-text">
                      The Bad Beat Jackpot is not available for {info.variantLabel}.
                    </p>
                  )}
                </div>
              )}
              <BBJRulesPanel
                section="qualifying"
                embedded
                poolAmount={poolAmount}
                highlightVariantKey={gameType}
                highlightBB={bigBlind}
              />
            </div>
          )}

          {tab === 'payouts' && (
            <div className="bbj-modal__rules">
              {hasTableContext && info.eligible && (
                <div className="bbj-modal__here">
                  <span className="bbj-modal__rule-label">If it hits at this table</span>
                  <p className="bbj-modal__rule-text">
                    <strong>{pct}%</strong> of the pool
                    {poolAmount > 0 && (
                      <> &mdash; about ${Math.trunc(tableShare).toLocaleString('en-US')} today</>
                    )}
                  </p>
                  <div className="bbj-modal__split">
                    <div className="bbj-modal__split-row">
                      <span>Bad beat hand</span>
                      <span>
                        50% &middot; ${Math.trunc(tableShare * 0.5).toLocaleString('en-US')}
                      </span>
                    </div>
                    <div className="bbj-modal__split-row">
                      <span>Won the hand</span>
                      <span>
                        25% &middot; ${Math.trunc(tableShare * 0.25).toLocaleString('en-US')}
                      </span>
                    </div>
                    <div className="bbj-modal__split-row">
                      <span>Everyone else dealt in</span>
                      <span>
                        25% &middot; ${Math.trunc(tableShare * 0.25).toLocaleString('en-US')}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              <BBJRulesPanel
                section="payout"
                embedded
                poolAmount={poolAmount}
                highlightVariantKey={gameType}
                highlightBB={bigBlind}
              />
              <p className="bbj-modal__fineprint">
                Chips are credited to your stack at the table the moment it hits &mdash; and they
                leave with you.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default BBJInfoModal;
