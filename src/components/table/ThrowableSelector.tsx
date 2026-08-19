/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SELECTOR — Pick Emote/Throw Item
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Custom SVG graphics — NO EMOJIS!
 * VIP: 500 free throws/month, then 1 Diamond each
 * Non-VIP: 1 Diamond per throw
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  throwableService,
  Throwable,
  ThrowableCategory,
  ThrowAllowance,
} from '../../services/ThrowableService';
import { THROWABLE_ICONS } from './ThrowableIcons';
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
  cheers: { icon: <span className="category-icon category-icon--cheers">★</span>, label: 'Cheer' },
  expressions: {
    icon: <span className="category-icon category-icon--expressions">♠</span>,
    label: 'Poker',
  },
  premium: { icon: <span className="category-icon category-icon--premium">♛</span>, label: 'VIP' },
};

export function ThrowableSelector({ userId, onSelect, onClose }: ThrowableSelectorProps) {
  const [throwables, setThrowables] = useState<Record<ThrowableCategory, Throwable[]>>({
    reactions: [],
    throws: [],
    cheers: [],
    expressions: [],
    premium: [],
  });
  const [activeCategory, setActiveCategory] = useState<ThrowableCategory>('reactions');
  const [allowance, setAllowance] = useState<ThrowAllowance | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
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

  // Get SVG icon component for a throwable
  const renderIcon = (throwableId: string) => {
    const IconComponent = THROWABLE_ICONS[throwableId];
    if (IconComponent) {
      return <IconComponent size={36} />;
    }
    return <span className="throwable-selector__fallback">?</span>;
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

      {/* Throwable Grid — Custom SVG Icons */}
      <div className="throwable-selector__grid">
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
            <div className="throwable-selector__icon">{renderIcon(throwable.id)}</div>
            <span className="throwable-selector__name">{throwable.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default ThrowableSelector;
