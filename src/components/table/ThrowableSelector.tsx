/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SELECTOR — Pick from the 49 Dynamic 3D Throwables (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The grid now renders the Supabase 3D renders (throwables/<id>.jpg) instead
 * of the retired hand-drawn SVGs. Pure-black image backgrounds vanish via
 * mix-blend-mode: screen (.throwable-img), so items float on the panel.
 *
 * Five tabs: React · Throw · Sports · Cheer · VIP
 * VIP: 500 free throws/month, then 1 Diamond each; Non-VIP: 1 Diamond per throw.
 */

import React, { useState, useEffect } from 'react';
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

interface ThrowableSelectorProps {
  userId: string;
  onSelect: (throwable: Throwable) => void;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<ThrowableCategory, { icon: React.ReactNode; label: string }> = {
  reactions: {
    icon: <span className="category-icon category-icon--reactions">☺</span>,
    label: 'React',
  },
  throws: { icon: <span className="category-icon category-icon--throws">◆</span>, label: 'Throw' },
  sports: { icon: <span className="category-icon category-icon--sports">●</span>, label: 'Sports' },
  cheers: { icon: <span className="category-icon category-icon--cheers">★</span>, label: 'Cheer' },
  premium: { icon: <span className="category-icon category-icon--premium">♛</span>, label: 'VIP' },
};

export function ThrowableSelector({ userId, onSelect, onClose }: ThrowableSelectorProps) {
  const [throwables, setThrowables] = useState<Record<ThrowableCategory, Throwable[]>>({
    reactions: [],
    throws: [],
    sports: [],
    cheers: [],
    premium: [],
  });
  const [activeCategory, setActiveCategory] = useState<ThrowableCategory>('reactions');
  const [allowance, setAllowance] = useState<ThrowAllowance | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    // Warm the 49-image cache the moment the panel opens
    preloadThrowableImages();

    async function load() {
      const data = throwableService.getThrowablesByCategory();
      const allowanceData = await throwableService.getThrowAllowance(userId);
      setThrowables(data);
      setAllowance(allowanceData);
      setLoading(false);
    }
    load();
  }, [userId]);

  const handleSelect = async (throwable: Throwable) => {
    // Use the throwable (deducts from allowance or charges diamonds)
    const result = await throwableService.useThrowable(userId, throwable.id);
    if (!result.success) {
      if (result.error?.includes('diamond') || result.error?.includes('insufficient')) {
        showDiamondTopUp(toast, navigate, {
          feature: 'Throwable',
          cost: allowance?.diamondCost || 1,
        });
      } else {
        toast.error(result.error || 'Could not send reaction');
      }
      return;
    }
    // Refresh allowance
    const newAllowance = await throwableService.getThrowAllowance(userId);
    setAllowance(newAllowance);
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
            {allowance.isVip && allowance.freeThrowsRemaining > 0 ? (
              <span className="throwable-selector__free">
                {' '}
                {allowance.freeThrowsRemaining} free
              </span>
            ) : (
              <span className="throwable-selector__cost"> {allowance.diamondCost} each</span>
            )}
          </span>
        )}
        <button className="throwable-selector__close" onClick={onClose}>
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
            title={throwable.name}
          >
            <div className="throwable-selector__icon throwable-selector__icon--img">
              <ThrowableImage throwableId={throwable.id} size={40} loading="lazy" />
            </div>
            <span className="throwable-selector__name">{throwable.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default ThrowableSelector;
