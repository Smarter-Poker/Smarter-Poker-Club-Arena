/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 😀 EMOJI PICKER — VIP-Gated Table Emojis
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState } from 'react';
import { vipService, FEATURE_PRICING } from '../../services/VIPService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { reportError } from '../../utils/errorReporter';
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
  const [accessUserId, setAccessUserId] = useState<string | undefined>(user?.id);
  const [purchasing, setPurchasing] = useState(false);
  const [purchasingUserId, setPurchasingUserId] = useState<string | null>(null);
  const [purchasingRequestId, setPurchasingRequestId] = useState<number | null>(null);
  const busyRef = React.useRef(false);
  const accessRequestRef = React.useRef(0);
  const purchaseRequestRef = React.useRef(0);
  const activeUserIdRef = React.useRef(user?.id);
  const openStateRef = React.useRef(isOpen);
  const mountedRef = React.useRef(true);

  // In-flight entitlement and purchase continuations belong to the account
  // that started them. Invalidate them synchronously during render so the
  // replacement account never inherits access, callbacks, toasts, or a lock.
  if (activeUserIdRef.current !== user?.id) {
    activeUserIdRef.current = user?.id;
    accessRequestRef.current += 1;
    purchaseRequestRef.current += 1;
    busyRef.current = false;
  }
  if (openStateRef.current !== isOpen) {
    openStateRef.current = isOpen;
    purchaseRequestRef.current += 1;
    busyRef.current = false;
  }

  const hasVIPAccess = accessUserId === user?.id && isVIP;
  const purchasingForActiveUser =
    purchasing &&
    purchasingUserId === user?.id &&
    purchasingRequestId === purchaseRequestRef.current;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      purchaseRequestRef.current += 1;
      busyRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    // 2026-08-28: no `mounted` guard here meant both setStates could land
    // after the picker closed and unmounted.
    let mounted = true;
    const check = async () => {
      const requestedUserId = user?.id;
      const requestId = ++accessRequestRef.current;
      if (!requestedUserId) {
        if (mounted) {
          setAccessUserId(undefined);
          setIsVIP(false);
        }
        return;
      }
      try {
        const access = await vipService.checkFeatureAccess(requestedUserId, 'emoji_pack');
        if (
          !mounted ||
          activeUserIdRef.current !== requestedUserId ||
          accessRequestRef.current !== requestId
        )
          return;
        setAccessUserId(requestedUserId);
        setIsVIP(access.hasAccess);
      } catch {
        /* Keep the last known access on a transient read failure. */
      }
    };
    if (isOpen) check();
    return () => {
      mounted = false;
    };
  }, [isOpen, user?.id]);

  React.useEffect(() => {
    if (!isOpen || !user?.id) return undefined;
    const requestedUserId = user.id;
    return masterBus.subscribe('ENTITLEMENTS_CHANGED', (event) => {
      if (event.payload.userId !== requestedUserId || event.payload.category !== 'emote_pack')
        return;
      const requestId = ++accessRequestRef.current;
      void vipService.checkFeatureAccess(requestedUserId, 'emoji_pack').then(
        (access) => {
          if (activeUserIdRef.current !== requestedUserId || accessRequestRef.current !== requestId)
            return;
          setAccessUserId(requestedUserId);
          setIsVIP(access.hasAccess);
        },
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
  const handleSelect = async (emoji: string, isPremium: boolean) => {
    if (!user?.id) return;
    // Lock every picker action, not just premium buttons, while a paid request
    // is unresolved. This ref closes the same-render gap before React applies
    // the disabled state and prevents a free emoji from racing the purchase.
    if (busyRef.current) return;
    const requestedUserId = user.id;

    if (isPremium && !hasVIPAccess) {
      busyRef.current = true;
      const requestId = ++purchaseRequestRef.current;
      accessRequestRef.current += 1;
      const isCurrentRequest = () =>
        mountedRef.current &&
        openStateRef.current &&
        activeUserIdRef.current === requestedUserId &&
        purchaseRequestRef.current === requestId;
      setPurchasingUserId(requestedUserId);
      setPurchasingRequestId(requestId);
      setPurchasing(true);
      try {
        const result = await vipService.purchaseFeature(requestedUserId, 'emoji_pack');
        if (!isCurrentRequest()) return;
        if (!result.success && !result.alreadyOwned) {
          toast.error(
            result.error === 'Insufficient Diamonds'
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
        setAccessUserId(requestedUserId);
        setIsVIP(true);
        masterBus.emit('ENTITLEMENTS_CHANGED', {
          userId: requestedUserId,
          category: 'emote_pack',
          quantity: 1,
          source: 'diamond-purchase',
        });
      } catch (error) {
        if (!isCurrentRequest()) return;
        reportError(error, 'EmojiPicker.PurchaseFeature');
        toast.error('Could Not Buy The Emoji Pack. Please Try Again.');
        return;
      } finally {
        if (isCurrentRequest()) {
          busyRef.current = false;
          setPurchasing(false);
          setPurchasingRequestId(null);
        }
      }
    }

    onSelect(emoji);
    onClose();
  };

  if (!isOpen) return null;

  const style = position ? { left: position.x, top: position.y } : {};

  return (
    <div
      className="emoji-picker-overlay"
      onClick={() => {
        if (!busyRef.current) onClose();
      }}
    >
      <div className="emoji-picker" style={style} onClick={(e) => e.stopPropagation()}>
        <div className="emoji-picker__section">
          <span className="emoji-picker__label">Free</span>
          <div className="emoji-picker__grid">
            {FREE_EMOJIS.map((emoji, index) => (
              <button
                key={`free-${index}-${emoji}`}
                onClick={() => handleSelect(emoji, false)}
                disabled={purchasingForActiveUser}
                aria-busy={purchasingForActiveUser}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        <div className="emoji-picker__section">
          <span className="emoji-picker__label">
            {hasVIPAccess ? ' VIP' : `Premium (${FEATURE_PRICING.emoji_pack.cost})`}
          </span>
          <div className="emoji-picker__grid vip">
            {VIP_EMOJIS.map((emoji, index) => (
              <button
                key={`vip-${index}-${emoji}`}
                onClick={() => handleSelect(emoji, true)}
                disabled={purchasingForActiveUser}
                aria-busy={purchasingForActiveUser}
                className={!hasVIPAccess ? 'premium' : ''}
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
