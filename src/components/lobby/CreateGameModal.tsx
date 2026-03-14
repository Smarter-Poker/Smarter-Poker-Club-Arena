/**
 * CreateGameModal — Unified table/tournament creation wizard
 * Ported from Hub's CreateGameModal.jsx → CA TSX
 *
 * Differences from Hub:
 *  - Uses direct Supabase instead of apiCall
 *  - Uses masterBus for event emission
 *  - TypeScript with proper interfaces
 *
 * Flow:
 *   1) Game Type Selector (NLH, FLH, 6+, PLO, etc.)
 *   2) Regular | SNG | MTT tabs with full options
 */

import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';

const FB = {
  bg: '#18191A',
  cardBg: '#242526',
  elevated: '#3A3B3C',
  border: '#3E4042',
  primary: '#1877F2',
  success: '#31A24C',
  warning: '#F5A623',
  danger: '#FA383E',
  textPrimary: '#E4E6EB',
  textSecondary: '#B0B3B8',
  textDim: '#65676B',
};

const GAME_VARIANTS = [
  { value: 'nlh', label: 'NLH', full: "No Limit Hold'em", color: '#E74C3C', icon: '♠' },
  { value: 'flh', label: 'FLH', full: "Fixed Limit Hold'em", color: '#2ECC71', icon: '♥' },
  { value: 'short_deck', label: '6+', full: "6+ Hold'em", color: '#3498DB', icon: '🃏' },
  { value: 'plo4', label: 'OMAHA', full: 'Pot Limit Omaha', color: '#9B59B6', icon: '♦' },
  { value: 'plo5', label: 'PLO5', full: 'Pot Limit Omaha 5', color: '#8E44AD', icon: '♦' },
  { value: 'mixed', label: 'MIXED', full: "Hold'em/Omaha", color: '#F39C12', icon: '🔀' },
  { value: 'ofc', label: 'OFC', full: 'Open Face Chinese', color: '#E91E63', icon: '🀄' },
];

// Reusable form components
function SectionHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        color: FB.warning,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 1.2,
        padding: '10px 0 6px',
        borderBottom: `1px solid ${FB.border}`,
        marginBottom: 8,
      }}
    >
      {label}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 0',
        borderBottom: `1px solid ${FB.border}22`,
      }}
    >
      <span style={{ color: FB.textPrimary, fontSize: 13, fontWeight: 500 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          border: 'none',
          cursor: 'pointer',
          background: value ? FB.warning : FB.elevated,
          position: 'relative',
          transition: 'background 0.2s',
        }}
      >
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: '#fff',
            position: 'absolute',
            top: 2,
            left: value ? 22 : 2,
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        />
      </button>
    </div>
  );
}

function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = '',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div style={{ padding: '8px 0', borderBottom: `1px solid ${FB.border}22` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: FB.textPrimary, fontSize: 13, fontWeight: 500 }}>{label}</span>
        <span style={{ color: FB.warning, fontSize: 13, fontWeight: 700 }}>
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          width: '100%',
          height: 6,
          appearance: 'none',
          background: FB.elevated,
          borderRadius: 3,
          accentColor: FB.warning,
        }}
      />
    </div>
  );
}

