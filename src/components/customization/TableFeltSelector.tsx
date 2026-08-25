/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE FELT SELECTOR — pick the felt the table actually renders
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS USED TO BE (until 2026-08-25). Eight circular colour swatches with
 * ids of their own invention: classic_green, navy, burgundy, charcoal, purple,
 * crimson, midnight, emerald. Only TWO of the eight painted what their label
 * said. Five - navy, burgundy, charcoal, purple and midnight (a BACKGROUND id,
 * not a felt) - match no skin at all, so resolveSkin sent every one of them to
 * classic green: picking Royal Purple, Charcoal or Burgundy produced the
 * identical green table. The eighth, `emerald`, is a legacy alias for the
 * GOLDEN SAND skin, so that swatch was simply mislabelled.
 *
 * It also never persisted anything, never emitted anything, and never
 * confirmed anything: `onChange` was the only output, and no caller passed one.
 * The premium badge and the tick were empty <span>s (their emoji had been
 * stripped, correctly, and never replaced), so neither was visible either.
 *
 * WHAT IT IS NOW. The tiles come from TABLE_FELT_CATALOG — the same list the
 * Theme Settings Table tab reads — so a felt cannot be offered unless a skin
 * file exists behind it, and the two pickers cannot drift apart. Each tile
 * shows the REAL skin composite rather than a colour smear. Selecting one:
 *
 *   1. broadcasts UI_THEME_CHANGED immediately, so any mounted table repaints
 *      on the tap without a reload;
 *   2. writes table_id to user_theme_settings;
 *   3. confirms with a success toast, or puts the selection back and says so
 *      if the write failed.
 *
 * VIP felts are gated by the same isFeltUnlocked rule Theme Settings uses.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import {
  TABLE_FELT_CATALOG,
  isFeltUnlocked,
  normalizeFeltId,
  resolveSkin,
  type TableFeltDesign,
} from '../../lib/tableTheme';
import './TableFeltSelector.css';

interface TableFeltSelectorProps {
  /** Stored table_id. Legacy aliases are accepted and resolved. */
  currentFelt: string;
  /** Needed to persist. Without it the pick still applies live for the session. */
  userId?: string | null;
  /** Which game type the choice is saved against. 'ALL' applies everywhere. */
  gameType?: string;
  isVip?: boolean;
  onChange?: (feltId: string) => void;
}

export const TableFeltSelector: React.FC<TableFeltSelectorProps> = ({
  currentFelt,
  userId,
  gameType = 'ALL',
  isVip = false,
  onChange,
}) => {
  const toast = useToast();
  const equippedId = normalizeFeltId(currentFelt);
  const [selected, setSelected] = useState(equippedId);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // The felt can also change from Theme Settings while this is on screen.
  useEffect(() => {
    setSelected(equippedId);
  }, [equippedId]);

  const handleSelect = useCallback(
    async (felt: TableFeltDesign) => {
      if (savingRef.current) return;
      if (!isFeltUnlocked(felt.id, { isVip })) {
        toast.info('That Felt Is A VIP Design. Upgrade To Unlock It.');
        return;
      }

      const previous = selected;
      if (previous === felt.id) return;

      setSelected(felt.id);
      onChange?.(felt.id);
      // Live first: the table under this panel repaints on the tap.
      masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: { table_id: felt.id } });

      if (!userId) {
        toast.success(`${felt.name} Felt Applied`);
        return;
      }

      savingRef.current = true;
      setSaving(true);
      try {
        const { error } = await supabase
          .from('user_theme_settings')
          .upsert(
            { user_id: userId, game_type: gameType, table_id: felt.id },
            { onConflict: 'user_id,game_type' }
          );
        if (error) {
          // Never leave a tick on a choice that was not stored.
          setSelected(previous);
          onChange?.(previous);
          masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: { table_id: previous } });
          reportError(error, 'TableFeltSelector.Save_failed');
          toast.error('Could Not Save That Felt. Please Try Again.');
        } else {
          toast.success(`${felt.name} Felt Applied`);
        }
      } catch (err) {
        setSelected(previous);
        onChange?.(previous);
        masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: { table_id: previous } });
        reportError(err, 'TableFeltSelector.Unexpected_save_error');
        toast.error('Could Not Save That Felt. Please Try Again.');
      }
      savingRef.current = false;
      setSaving(false);
    },
    [gameType, isVip, onChange, selected, toast, userId]
  );

  const selectedFelt = TABLE_FELT_CATALOG.find((f) => f.id === selected);

  return (
    <div className="table-felt-selector">
      <h3>Table Felt</h3>

      <div
        className="felt-preview"
        style={{ backgroundImage: `url(${resolveSkin(selected)})` }}
        role="img"
        aria-label={selectedFelt ? `${selectedFelt.name} table felt` : 'Table felt'}
      />

      <div className="felt-options">
        {TABLE_FELT_CATALOG.map((felt) => {
          const locked = !isFeltUnlocked(felt.id, { isVip });
          const isSelected = selected === felt.id;
          return (
            <button
              key={felt.id}
              type="button"
              className={[
                'felt-option',
                isSelected ? 'selected' : '',
                locked ? 'felt-option--locked' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ backgroundImage: `url(${resolveSkin(felt.id)})` }}
              onClick={() => void handleSelect(felt)}
              disabled={saving}
              data-felt={felt.id}
              title={felt.name}
              aria-pressed={isSelected}
            >
              {/* Text, not emoji: the previous badges were empty spans. */}
              {locked && <span className="premium-badge">VIP</span>}
              {isSelected && !locked && <span className="check">Selected</span>}
              <span className="felt-option__name">{felt.name}</span>
            </button>
          );
        })}
      </div>

      <p className="selected-name">{selectedFelt?.name ?? 'Classic Green'}</p>
    </div>
  );
};

export default TableFeltSelector;
