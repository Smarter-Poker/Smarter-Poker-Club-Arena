/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SELECTOR — Pick from the 48 Dynamic 3D Throwables (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The grid now renders the Supabase 3D renders (throwables/<id>.jpg) instead
 * of the retired hand-drawn SVGs. Pure-black image backgrounds vanish via
 * mix-blend-mode: screen (.throwable-img), so items float on the panel.
 *
 * COUNT: 48, not the 49 the comments claimed since the rebuild. Storage holds
 * 49 renders; `mouse_card.jpg` has no catalog entry and is therefore not
 * offered, which is the harmless direction of that mismatch. The dangerous
 * direction - a catalog id with no render - is pinned by
 * tests/unit/throwableCatalogIntegrity.test.ts, because a picker offering ids
 * that resolve to nothing is exactly the defect the card-back picker shipped
 * with: eight tiles, six of which painted a fallback and selected nothing.
 *
 * Five tabs: React · Throw · Sports · Cheer · VIP
 * VIP: 500 free throws/month, then 1 Diamond each. Lifetime VIP: unlimited.
 * Non-VIP: 1 Diamond per throw.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  throwableService,
  Throwable,
  ThrowableCategory,
  ThrowAllowance,
} from '../../services/ThrowableService';
import { ThrowableImage, preloadThrowableImages } from './ThrowableImage';
import { useToast } from '../common/Toast';
import { showDiamondTopUp } from '../common/DiamondTopUpToast';
import './ThrowableSelector.css';
import { haptic } from '../../services/SoundService';
import { masterBus } from '../../core/MasterBus';
import {
  clearSessionPurchaseRequestId,
  readOrCreateSessionPurchaseRequestId,
} from '../../utils/sessionPurchaseRequest';

interface ThrowableSelectorProps {
  userId: string;
  onSelect: (throwable: Throwable) => void;
  onClose: () => void;
}

/**
 * Tab order and copy. Dan 2026-08-21: VIP leads, and the labels were renamed
 * so all five fit one row without truncating — the old panel showed four and a
 * clipped fifth, so the VIP tab (the one that sells something) was the one you
 * could not see. Short nouns beat verbs here: "Emoji" reads as a category,
 * "React" read as a button.
 */
const CATEGORY_LABELS: Record<ThrowableCategory, { label: string }> = {
  premium: { label: 'VIP' },
  throws: { label: 'Food' },
  sports: { label: 'Sports' },
  cheers: { label: 'Party' },
  reactions: { label: 'Emoji' },
};

