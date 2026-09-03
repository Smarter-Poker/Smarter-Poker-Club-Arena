/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIP INFO MODAL — Show VIP Benefits (Gold Membership)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Simplified modal showing:
 * - VIP Gold benefits (from Club Arena membership)
 * - Current status
 * - Diamond pricing for non-VIP users
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  VIP_GOLD_LIMITS,
  FEATURE_PRICING,
  isPurchasable,
  loadFeaturePricing,
} from '../../services/VIPService';
import { useVIPStatus } from '../../hooks/useVIP';
import './VIPCardsModal.css';

interface VIPInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const FEATURES = [
  { key: 'rabbit_hunt', label: 'Rabbit Hunting', vipFree: true },
  { key: 'show_stack_bb', label: 'Show Stack In BBs', vipFree: true },
  { key: 'offline_protection', label: 'Offline Protection', vipFree: true },
  { key: 'auto_time_bank', label: 'Auto Time Bank', vipFree: true },
  {
    key: 'time_bank_seconds',
    label: 'Free Time Bank',
    vipValue: `${VIP_GOLD_LIMITS.timeBankSeconds}s`,
  },
  { key: 'theme_unlock', label: 'Available Themes', vipValue: `${VIP_GOLD_LIMITS.themes}` },
  {
    key: 'club_creation',
    label: 'Club Creation Limit',
    vipValue: `${VIP_GOLD_LIMITS.clubCreation}`,
  },
  { key: 'emoji_pack', label: 'Free Emojis', vipValue: `${VIP_GOLD_LIMITS.emojis}` },
  { key: 'tag_pack', label: 'Tags', vipValue: `${VIP_GOLD_LIMITS.tags}` },
  {
    key: 'leaderboard',
    label: 'Score Leaderboard Boost',
    vipValue: `${(VIP_GOLD_LIMITS.leaderboardBoost * 100).toFixed(0)}%`,
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

  return (
    <div className="vip-modal-overlay" onClick={onClose}>
      <div className="vip-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="vip-modal__header">
          <h2> VIP GOLD</h2>
          <button className="vip-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Status */}
        <div className="vip-modal__status-section">
          {isLoading ? (
            <p>Checking Status...</p>
          ) : isVIP ? (
            <div className="vip-status-active">
              <span className="vip-crown"></span>
              <span>VIP Gold Active</span>
              <span className="vip-sub">Included With Club Arena Membership</span>
            </div>
          ) : (
            <div className="vip-status-inactive">
              <span> Pay Per Feature</span>
              <span className="vip-sub">Or Upgrade To Club Arena For VIP Gold</span>
            </div>
          )}
        </div>

        {/* Features Table */}
        <div className="vip-modal__features">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>VIP Gold</th>
                <th>Diamond Cost</th>
              </tr>
            </thead>
            <tbody>
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
                  <tr
                    key={feature.key}
                    style={{
                      opacity: visibleItems.has(i) ? 1 : 0,
                      transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <td className="feature-name">{feature.label}</td>
                    <td className="feature-vip">{vipFree ? ' Free' : vipValue || ''}</td>
                    <td className="feature-cost" data-pricing-revision={pricingRevision}>
                      {feature.key === 'theme_unlock'
                        ? 'Table Studio'
                        : !pricing
                          ? '-'
                          : !sellable
                            ? 'Not For Sale'
                            : `${pricing.cost.toLocaleString()}/${pricing.usageType.replace('per_', '').replace('_', ' ')}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* CTA */}
        {!isVIP && (
          <div className="vip-modal__cta">
            <a
              href="https://smarter.poker/subscribe"
              target="_blank"
              rel="noopener noreferrer"
              className="vip-upgrade-btn"
            >
              Get VIP Gold With Club Arena Membership
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default VIPCardsModal;
