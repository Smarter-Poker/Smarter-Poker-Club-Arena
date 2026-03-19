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
import { VIP_GOLD_LIMITS, FEATURE_PRICING } from '../../services/VIPService';
import { useVIPStatus } from '../../hooks/useVIP';
import './VIPCardsModal.css';

interface VIPInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const FEATURES = [
  { key: 'rabbit_hunt', label: 'Rabbit Hunting', vipFree: true },
  { key: 'show_stack_bb', label: 'Show Stack in BBs', vipFree: true },
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

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

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
            <p>Checking status...</p>
          ) : isVIP ? (
            <div className="vip-status-active">
              <span className="vip-crown"></span>
              <span>VIP Gold Active</span>
              <span className="vip-sub">Included with Club Arena Membership</span>
            </div>
          ) : (
            <div className="vip-status-inactive">
              <span> Pay Per Feature</span>
              <span className="vip-sub">Or upgrade to Club Arena for VIP Gold</span>
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
                    <td className="feature-cost">
                      {pricing
                        ? `${pricing.cost}/${pricing.usageType.replace('per_', '').replace('_', ' ')}`
                        : '-'}
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
              Get VIP Gold with Club Arena Membership
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default VIPCardsModal;
