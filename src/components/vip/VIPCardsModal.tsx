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
import type { VipStatus } from '../../utils/vipStatus';
import './VIPCardsModal.css';

interface VIPInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  vipStatus: VipStatus;
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
    label: 'Rabbit Hunts',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.rabbitHunts} / Mo`,
    lifetimeValue: 'Unlimited',
  },
  {
    key: 'show_stack_bb',
    label: 'Show Stack In BBs',
    vipFree: true,
    lifetimeValue: 'Included',
  },
  {
    key: 'offline_protection',
    label: 'Offline Protection',
    vipFree: true,
    lifetimeValue: 'Included',
  },
  {
    key: 'auto_time_bank',
    label: 'Auto Time Bank',
    vipFree: true,
    lifetimeValue: 'Included',
  },
  {
    key: 'time_bank_seconds',
    label: 'Free Time Bank',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.timeBankSeconds}s / Mo`,
    lifetimeValue: 'Unlimited Standard 20-Second Activations',
  },
  {
    key: 'emoji_pack',
    label: 'Free Emojis',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.emojis.toLocaleString()} / Mo`,
    lifetimeValue: 'All Digital Packs',
  },
  {
    key: 'tag_pack',
    label: 'Player Tags',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.tags.toLocaleString()} / Mo`,
    lifetimeValue: 'All Digital Packs',
  },
  {
    key: 'throwable',
    label: 'Throwables',
    vipValue: `${VIP_MONTHLY_ALLOWANCES.throwables.toLocaleString()} / Mo`,
    lifetimeValue: 'Unlimited',
  },
] as const;

export function VIPCardsModal({ isOpen, onClose, vipStatus }: VIPInfoModalProps) {
  const isVIP = vipStatus !== 'none';
  const isLifetime = vipStatus === 'lifetime';
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

  return (
    <div className="vip-modal-overlay" onClick={onClose}>
      <div className="vip-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="vip-modal__header">
          <h2>{isLifetime ? 'Lifetime VIP' : 'VIP'}</h2>
          <button
            type="button"
            className="vip-modal__close"
            onClick={onClose}
            aria-label="Close VIP Benefits"
          >
            ×
          </button>
        </div>

        {/* Status */}
        <div className="vip-modal__status-section">
          {isVIP ? (
            <div className="vip-status-active">
              <span className="vip-crown"></span>
              <span>{isLifetime ? 'Lifetime Membership Active' : 'Membership Active'}</span>
              <span className="vip-sub">
                {isLifetime
                  ? 'Unlimited Digital Club Arena Benefits Active'
                  : 'Included With Club Arena Membership'}
              </span>
            </div>
          ) : (
            <div className="vip-status-inactive">
              <span> Pay Per Feature</span>
              <span className="vip-sub">Or Join Club Arena For A Membership</span>
            </div>
          )}
        </div>

        {/* Features Table */}
        <div className="vip-modal__features">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>VIP</th>
                <th>Diamond Cost</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((feature, i) => {
                const pricing = FEATURE_PRICING[feature.key as keyof typeof FEATURE_PRICING];
                const vipFree = 'vipFree' in feature && feature.vipFree;
                const vipValue = 'vipValue' in feature ? feature.vipValue : null;
                const lifetimeValue = feature.lifetimeValue;
                /**
                 * A price is a promise. Print one only for something the server
                 * has a price row for; otherwise say so. `auto_time_bank` was
                 * advertised at 5 diamonds while fn_purchase_feature answered
                 * "unknown feature" for it, so the row quoted a charge that
                 * could never be made.
                 */
                const sellable = isPurchasable(feature.key);
                return (
                  <tr
                    key={feature.key}
                    style={{
                      opacity: visibleItems.has(i) ? 1 : 0,
                      transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <td className="feature-name">{feature.label}</td>
                    <td className="feature-vip">
                      {isLifetime ? lifetimeValue : vipFree ? 'Free' : vipValue || ''}
                    </td>
                    <td className="feature-cost" data-pricing-revision={pricingRevision}>
                      {!pricing
                        ? '-'
                        : !sellable
                          ? 'Not For Sale'
                          : `${pricing.cost.toLocaleString()} / ${pricing.usageType
                              .split('_')
                              .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                              .join(' ')}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {isLifetime && (
          <section className="vip-modal__status-section" aria-label="Lifetime Digital Collection">
            <strong>Lifetime Digital Collection</strong>
            <span>All Cataloged Table Skins And Backgrounds</span>
            <span>All Cataloged Card Backs And Dealer Buttons</span>
            <span>All VIP Avatars, Frames, And Auras</span>
          </section>
        )}

        {/* CTA */}
        {!isVIP && (
          <div className="vip-modal__cta">
            <a href="/hub/vip-membership" className="vip-upgrade-btn">
              Join Club Arena For A Membership
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default VIPCardsModal;
