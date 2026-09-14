/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIP INFO MODAL — What The Membership Includes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Simplified modal showing:
 * - What a VIP gets, and what a non-VIP pays for it
 * - Current status
 * - Diamond pricing for non-VIP users
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  VIP_MONTHLY_ALLOWANCES,
  FEATURE_PRICING,
  isPurchasable,
  loadFeaturePricing,
} from '../../services/VIPService';
import { useVIPStatus } from '../../hooks/useVIP';
import { openInBrowser } from '../../lib/openExternal';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import './VIPCardsModal.css';

/** Where a membership is bought. Opened in a new tab, never a redirect away from a table. */
const MEMBERSHIP_URL = 'https://smarter.poker/subscribe';

interface VIPInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * EVERY ROW IS A PROMISE, SO EVERY ROW IS ENFORCED SOMEWHERE.
 *
 * Three rows were removed on 2026-09-05 because nothing implemented them:
 *
 *   "Available Themes: 3"          nothing reads it; Table Studio sells themes
 *                                  one at a time and does not meter a VIP.
 *   "Club Creation Limit: 3"       fn_get_club_creation_eligibility caps
 *                                  EVERYONE at 4 club memberships. Not a VIP
 *                                  benefit, and not the number 3.
 *   "Score Leaderboard Boost: 6%"  LeaderboardService applies no boost at all.
 */
const FEATURES = [
  {
    key: 'rabbit_hunt',
    label: 'Rabbit Hunting',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.rabbitHunts} / mo`,
  },
  { key: 'show_stack_bb', label: 'Show Stack In BBs', vipFree: true },
  { key: 'offline_protection', label: 'Offline Protection', vipFree: true },
  { key: 'auto_time_bank', label: 'Auto Time Bank', vipFree: true },
  {
    key: 'time_bank_seconds',
    label: 'Free Time Bank',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s / mo`,
  },
  {
    key: 'emoji_pack',
    label: 'Free Emojis',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString()} / mo`,
  },
  {
    key: 'tag_pack',
    label: 'Player Tags',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.tags.toLocaleString()} / mo`,
  },
] as const;

export function VIPCardsModal({ isOpen, onClose }: VIPInfoModalProps) {
  const { isVIP, isLoading } = useVIPStatus();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  /**
   * Bumped once the server's own price table has been read, purely to re-render
   * with whatever it said. THIS TABLE IS A PRICE LIST AND IT MUST BE TRUE:
   * on 2026-08-25 it printed "0/session" and "Free" for two features that the
   * server charges 5 and 10 diamonds for. loadFeaturePricing patches
   * FEATURE_PRICING in place and reports the drift; without this state bump the
   * patch would land after render and the stale number would stay on screen.
   */
  const [pricingRevision, setPricingRevision] = useState(0);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    // Never rejects: it falls back to the cached table and reports the failure.
    loadFeaturePricing().then(() => {
      if (alive) setPricingRevision((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = FEATURES.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const pill = isLoading ? 'Checking' : isVIP ? 'Active' : 'Pay Per Use';
  const pillInk: ConsoleInk = isLoading ? 'muted' : isVIP ? 'green' : 'blue';

  /* ONE CONSOLE, ONE CREST (#ClubArenaConsole). The chassis is the spade
     master wearing the VIP crest; every word on it is printed on the black
     glass in the master's own inks. A member sees a page of content and one
     way out, so the foot is the flat cap and CLOSE is a lit word. A
     non-member sees a message and two actions, so the foot carries the two
     painted plates: Close on steel, Join on the blue glass. */
  return (
    <div className="vip-modal-overlay" onClick={onClose}>
      <div
        className="vipc"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vip-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          crest="vip"
          eyebrow="Club Arena Membership"
          title="VIP"
          titleId="vip-modal-title"
          pill={pill}
          pillInk={pillInk}
          foot={isVIP ? 'foot' : 'plates'}
          plates={
            isVIP
              ? undefined
              : {
                  secondary: { label: 'Close', ink: 'silver', onClick: onClose },
                  primary: {
                    label: 'Join Membership',
                    ink: 'white',
                    onClick: () => openInBrowser(MEMBERSHIP_URL),
                  },
                }
          }
          className="vipc__console"
        >
          {/* Status */}
          {isLoading ? (
            <p className="sc-copy sc-copy--center vipc__status" role="status">
              Checking Status
            </p>
          ) : isVIP ? (
            <div className="vipc__status">
              <p className="vipc__status-line sc-ink--green">Membership Active</p>
              <p className="sc-copy sc-copy--center">Included With Club Arena Membership</p>
            </div>
          ) : (
            <div className="vipc__status">
              <p className="vipc__status-line sc-ink--silver">Pay Per Feature</p>
              <p className="sc-copy sc-copy--center">Or Join Club Arena For A Membership</p>
            </div>
          )}

          {/* Features: rows on the glass, an engraved rule between each. */}
          <div className="vipc__table" role="table" aria-label="VIP Features">
            <div className="vipc__row vipc__row--head" role="row">
              <span className="sc-label sc-ink--blue" role="columnheader">
                Feature
              </span>
              <span className="sc-label sc-ink--blue vipc__cell--end" role="columnheader">
                VIP
              </span>
              <span className="sc-label sc-ink--blue vipc__cell--end" role="columnheader">
                Diamond Cost
              </span>
            </div>
            {FEATURES.map((feature, i) => {
              const pricing = FEATURE_PRICING[feature.key as keyof typeof FEATURE_PRICING];
              const vipFree = 'vipFree' in feature && feature.vipFree;
              const vipValue = 'vipValue' in feature ? feature.vipValue : null;
              /**
               * A price is a promise. Print one only for something the server
               * has a price row for; otherwise say so. `auto_time_bank` was
               * advertised at 5 diamonds while fn_purchase_feature answered
               * "unknown feature" for it, so the row quoted a charge that
               * could never be made.
               */
              const sellable = isPurchasable(feature.key);
              return (
                <div
                  key={feature.key}
                  role="row"
                  className="vipc__row"
                  style={{
                    opacity: visibleItems.has(i) ? 1 : 0,
                    transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className="vipc__feature sc-ink--silver" role="cell">
                    {feature.label}
                  </span>
                  <span
                    className={`vipc__value vipc__cell--end ${vipFree ? 'sc-ink--green' : 'sc-ink--blue'}`}
                    role="cell"
                  >
                    {vipFree ? 'Free' : vipValue || ''}
                  </span>
                  <span
                    className="vipc__value vipc__cell--end sc-ink--muted"
                    role="cell"
                    data-pricing-revision={pricingRevision}
                  >
                    {!pricing
                      ? '-'
                      : !sellable
                        ? 'Not For Sale'
                        : `${pricing.cost.toLocaleString()}/${pricing.usageType.replace('per_', '').replace('_', ' ')}`}
                  </span>
                </div>
              );
            })}
          </div>

          {isVIP && (
            <div className="vipc__actions">
              <button type="button" className="vipc-word sc-ink--white" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}

export default VIPCardsModal;