// Game Type Selector Screen
function GameTypeSelector({
  onSelect,
  onClose,
}: {
  onSelect: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: FB.bg,
          borderRadius: 16,
          width: '100%',
          maxWidth: 420,
          maxHeight: '90vh',
          overflow: 'auto',
          border: `1px solid ${FB.border}`,
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          padding: '20px 16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ color: FB.textPrimary, fontSize: 18, fontWeight: 800, margin: 0 }}>
            Select Game Type
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: FB.textDim,
              fontSize: 22,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {GAME_VARIANTS.map((v) => (
            <button
              key={v.value}
              onClick={() => onSelect(v.value)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                borderRadius: 12,
                border: 'none',
                cursor: 'pointer',
                background: `linear-gradient(135deg, ${v.color}44, ${v.color}11)`,
                transition: 'transform 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 10,
                    background: `${v.color}33`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 22,
                    border: `1px solid ${v.color}55`,
                  }}
                >
                  {v.icon}
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ color: '#fff', fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>
                    {v.label}
                  </div>
                  <div style={{ color: FB.textSecondary, fontSize: 11, fontWeight: 500 }}>
                    {v.full.toUpperCase()}
                  </div>
                </div>
              </div>
              <div
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  background: `${v.color}55`,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                CREATE »
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Config Modal for cash/SNG/MTT
function ConfigModal({
  variant,
  onClose,
  onCreated,
  clubId,
}: {
  variant: string;
  onClose: () => void;
  onCreated?: (result: any) => void;
  clubId: string;
}) {
  const { user } = useAuthUser();
  const [tab, setTab] = useState('regular');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [tableSize, setTableSize] = useState(9);
  const [actionTime, setActionTime] = useState(15);
  const [smallBlind, setSmallBlind] = useState('1');
  const [bigBlind, setBigBlind] = useState('2');
  const [minBuyInBB, setMinBuyInBB] = useState(20);
  const [maxBuyInBB, setMaxBuyInBB] = useState(200);
  const [buyIn, setBuyIn] = useState(100);
  const [fee, setFee] = useState(10);
  const [startingChips, setStartingChips] = useState(1000);
  const [blindsUpMinutes, setBlindsUpMinutes] = useState(3);
  const [privateGame, setPrivateGame] = useState(false);
  const [bombPot, setBombPot] = useState(false);

  const variantInfo = GAME_VARIANTS.find((v) => v.value === variant) || GAME_VARIANTS[0];

  const handleCreate = async () => {
    if (!clubId) return;
    setCreating(true);
    try {
      const bb = parseFloat(bigBlind) || 2;
      const sb = parseFloat(smallBlind) || 1;

      if (tab === 'regular') {
        const { data, error } = await supabase
          .from('tables')
          .insert({
            club_id: clubId,
            name: name || `${variantInfo.label} ${sb}/${bb}`,
            game_type: 'cash',
            game_variant: variant,
            small_blind: sb,
            big_blind: bb,
            max_players: tableSize,
            min_buy_in: minBuyInBB * bb,
            max_buy_in: maxBuyInBB * bb,
            action_time: actionTime,
            status: 'waiting',
            created_by: user?.id,
            settings: { private_game: privateGame, bomb_pot: bombPot },
          })
          .select()
          .single();

        if (error) throw error;
        masterBus.emit('TABLE_CREATED', { tableId: data.id, clubId });
        masterBus.emit('DATA_MUTATED', { table: 'tables', action: 'created' });
        haptic('success');
        onCreated?.(data);
      } else {
        const { data, error } = await supabase
          .from('tournaments')
          .insert({
            club_id: clubId,
            name: name || `${variantInfo.label} ${tab.toUpperCase()}`,
            type: tab,
            game_variant: variant,
            buy_in: buyIn,
            starting_chips: startingChips,
            max_players: tab === 'sng' ? tableSize : 300,
            status: 'registering',
            created_by: user?.id,
            settings: {
              table_size: tableSize,
              action_time: actionTime,
              fee_percent: fee,
              blinds_up_minutes: blindsUpMinutes,
              private_game: privateGame,
            },
          })
          .select()
          .single();

        if (error) throw error;
        masterBus.emit('TOURNAMENT_UPDATED', { tournamentId: data.id, status: 'registering' });
        masterBus.emit('DATA_MUTATED', { table: 'tournaments', action: 'created' });
        haptic('success');
        onCreated?.(data);
      }
      onClose();
    } catch (err: any) {
      haptic('error');
      alert('Failed: ' + (err.message || 'Unknown error'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: FB.bg,
          borderRadius: 16,
          width: '100%',
          maxWidth: 440,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${FB.border}`,
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '14px 18px 0', borderBottom: `1px solid ${FB.border}` }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <h2 style={{ color: FB.textPrimary, fontSize: 16, fontWeight: 800, margin: 0 }}>
              {variantInfo.label}
            </h2>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: FB.textDim,
                fontSize: 20,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4, paddingBottom: 10 }}>
            {[
              { key: 'regular', label: 'Regular' },
              { key: 'sng', label: 'SNG' },
              { key: 'mtt', label: 'MTT' },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  flex: 1,
                  padding: 8,
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  background: tab === t.key ? FB.warning : FB.elevated,
                  color: tab === t.key ? '#000' : FB.textSecondary,
                  fontSize: 13,
                  fontWeight: 700,
                  transition: 'all 0.2s',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px', scrollbarWidth: 'thin' }}>
          {/* Name */}
          <div style={{ padding: '12px 0 8px' }}>
            <input
              type="text"
              placeholder="Enter table name here..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 14px',
                background: FB.cardBg,
                border: `1px solid ${FB.border}`,
                borderRadius: 8,
                color: FB.textPrimary,
                fontSize: 14,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <SectionHeader label="Settings" />
          <SliderInput
            label="Table Size"
            value={tableSize}
            onChange={setTableSize}
            min={2}
            max={10}
            suffix=" max"
          />
          <SliderInput
            label="Action Time"
            value={actionTime}
            onChange={setActionTime}
            min={5}
            max={60}
            suffix=" sec"
          />
          <Toggle label="Private Game" value={privateGame} onChange={setPrivateGame} />
          <Toggle label="Bomb Pot" value={bombPot} onChange={setBombPot} />

          {tab === 'regular' && (
            <>
              <SectionHeader label="Blinds & Buy-in" />
              <div style={{ padding: '8px 0', borderBottom: `1px solid ${FB.border}22` }}>
                <div
                  style={{ color: FB.textPrimary, fontSize: 13, fontWeight: 500, marginBottom: 6 }}
                >
                  Blinds: {smallBlind}/{bigBlind}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number"
                    value={smallBlind}
                    min={0.01}
                    step={0.01}
                    onChange={(e) => {
                      setSmallBlind(e.target.value);
                      setBigBlind(String(parseFloat(e.target.value || '0') * 2));
                    }}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      background: FB.elevated,
                      border: `1px solid ${FB.border}`,
                      borderRadius: 6,
                      color: FB.textPrimary,
                      fontSize: 13,
                      outline: 'none',
                    }}
                    placeholder="SB"
                  />
                  <span style={{ color: FB.textDim, lineHeight: '32px' }}>/</span>
                  <input
                    type="number"
                    value={bigBlind}
                    min={0.02}
                    step={0.01}
                    onChange={(e) => setBigBlind(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      background: FB.elevated,
                      border: `1px solid ${FB.border}`,
                      borderRadius: 6,
                      color: FB.textPrimary,
                      fontSize: 13,
                      outline: 'none',
                    }}
                    placeholder="BB"
                  />
                </div>
              </div>
              <SliderInput
                label="Min Buy-in"
                value={minBuyInBB}
                onChange={setMinBuyInBB}
                min={5}
                max={500}
                suffix=" BB"
              />
              <SliderInput
                label="Max Buy-in"
                value={maxBuyInBB}
                onChange={setMaxBuyInBB}
                min={5}
                max={500}
                suffix=" BB"
              />
            </>
          )}

          {(tab === 'sng' || tab === 'mtt') && (
            <>
              <SectionHeader label="Tournament" />
              <SliderInput label="Buy-in" value={buyIn} onChange={setBuyIn} min={10} max={10000} />
              <SliderInput label="Fee" value={fee} onChange={setFee} min={0} max={25} suffix="%" />
              <SliderInput
                label="Starting Chips"
                value={startingChips}
                onChange={setStartingChips}
                min={100}
                max={50000}
                step={100}
              />
              <SliderInput
                label="Blinds Up"
                value={blindsUpMinutes}
                onChange={setBlindsUpMinutes}
                min={1}
                max={30}
                suffix=" min"
              />
            </>
          )}
          <div style={{ height: 16 }} />
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '14px 18px',
            borderTop: `1px solid ${FB.border}`,
          }}
        >
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${FB.warning}`,
              background: 'transparent',
              color: FB.warning,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 10,
              border: 'none',
              background: creating ? FB.elevated : FB.success,
              color: '#fff',
              fontSize: 14,
              fontWeight: 700,
              cursor: creating ? 'default' : 'pointer',
            }}
          >
            {creating ? 'Creating...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Main export — orchestrates Screen 1 → Screen 2
interface CreateGameModalProps {
  clubId: string;
  onClose: () => void;
  onCreated?: (result: any) => void;
  initialVariant?: string;
}

export default function CreateGameModal({
  clubId,
  onClose,
  onCreated,
  initialVariant,
}: CreateGameModalProps) {
  const [screen, setScreen] = useState(initialVariant ? 'config' : 'type_select');
  const [variant, setVariant] = useState(initialVariant || 'nlh');

  const handleVariantSelect = (v: string) => {
    setVariant(v);
    setScreen('config');
  };

  if (screen === 'type_select') {
    return <GameTypeSelector onSelect={handleVariantSelect} onClose={onClose} />;
  }

  return (
    <ConfigModal
      variant={variant}
      onClose={() => {
        if (initialVariant) onClose();
        else setScreen('type_select');
      }}
      onCreated={onCreated}
      clubId={clubId}
    />
  );
}
