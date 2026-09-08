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
 * VIP: 500 free throws/month, then 1 Diamond each; Non-VIP: 1 Diamond per throw.
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
import { prepareThrowableArtwork } from '../../throwables/artwork';

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
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;
    preloadThrowableImages();
    setThrowables(throwableService.getThrowablesByCategory());
    setAllowance(null);
    setLoading(true);

    async function refreshAllowance() {
      const request = ++latestRequest;
      const next = await throwableService.getThrowAllowance(userId);
      // An old account or an earlier entitlement refresh must not overwrite
      // the currently displayed balance when responses arrive out of order.
      if (disposed || request !== latestRequest) return;
      setAllowance(next);
      setLoading(false);
    }
    void refreshAllowance();
    const unsubscribe = masterBus.subscribe('ENTITLEMENTS_CHANGED', (event) => {
      if (event.payload.userId !== userId || event.payload.category !== 'throwable') return;
      void refreshAllowance();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [userId]);

  /**
   * AUDIT 2026-08-28 — DOUBLE-TAP SPENT TWO DIAMONDS.
   *
   * The panel stayed open and tappable for the whole round trip (onClose is
   * two awaits away), the grid buttons were never disabled, and
   * the server receipt protects repeated requests while this ref blocks a
   * second UI intent before the first has completed. A ref, not state, because two taps inside
   * one commit both read stale state.
   */
  const sendingRef = useRef(false);
  const generationRef = useRef(0);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [userId]
  );
  const [sending, setSending] = useState(false);

  const handleSelect = async (throwable: Throwable) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await sendThrowable(throwable);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const sendThrowable = async (throwable: Throwable) => {
    const generation = generationRef.current;
    try {
      await prepareThrowableArtwork(throwable.id);
    } catch {
      if (generation === generationRef.current)
        toast.error('Reaction artwork could not load. Please try again.');
      return;
    }
    // Closing the picker or changing account cancels an uncharged intent.
    if (generation !== generationRef.current) return;
    // Use the throwable only after its artwork is ready.
    const result = await throwableService.useThrowable(userId, throwable.id);
    if (!result.success) {
      if (/diamond|insufficient/i.test(result.error || '')) {
        showDiamondTopUp(toast, navigate, {
          feature: 'Throwable',
          cost: allowance?.diamondCost || 1,
        });
      } else {
        toast.error(result.error || 'Could not send reaction');
      }
      return;
    }
    onSelect(throwable);
    onClose();
  };

  if (loading) {
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
            {allowance.unavailable ? (
              <span className="throwable-selector__cost">Allowance Unavailable</span>
            ) : allowance.unlimited ? (
              <span className="throwable-selector__free">Unlimited</span>
            ) : allowance.freeThrowsRemaining > 0 ? (
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
          aria-label="Close Throwables"
          onClick={onClose}
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
      <button
        className="throwable-selector__buy"
        onClick={() => {
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
    </div>
  );
}

export default ThrowableSelector;
