/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 😀 EMOJI PICKER — VIP-Gated Table Emojis
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState } from 'react';
import { vipService, VIP_GOLD_LIMITS, FEATURE_PRICING } from '../../services/VIPService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import './EmojiPicker.css';

interface EmojiPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  position?: { x: number; y: number };
}

const FREE_EMOJIS = ['', '', '😀', '😂', '😭', '', '', '💯', '🤔', '😱', '🙏', ''];

const VIP_EMOJIS = [
  // Poker specific
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  // Reactions
  '🤑',
  '',
  '🥳',
  '😤',
  '🤯',
  '',
  '👻',
  '',
  '🤡',
  '',
  // Actions
  '',
  '',
  '',
  '💥',
  '',
  '',
  '',
  '💫',
  '',
  '',
  // Taunts
  '🐟',
  '🐠',
  '🐋',
  '🦐',
  '🐔',
  '🐷',
  '🐒',
  '🦧',
  '🤖',
  '👽',
];

export function EmojiPicker({ isOpen, onClose, onSelect, position }: EmojiPickerProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [isVIP, setIsVIP] = useState(false);
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    // 2026-08-28: no `mounted` guard here meant both setStates could land
    // after the picker closed and unmounted.
    let mounted = true;
    const check = async () => {
      if (!user?.id) {
        if (mounted) setLoading(false);
        return;
      }
      try {
        const access = await vipService.checkFeatureAccess(user.id, 'emoji_pack');
        if (!mounted) return;
        setIsVIP(access.hasAccess);
      } catch {
        /* Keep the last known access on a transient read failure. */
      } finally {
        if (mounted) setLoading(false);
      }
    };
    if (isOpen) check();
    return () => {
      mounted = false;
    };
  }, [isOpen, user?.id]);

  React.useEffect(() => {
    if (!isOpen || !user?.id) return undefined;
    return masterBus.subscribe('ENTITLEMENTS_CHANGED', (event) => {
      if (event.payload.userId !== user.id || event.payload.category !== 'emote_pack') return;
      void vipService.checkFeatureAccess(user.id, 'emoji_pack').then(
        (access) => setIsVIP(access.hasAccess),
        () => {
          /* Keep the last known access on a transient read failure. */
        }
      );
    });
  }, [isOpen, user?.id]);

  /**
   * AUDIT 2026-08-28 — TWO DEFECTS, BOTH ON A PAID PATH.
   *
   * 1. THE PACK IS PERMANENT, SO EVERY TAP AFTER THE FIRST SAID "INSUFFICIENT
   *    DIAMONDS". `emoji_pack` is priced `permanent` (VIPService FEATURE_
   *    PRICING), and fn_purchase_feature answers an owned feature with
   *    `{ success: false, error: 'already_owned' }` — a REFUSAL, not a
   *    failure, which VIPService surfaces as `alreadyOwned`. This call site
   *    checked only `success`, so once a player bought the pack, every
   *    premium emoji told them they were broke and sent nothing. Ownership is
   *    now treated as permission, which is what it is.
   * 2. NO IN-FLIGHT LOCK. The buttons were never disabled and the declared
   *    `loading` state gated nothing, so two quick taps issued two
   *    fn_purchase_feature calls. `busyRef` is a REF, not state: two taps
   *    inside one commit both read stale state, but both see the ref.
   */
  const busyRef = React.useRef(false);
  const [purchasing, setPurchasing] = useState(false);

  const handleSelect = async (emoji: string, isPremium: boolean) => {
    if (!user?.id) return;

    if (isPremium && !isVIP) {
      if (busyRef.current) return;
      busyRef.current = true;
      setPurchasing(true);
      try {
        const result = await vipService.purchaseFeature(user.id, 'emoji_pack');
        if (!result.success && !result.alreadyOwned) {
          toast.error(
            result.error === 'Insufficient diamonds'
              ? 'Not Enough Diamonds For The Emoji Pack.'
              : 'Could Not Buy The Emoji Pack. Please Try Again.'
          );
          return;
        }
        // Only announce a charge when one actually happened — an owned pack
        // costs nothing and must not claim it did.
        if (result.charged > 0) {
          toast.info(`${result.charged} Diamonds Charged For The Emoji Pack.`);
        }
        setIsVIP(true);
        masterBus.emit('ENTITLEMENTS_CHANGED', {
          userId: user.id,
          category: 'emote_pack',
          quantity: 1,
          source: 'diamond-purchase',
        });
      } finally {
        busyRef.current = false;
        setPurchasing(false);
      }
    }

    onSelect(emoji);
    onClose();
  };

  if (!isOpen) return null;

  const style = position ? { left: position.x, top: position.y } : {};

  return (
    <div className="emoji-picker-overlay" onClick={onClose}>
      <div className="emoji-picker" style={style} onClick={(e) => e.stopPropagation()}>
        <div className="emoji-picker__section">
          <span className="emoji-picker__label">Free</span>
          <div className="emoji-picker__grid">
            {FREE_EMOJIS.map((emoji) => (
              <button key={emoji} onClick={() => handleSelect(emoji, false)}>
                {emoji}
              </button>
            ))}
          </div>
        </div>

        <div className="emoji-picker__section">
          <span className="emoji-picker__label">
            {isVIP ? ' VIP' : `Premium (${FEATURE_PRICING.emoji_pack.cost})`}
          </span>
          <div className="emoji-picker__grid vip">
            {VIP_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleSelect(emoji, true)}
                disabled={purchasing}
                aria-busy={purchasing}
                className={!isVIP ? 'premium' : ''}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default EmojiPicker;
