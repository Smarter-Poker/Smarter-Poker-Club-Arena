/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THEME SETTINGS MODAL — Bible V8 §11.2
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Theme customization modal with:
 *   - Game type selector dropdown (ALL, NLH, FLH, 6+, PLO, etc.)
 *   - 5-tab layout (Themes, Table, Button, Background, Cards)
 *   - Binary VIP gating (Free items vs VIP-only items)
 *   - Per-game-type persistence via user_theme_settings table
 *
 * Bible V8 §11.2.4: Stored in user_theme_settings table
 *   Schema: user_id, game_type, theme_id, table_id, button_id, background_id, cards_id
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import './ThemeSettingsModal.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ThemeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  /** Whether the user is a VIP member (binary: free or VIP) */
  isVip: boolean;
}

interface ThemeSelection {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

type ThemeTab = 'themes' | 'table' | 'button' | 'background' | 'cards';

interface ThemeAsset {
  id: string;
  name: string;
  thumbnail: string; // CSS gradient or image URL for preview
  /** Whether the asset requires VIP access */
  vipOnly: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — Bible V8 §11.2.1 Game Types
// ═══════════════════════════════════════════════════════════════════════════════

const GAME_TYPES = ['ALL', 'NLH', 'FLH', '6+', 'PLO', 'FLO', 'MIXED', 'MTT', 'SNG'] as const;

const TABS: { key: ThemeTab; label: string }[] = [
  { key: 'themes', label: 'Themes' },
  { key: 'table', label: 'Table' },
  { key: 'button', label: 'Button' },
  { key: 'background', label: 'Background' },
  { key: 'cards', label: 'Cards' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// THEME ASSETS — Bible V8 §11.2.2
// ═══════════════════════════════════════════════════════════════════════════════

const THEME_ASSETS: Record<ThemeTab, ThemeAsset[]> = {
  themes: [
    {
      id: 'default-dark',
      name: 'Default Dark',
      thumbnail: 'linear-gradient(135deg, #1a1a2e, #16213e)',
      vipOnly: false,
    },
    {
      id: 'classic-brown',
      name: 'Classic Brown',
      thumbnail: 'linear-gradient(135deg, #3e2723, #5d4037)',
      vipOnly: false,
    },
    {
      id: 'neon-blue',
      name: 'Neon Blue',
      thumbnail: 'linear-gradient(135deg, #0d47a1, #1565c0)',
      vipOnly: true,
    },
    {
      id: 'rustic-wood',
      name: 'Rustic Wood',
      thumbnail: 'linear-gradient(135deg, #4e342e, #795548)',
      vipOnly: true,
    },
    {
      id: 'casino-green',
      name: 'Casino Green',
      thumbnail: 'linear-gradient(135deg, #1b5e20, #2e7d32)',
      vipOnly: true,
    },
  ],
  table: [
    {
      id: 'dark-felt',
      name: 'Dark Felt',
      thumbnail: 'linear-gradient(135deg, #1a1a2e, #0f0f1a)',
      vipOnly: false,
    },
    {
      id: 'brown-felt',
      name: 'Brown Felt',
      thumbnail: 'linear-gradient(135deg, #3e2723, #4e342e)',
      vipOnly: false,
    },
    {
      id: 'neon-blue-felt',
      name: 'Neon Blue',
      thumbnail: 'linear-gradient(135deg, #0d47a1, #1a237e)',
      vipOnly: true,
    },
    {
      id: 'red-leather',
      name: 'Red Leather',
      thumbnail: 'linear-gradient(135deg, #b71c1c, #c62828)',
      vipOnly: true,
    },
    {
      id: 'green-casino',
      name: 'Green Casino',
      thumbnail: 'linear-gradient(135deg, #1b5e20, #388e3c)',
      vipOnly: true,
    },
  ],
  button: [
    {
      // FIX-D7 2026-07-19: the app default is 'classic-white' but it wasn't a
      // selectable tile, so a fresh user / Reset showed no button highlighted.
      // Add it (matches the [data-button-theme='classic-white'] CSS token).
      id: 'classic-white',
      name: 'Classic White',
      thumbnail: 'linear-gradient(145deg, #ffffff 0%, #e8e8e8 50%, #d0d0d0 100%)',
      vipOnly: false,
    },
    {
      id: 'red-d-gear',
      name: 'Red D',
      thumbnail: 'linear-gradient(135deg, #c62828, #e53935)',
      vipOnly: false,
    },
    {
      id: 'gray-d-gear',
      name: 'Gray D',
      thumbnail: 'linear-gradient(135deg, #616161, #757575)',
      vipOnly: false,
    },
    {
      id: 'blue-crystal',
      name: 'Blue Crystal',
      thumbnail: 'linear-gradient(135deg, #1565c0, #42a5f5)',
      vipOnly: true,
    },
    {
      id: 'gold-star',
      name: 'Gold Star',
      thumbnail: 'linear-gradient(135deg, #f57f17, #fbc02d)',
      vipOnly: true,
    },
    {
      id: 'sports-themed',
      name: 'Sports',
      thumbnail: 'linear-gradient(135deg, #33691e, #558b2f)',
      vipOnly: true,
    },
  ],
  background: [
    {
      id: 'diamond-pattern',
      name: 'Diamond',
      thumbnail: 'linear-gradient(135deg, #263238, #37474f)',
      vipOnly: false,
    },
    {
      id: 'stone-concrete',
      name: 'Stone',
      thumbnail: 'linear-gradient(135deg, #424242, #616161)',
      vipOnly: false,
    },
    {
      id: 'galaxy-nebula',
      name: 'Galaxy',
      thumbnail: 'linear-gradient(135deg, #1a237e, #311b92)',
      vipOnly: true,
    },
    {
      id: 'hardwood-floor',
      name: 'Hardwood',
      thumbnail: 'linear-gradient(135deg, #5d4037, #795548)',
      vipOnly: true,
    },
    {
      id: 'teal-tile',
      name: 'Teal Tile',
      thumbnail: 'linear-gradient(135deg, #00695c, #00897b)',
      vipOnly: true,
    },
  ],
  cards: [
    {
      id: 'standard-red',
      name: 'Standard Red',
      thumbnail: 'linear-gradient(135deg, #c62828, #e53935)',
      vipOnly: false,
    },
    {
      id: 'standard-blue',
      name: 'Standard Blue',
      thumbnail: 'linear-gradient(135deg, #1565c0, #1976d2)',
      vipOnly: false,
    },
    {
      id: 'premium-gold',
      name: 'Premium Gold',
      thumbnail: 'linear-gradient(135deg, #f57f17, #ff8f00)',
      vipOnly: true,
    },
    {
      id: 'premium-black',
      name: 'Premium Black',
      thumbnail: 'linear-gradient(135deg, #212121, #424242)',
      vipOnly: true,
    },
    {
      id: 'premium-platinum',
      name: 'Platinum',
      thumbnail: 'linear-gradient(135deg, #78909c, #90a4ae)',
      vipOnly: true,
    },
  ],
};

const TAB_TO_FIELD: Record<ThemeTab, keyof ThemeSelection> = {
  themes: 'theme_id',
  table: 'table_id',
  button: 'button_id',
  background: 'background_id',
  cards: 'cards_id',
};

const DEFAULT_SELECTION: ThemeSelection = {
  theme_id: 'default-dark',
  table_id: 'dark-felt',
  button_id: 'classic-white',
  background_id: 'diamond-pattern',
  cards_id: 'standard-red',
};

// Binary VIP access check: user is either VIP or not
function canAccessAsset(isVip: boolean, vipOnly: boolean): boolean {
  if (!vipOnly) return true; // Free items always accessible
  return isVip; // VIP-only items require VIP status
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ThemeSettingsModal({ isOpen, onClose, userId, isVip }: ThemeSettingsModalProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const [showVipPrompt, setShowVipPrompt] = useState(false);
  const [activeTab, setActiveTab] = useState<ThemeTab>('themes');
  const [gameType, setGameType] = useState<string>('ALL');
  const [selection, setSelection] = useState<ThemeSelection>({ ...DEFAULT_SELECTION });
  const [saving, setSaving] = useState(false);

  // Load existing theme for selected game type
  useEffect(() => {
    if (!isOpen || !userId) return;

    let mounted = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('user_theme_settings')
          .select('theme_id, table_id, button_id, background_id, cards_id')
          .eq('user_id', userId)
          .eq('game_type', gameType)
          .maybeSingle();

        if (error) {
          console.warn('[ThemeSettings] Load failed:', error.message);
          return;
        }

        if (data && mounted) {
          setSelection({
            theme_id: data.theme_id || DEFAULT_SELECTION.theme_id,
            table_id: data.table_id || DEFAULT_SELECTION.table_id,
            button_id: data.button_id || DEFAULT_SELECTION.button_id,
            background_id: data.background_id || DEFAULT_SELECTION.background_id,
            cards_id: data.cards_id || DEFAULT_SELECTION.cards_id,
          });
        } else if (mounted) {
          // No saved theme for this game type — try ALL fallback
          if (gameType !== 'ALL') {
            const { data: fallback } = await supabase
              .from('user_theme_settings')
              .select('theme_id, table_id, button_id, background_id, cards_id')
              .eq('user_id', userId)
              .eq('game_type', 'ALL')
              .maybeSingle();

            if (fallback && mounted) {
              setSelection({
                theme_id: fallback.theme_id || DEFAULT_SELECTION.theme_id,
                table_id: fallback.table_id || DEFAULT_SELECTION.table_id,
                button_id: fallback.button_id || DEFAULT_SELECTION.button_id,
                background_id: fallback.background_id || DEFAULT_SELECTION.background_id,
                cards_id: fallback.cards_id || DEFAULT_SELECTION.cards_id,
              });
            } else if (mounted) {
              setSelection({ ...DEFAULT_SELECTION });
            }
          } else if (mounted) {
            setSelection({ ...DEFAULT_SELECTION });
          }
        }
      } catch (err) {
        console.warn('[ThemeSettings] Unexpected error:', err);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [isOpen, userId, gameType]);

  const handleAssetSelect = useCallback(
    (tab: ThemeTab, assetId: string, vipOnly: boolean) => {
      if (!canAccessAsset(isVip, vipOnly)) {
        // FIX 221: Bible V8 §11.2.3 — show VIP upgrade prompt (not just a toast)
        setShowVipPrompt(true);
        return;
      }
      const field = TAB_TO_FIELD[tab];
      setSelection((prev) => ({ ...prev, [field]: assetId }));
    },
    [isVip]
  );

  const handleSave = useCallback(async () => {
    if (!userId) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('user_theme_settings').upsert(
        {
          user_id: userId,
          game_type: gameType,
          ...selection,
        },
        { onConflict: 'user_id,game_type' }
      );

      if (error) {
        toast.error('Failed to save theme settings.');
        reportError(error, 'ThemeSettingsModal.Save_failed');
      } else {
        toast.success('Theme saved!');
        onClose();
      }
    } catch (err) {
      toast.error('Failed to save theme settings.');
      reportError(err, 'ThemeSettingsModal.Unexpected_save_error');
    }
    setSaving(false);
  }, [userId, gameType, selection, toast, onClose]);

  const handleReset = useCallback(() => {
    setSelection({ ...DEFAULT_SELECTION });
  }, []);

  if (!isOpen) return null;

  const currentField = TAB_TO_FIELD[activeTab];
  const currentAssets = THEME_ASSETS[activeTab];
  const currentSelected = selection[currentField];

  return (
    <div className="theme-modal-overlay" onClick={onClose}>
      <div className="theme-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="theme-modal__header">
          <h3 className="theme-modal__title">Theme Settings</h3>
          <button className="theme-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Game Type Selector */}
        <div className="theme-modal__game-type">
          <label className="theme-modal__game-label">Game Type:</label>
          <select
            className="theme-modal__game-select"
            value={gameType}
            onChange={(e) => setGameType(e.target.value)}
          >
            {GAME_TYPES.map((gt) => (
              <option key={gt} value={gt}>
                {gt}
              </option>
            ))}
          </select>
        </div>

        {/* Tab Bar */}
        <div className="theme-modal__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`theme-modal__tab ${activeTab === tab.key ? 'theme-modal__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Asset Grid */}
        <div className="theme-modal__grid">
          {currentAssets.map((asset) => {
            const isSelected = currentSelected === asset.id;
            const isLocked = !canAccessAsset(isVip, asset.vipOnly);

            return (
              <div
                key={asset.id}
                className={`theme-asset ${isSelected ? 'theme-asset--selected' : ''} ${isLocked ? 'theme-asset--locked' : ''}`}
                onClick={() => handleAssetSelect(activeTab, asset.id, asset.vipOnly)}
              >
                <div className="theme-asset__preview" style={{ background: asset.thumbnail }}>
                  {isLocked && (
                    <div className="theme-asset__lock">
                      <span className="theme-asset__lock-icon">VIP</span>
                    </div>
                  )}
                  {isSelected && !isLocked && <div className="theme-asset__check">✓</div>}
                </div>
                <span className="theme-asset__name">{asset.name}</span>
                {asset.vipOnly && !isLocked && <span className="theme-asset__tier-badge">VIP</span>}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="theme-modal__footer">
          <button className="theme-modal__btn theme-modal__btn--reset" onClick={handleReset}>
            Reset
          </button>
          <button
            className="theme-modal__btn theme-modal__btn--save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Confirm'}
          </button>
        </div>

        {/* FIX 221: VIP Upgrade Prompt — Bible V8 §11.2.3 */}
        {showVipPrompt && (
          <div className="theme-vip-prompt-overlay" onClick={() => setShowVipPrompt(false)}>
            <div className="theme-vip-prompt" onClick={(e) => e.stopPropagation()}>
              <div className="theme-vip-prompt__icon">VIP</div>
              <h4 className="theme-vip-prompt__title">VIP Theme Unlocked</h4>
              <p className="theme-vip-prompt__text">
                This theme is exclusive to VIP members. Upgrade to unlock premium themes, tables,
                and more.
              </p>
              <div className="theme-vip-prompt__actions">
                <button
                  className="theme-vip-prompt__btn theme-vip-prompt__btn--upgrade"
                  onClick={() => {
                    setShowVipPrompt(false);
                    onClose();
                    navigate('/vip');
                  }}
                >
                  Upgrade to VIP
                </button>
                <button
                  className="theme-vip-prompt__btn theme-vip-prompt__btn--cancel"
                  onClick={() => setShowVipPrompt(false)}
                >
                  Maybe Later
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ThemeSettingsModal;