export function ThrowableSelector({ userId, onSelect, onClose }: ThrowableSelectorProps) {
  const [throwables, setThrowables] = useState<Record<ThrowableCategory, Throwable[]>>({
    reactions: [],
    throws: [],
    sports: [],
    cheers: [],
    premium: [],
  });
  const [activeCategory, setActiveCategory] = useState<ThrowableCategory>('premium');
  const [allowance, setAllowance] = useState<ThrowAllowance | null>(null);
  const [allowanceUserId, setAllowanceUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const navigate = useNavigate();
  const allowanceRequestRef = useRef(0);
  const activeUserRef = useRef(userId);
  const sendRequestRef = useRef(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);

  // Keep the identity check synchronous with render. Effects run after commit,
  // so an old request can otherwise resolve in the narrow window between an
  // account prop changing and its cleanup invalidating the previous request.
  activeUserRef.current = userId;

  useEffect(() => {
    const request = ++allowanceRequestRef.current;
    sendRequestRef.current += 1;
    sendingRef.current = false;
    setAllowance(null);
    setAllowanceUserId(null);
    setLoading(true);
    setSending(false);

    // Warm the render cache the moment the panel opens
    preloadThrowableImages();

    async function load() {
      const data = throwableService.getThrowablesByCategory();
      const allowanceData = await throwableService.getThrowAllowance(userId);
      if (request !== allowanceRequestRef.current || activeUserRef.current !== userId) return;
      setThrowables(data);
      setAllowance(allowanceData);
      setAllowanceUserId(userId);
      setLoading(false);
    }
    void load();
    return () => {
      if (allowanceRequestRef.current === request) allowanceRequestRef.current += 1;
      sendRequestRef.current += 1;
      sendingRef.current = false;
    };
  }, [userId]);

  useEffect(() => {
    return masterBus.subscribe('ENTITLEMENTS_CHANGED', (event) => {
      if (event.payload.userId !== userId || event.payload.category !== 'throwable') return;
      const request = ++allowanceRequestRef.current;
      void throwableService.getThrowAllowance(userId).then((nextAllowance) => {
        if (request === allowanceRequestRef.current && activeUserRef.current === userId) {
          setAllowance(nextAllowance);
          setAllowanceUserId(userId);
        }
      });
    });
  }, [userId]);

  /**
   * AUDIT 2026-08-28 — DOUBLE-TAP SPENT TWO DIAMONDS.
   *
   * The panel stayed open and tappable for the whole round trip (onClose is
   * two awaits away), the grid buttons were never disabled, and
   * fn_use_throwable_v2 carries the same browser UUID across a response-lost
   * retry. A ref still closes a normal double-tap inside one React commit; the
   * durable database receipt closes the network ambiguity after that.
   */
  const handleSelect = async (throwable: Throwable) => {
    if (sendingRef.current) return;
    const requestedUserId = userId;
    const sendRequest = ++sendRequestRef.current;
    const isCurrent = () =>
      sendRequest === sendRequestRef.current && activeUserRef.current === requestedUserId;
    const requestScope = `throwable:${requestedUserId}:${throwable.id}`;
    const throwableRequestId = readOrCreateSessionPurchaseRequestId(requestScope);
    sendingRef.current = true;
    setSending(true);
    try {
      await sendThrowable(throwable, requestedUserId, sendRequest, throwableRequestId);
    } finally {
      if (isCurrent()) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };

  const sendThrowable = async (
    throwable: Throwable,
    requestedUserId: string,
    sendRequest: number,
    throwableRequestId: string
  ) => {
    const isCurrent = () =>
      sendRequest === sendRequestRef.current && activeUserRef.current === requestedUserId;
    const requestScope = `throwable:${requestedUserId}:${throwable.id}`;
    // Use the throwable (deducts from allowance or charges diamonds)
    const result = await throwableService.useThrowable(
      requestedUserId,
      throwable.id,
      throwableRequestId
    );
    if (!isCurrent()) return;
    if (!result.success) {
      if (result.retrySameRequest !== true) {
        clearSessionPurchaseRequestId(requestScope);
      }
      const failure = String(result.error ?? '').toLowerCase();
      if (failure.includes('diamond') || failure.includes('insufficient')) {
        showDiamondTopUp(toast, navigate, {
          feature: 'Throwable',
          cost: allowance?.diamondCost || 1,
        });
      } else {
        toast.error(result.error || 'Could Not Send Reaction');
      }
      return;
    }
    // Refresh allowance
    const request = ++allowanceRequestRef.current;
    const newAllowance = await throwableService.getThrowAllowance(requestedUserId);
    if (request !== allowanceRequestRef.current || !isCurrent()) return;
    setAllowance(newAllowance);
    onSelect(throwable);
    clearSessionPurchaseRequestId(requestScope);
    onClose();
  };

  if (loading || allowanceUserId !== userId) {
    return (
      <div className="throwable-selector throwable-selector--loading">
        <div className="throwable-selector__spinner" />
      </div>
    );
  }

  return (
    <div className="throwable-selector" onClick={(e) => e.stopPropagation()}>
      <div className="throwable-selector__header">
        <h3 className="throwable-selector__title">Send Reaction</h3>
        {allowance && (
          <span className="throwable-selector__allowance">
            {allowance.unlimited ? (
              <span className="throwable-selector__free"> Lifetime VIP // Unlimited</span>
            ) : allowance.isVip && allowance.freeThrowsRemaining > 0 ? (
              <span className="throwable-selector__free">
                {' '}
                {allowance.freeThrowsRemaining} Free
              </span>
            ) : allowance.packThrowsRemaining > 0 ? (
              <span className="throwable-selector__free">
                {' '}
                {allowance.packThrowsRemaining} Pack
              </span>
            ) : (
              <span className="throwable-selector__cost"> {allowance.diamondCost} Each</span>
            )}
          </span>
        )}
        <button
          className="throwable-selector__close"
          onClick={() => {
            if (!sendingRef.current) onClose();
          }}
          disabled={sending}
          aria-label="Close Throwable Selector"
        >
          ×
        </button>
      </div>

      {/* Category Tabs */}
      <div className="throwable-selector__tabs">
        {(Object.keys(CATEGORY_LABELS) as ThrowableCategory[]).map((cat) => (
          <button
            key={cat}
            className={`throwable-selector__tab ${activeCategory === cat ? 'throwable-selector__tab--active' : ''}`}
            data-cat={cat}
            onClick={() => {
              haptic.light();
              setActiveCategory(cat);
            }}
            title={CATEGORY_LABELS[cat].label}
          >
            {CATEGORY_LABELS[cat].label}
          </button>
        ))}
      </div>

      {/* Throwable Grid — 3D renders on black, blended transparent */}
      <div className="throwable-selector__grid" data-cat={activeCategory}>
        {throwables[activeCategory].map((throwable) => (
          <button
            key={throwable.id}
            className="throwable-selector__item"
            onClick={() => {
              haptic.light();
              handleSelect(throwable);
            }}
            disabled={sending}
            aria-busy={sending}
            title={throwable.name}
          >
            <div className="throwable-selector__icon throwable-selector__icon--img">
              <ThrowableImage throwableId={throwable.id} size={84} loading="lazy" />
            </div>
            <span className="throwable-selector__name">{throwable.name}</span>
          </button>
        ))}
      </div>

      {/* Dan 2026-08-21: a way to buy more without leaving the table blind.
          Deep-links straight to the Diamonds tab rather than the store root,
          so the next tap is the purchase and not another menu. */}
      {!allowance?.unlimited && (
        <button
          className="throwable-selector__buy"
          disabled={sending}
          onClick={() => {
            if (sendingRef.current) return;
            haptic.light();
            onClose();
            navigate('/marketplace?tab=diamonds');
          }}
        >
          <span className="throwable-selector__buy-icon" aria-hidden>
            ◆
          </span>
          <span className="throwable-selector__buy-label">Get More Throwables</span>
          <span className="throwable-selector__buy-chevron" aria-hidden>
            ›
          </span>
        </button>
      )}
    </div>
  );
}

export default ThrowableSelector;
