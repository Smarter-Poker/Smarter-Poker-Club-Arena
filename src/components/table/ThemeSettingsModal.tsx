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
import { TABLE_SKINS, TABLE_BACKGROUNDS } from '../../assets/tableAssets';
import { CardBack, normalizeCardBack } from './CardImage';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
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

// Game-type categories for per-game-type theming. Must match the platform's
// approved variants — FIX 116 removed FLH / FLO / MIXED (dead variants), so
// they no longer appear here (a user could otherwise save a theme against a
// game type that can never be played). Pineapple is an approved variant.
const GAME_TYPES = ['ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'] as const;

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
  // Dan 2026-08-17: these ids now match TablePage's TABLE_SKINS registry
  // exactly (the old five never did — every pick fell back to green).
  // Thumbnails approximate each composite's palette.
  table: [
    {
      id: 'neon_city',
      name: 'Neon City',
      thumbnail: 'linear-gradient(135deg, #2b2b33 40%, #d446b8 75%, #2ad4d4)',
      vipOnly: false,
    },
    {
      id: 'classic_green',
      name: 'Classic Green',
      thumbnail: 'linear-gradient(135deg, #0f9d63, #0a3d24)',
      vipOnly: false,
    },
    {
      id: 'carbon_red',
      name: 'Carbon Red',
      thumbnail: 'linear-gradient(135deg, #232326 55%, #b3221f)',
      vipOnly: false,
    },
    {
      id: 'ice_cavern',
      name: 'Ice Cavern',
      thumbnail: 'linear-gradient(135deg, #0c1524 40%, #3f6fae 75%, #bcd6ee)',
      vipOnly: false,
    },
    {
      id: 'arctic_white',
      name: 'Arctic White',
      thumbnail: 'linear-gradient(135deg, #f2f2f0 35%, #3f8fd4)',
      vipOnly: false,
    },
    {
      id: 'mahogany_red',
      name: 'Royal Mahogany',
      thumbnail: 'linear-gradient(135deg, #3a1410 30%, #b3273a 70%, #d8a437)',
      vipOnly: false,
    },
    {
      id: 'ocean_blue',
      name: 'Ocean Blue',
      thumbnail: 'linear-gradient(135deg, #1a4a7a, #0a243d)',
      vipOnly: false,
    },
    {
      id: 'crimson',
      name: 'Crimson',
      thumbnail: 'linear-gradient(135deg, #7a1a3a, #3d0a20)',
      vipOnly: false,
    },
    {
      id: 'electric_purple',
      name: 'Electric Purple',
      thumbnail: 'linear-gradient(135deg, #4a1a7a, #240a3d)',
      vipOnly: false,
    },
    {
      id: 'golden_sand',
      name: 'Golden Sand',
      thumbnail: 'linear-gradient(135deg, #7a6a1a, #3d380a)',
      vipOnly: false,
    },
    {
      id: 'jade_city',
      name: 'Jade City',
      thumbnail: 'linear-gradient(135deg, #14261c 40%, #2fae6f 75%, #9fe8c0)',
      vipOnly: true,
    },
    {
      id: 'amethyst_cavern',
      name: 'Amethyst Cavern',
      thumbnail: 'linear-gradient(135deg, #180c24 40%, #7d3fae 75%, #d9bcee)',
      vipOnly: true,
    },
    {
      id: 'carbon_ion',
      name: 'Carbon Ion',
      thumbnail: 'linear-gradient(135deg, #232326 55%, #1fb392)',
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
  // Dan 2026-08-18: ten standalone designed backgrounds (see
  // src/assets/backgrounds/, applied via TABLE_BACKGROUNDS in TablePage).
  background: [
    {
      id: 'midnight',
      name: 'Midnight',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #2c323c, #0a0c10)',
      vipOnly: false,
    },
    {
      id: 'royal_indigo',
      name: 'Royal Indigo',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #3a306e, #0c0a1a)',
      vipOnly: false,
    },
    {
      id: 'emerald_room',
      name: 'Emerald Room',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #164e36, #06120d)',
      vipOnly: false,
    },
    {
      id: 'crimson_lounge',
      name: 'Crimson Lounge',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #601a22, #14070a)',
      vipOnly: false,
    },
    {
      id: 'ocean_abyss',
      name: 'Ocean Abyss',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #143e68, #050c18)',
      vipOnly: false,
    },
    {
      id: 'golden_dusk',
      name: 'Golden Dusk',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #786022, #181008)',
      vipOnly: false,
    },
    {
      id: 'galaxy',
      name: 'Galaxy',
      thumbnail: 'radial-gradient(ellipse at 30% 25%, #2e1650, #04040c)',
      vipOnly: false,
    },
    {
      id: 'carbon_grid',
      name: 'Carbon Grid',
      thumbnail: 'radial-gradient(ellipse at 50% 40%, #1e2126, #08090b)',
      vipOnly: true,
    },
    {
      id: 'ice_frost',
      name: 'Ice Frost',
      thumbnail: 'radial-gradient(ellipse at 50% 35%, #46607a, #0a121e)',
      vipOnly: true,
    },
    {
      id: 'jade_neon',
      name: 'Jade Neon',
      thumbnail: 'radial-gradient(ellipse at 50% 90%, #12784f, #050a09)',
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
  table_id: 'neon_city',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'standard-red',
};

/**
 * Dan 2026-08-17 (STEP 8) — Tab 1 preset bundles. Picking a Theme fills the
 * other four categories with a coordinated set (each tab can still be
 * overridden before Confirm). Free presets bundle only free assets; the two
 * VIP presets may bundle VIP assets because the preset tile itself is
 * VIP-gated by canAccessAsset before the bundle is applied.
 */
const THEME_PRESET_BUNDLES: Record<string, Partial<ThemeSelection>> = {
  'default-dark': {
    table_id: 'neon_city',
    button_id: 'classic-white',
    background_id: 'midnight',
    cards_id: 'standard-red',
  },
  'classic-brown': {
    table_id: 'mahogany_red',
    button_id: 'gray-d-gear',
    background_id: 'midnight',
    cards_id: 'standard-red',
  },
  'neon-blue': {
    table_id: 'ice_cavern',
    button_id: 'blue-crystal',
    background_id: 'galaxy',
    cards_id: 'standard-blue',
  },
  'rustic-wood': {
    table_id: 'classic_green',
    button_id: 'gold-star',
    background_id: 'golden_dusk',
    cards_id: 'premium-gold',
  },
  'casino-green': {
    table_id: 'jade_city',
    button_id: 'gold-star',
    background_id: 'jade_neon',
    cards_id: 'premium-black',
  },
};

// Binary VIP access check: user is either VIP or not
function canAccessAsset(isVip: boolean, vipOnly: boolean): boolean {
  if (!vipOnly) return true; // Free items always accessible
  return isVip; // VIP-only items require VIP status
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render a REAL preview for one option.
 *
 * Dan 2026-08-18: "the themes and tables should show the actual theme and table
 * layouts not just a color. same for buttons, show the actual button in the
 * settings and same for cards."
 *
 * Per tab, what "real" means:
 *   table       the actual 896x1200 skin composite, object-fit cover
 *   background  the actual room .jpg
 *   button      a live dealer button carrying data-button-theme, so it picks
 *               up the very --dealer-btn-bg / --dealer-btn-color the table
 *               will use (TablePage.css)
 *   cards       a real <CardBack>, the same component the felt renders
 *   themes      a composite mini-table: the preset's own table skin with its
 *               background behind it, which is the only honest way to show
 *               what a preset actually does (it is a bundle of the others)
 *
 * Anything without a real asset falls back to the original gradient rather
 * than rendering an empty box.
 */
function renderAssetPreview(tab: ThemeTab, asset: ThemeAsset) {
  const fallback = <div className="theme-asset__swatch" style={{ background: asset.thumbnail }} />;

  if (tab === 'table') {
    const src = TABLE_SKINS[asset.id];
    return src ? (
      <img className="theme-asset__img" src={src} alt="" loading="lazy" decoding="async" />
    ) : (
      fallback
    );
  }

  if (tab === 'background') {
    const src = TABLE_BACKGROUNDS[asset.id];
    return src ? (
      <img className="theme-asset__img" src={src} alt="" loading="lazy" decoding="async" />
    ) : (
      fallback
    );
  }

  if (tab === 'button') {
    // The real dealer button, styled by the same attribute the table sets.
    return (
      <div className="theme-asset__btnstage" data-button-theme={asset.id}>
        <span className="theme-asset__dealerbtn">D</span>
      </div>
    );
  }

  if (tab === 'cards') {
    // The real CardBack component. normalizeCardBack maps the Cards-tab ids
    // onto actual designs, so a preview can never be a blank rectangle.
    return (
      <div className="theme-asset__cardstage">
        <CardBack style={normalizeCardBack(asset.id)} size="sm" />
        <CardBack style={normalizeCardBack(asset.id)} size="sm" />
      </div>
    );
  }

  // themes: a preset bundles a table + background, so show both.
  // THEME_PRESET_BUNDLES holds Partial<ThemeSelection>, so both ids are
  // optional - a preset may set only some of the five slots.
  const bundle = THEME_PRESET_BUNDLES[asset.id];
  const bgSrc = bundle?.background_id ? TABLE_BACKGROUNDS[bundle.background_id] : undefined;
  const tableSrc = bundle?.table_id ? TABLE_SKINS[bundle.table_id] : undefined;
  if (!bgSrc && !tableSrc) return fallback;
  return (
    <div className="theme-asset__scene">
      {bgSrc && <img className="theme-asset__scene-bg" src={bgSrc} alt="" loading="lazy" />}
      {tableSrc && (
        <img className="theme-asset__scene-table" src={tableSrc} alt="" loading="lazy" />
      )}
    </div>
  );
}

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
      // Dan 2026-08-17 (STEP 8): Tab 1 presets are coordinated BUNDLES, not a
      // fifth independent knob. Before this, theme_id saved but nothing read
      // it, so the Themes tab was inert. Picking a preset now pre-fills the
      // other four categories (the user can still override any tab before
      // Confirm; non-VIP presets only bundle non-VIP assets).
      if (tab === 'themes') {
        const bundle = THEME_PRESET_BUNDLES[assetId];
        setSelection((prev) => ({ ...prev, [field]: assetId, ...(bundle || {}) }));
        return;
      }
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
        /* Dan 2026-08-19: saving is not applying. The modal wrote the row and
           closed, but every open table had already read its theme once on
           mount, so the felt/background/cards/button silently stayed on the
           old skin until a full reload. Broadcast the new selection so every
           mounted table repaints in real time. */
        masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: selection });
        toast.success('Theme applied');
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
                <div className="theme-asset__preview">
                  {/* ── Dan 2026-08-18: show the actual thing, not a colour ──
                      Every tab used to render `background: asset.thumbnail`,
                      a hand-written gradient that (in its own words)
                      "approximates each composite's palette" - so you picked a
                      table by looking at a colour smear. Each tab now renders
                      the real asset; the gradient survives only as a fallback
                      where no real asset exists for that id. */}
                  {renderAssetPreview(activeTab, asset)}
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
