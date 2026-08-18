/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ INFO MODAL — opened by tapping the jackpot amount at the table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "we should be showing the last 5 jackpots, what the hands were, what the
 * payouts were, who got paid what (PokerBros style) ... displayed inside one of
 * the pages when you click on the BBJ amount at the top of a table."
 *
 * Two tabs: the recent hits (default — it is what the tap is for) and the rules
 * for THIS table's game and stakes, so a player can see what they are chasing
 * and what it would pay them without leaving the table.
 */

import { useEffect, useState } from 'react';
import BBJRecentHits from '../bbj/BBJRecentHits';
import { getBBJQualifyingInfo, getBBJPayoutPercentForBB } from '../../config/RakeConfig';
import './BBJInfoModal.css';

export interface BBJInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  poolId: string | null;
  poolAmount: number;
  /** Table's game variant (key or display name) for the rules tab. */
  gameType?: string | null;
  /** Table's big blind, for the "what this table pays" figure. */
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
  const [tab, setTab] = useState<'hits' | 'rules'>('hits');

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
            aria-selected={tab === 'rules'}
            className={`bbj-modal__tab${tab === 'rules' ? ' is-active' : ''}`}
            onClick={() => setTab('rules')}
          >
            This table
          </button>
        </div>

        <div className="bbj-modal__body">
          {tab === 'hits' ? (
            <BBJRecentHits poolId={poolId} limit={5} currentUserName={currentUserName} />
          ) : (
            <div className="bbj-modal__rules">
              {info.eligible ? (
                <>
                  <div className="bbj-modal__rule-block">
                    <span className="bbj-modal__rule-label">To qualify here</span>
                    <p className="bbj-modal__rule-text">{info.shortLabel}</p>
                    {info.subLabel && <p className="bbj-modal__rule-sub">{info.subLabel}</p>}
                  </div>

                  <div className="bbj-modal__rule-block">
                    <span className="bbj-modal__rule-label">What this table pays</span>
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

                  <p className="bbj-modal__fineprint">
                    Chips are credited to your stack at the table the moment it hits &mdash; and
                    they leave with you.
                  </p>
                </>
              ) : (
                <div className="bbj-modal__rule-block">
                  <p className="bbj-modal__rule-text">
                    The Bad Beat Jackpot is not available for {info.variantLabel}.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default BBJInfoModal;
