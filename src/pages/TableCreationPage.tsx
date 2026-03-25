/**
 *  TABLE CREATION PAGE — Create New Poker Table
 */

import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './TableCreationPage.css';

const sectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 80}ms forwards`,
});

type GameType = 'nlh' | 'plo' | 'plo5' | 'ofc';

interface TableSettings {
  name: string;
  game_type: GameType;
  small_blind: number;
  big_blind: number;
  min_buyin_bb: number;
  max_buyin_bb: number;
  max_players: number;
  allow_straddle: boolean;
  allow_run_it_twice: boolean;
  allow_rabbit_hunt: boolean;
  time_bank_seconds: number;
  ante?: number;
}

export default function TableCreationPage() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const { user } = useAuthUser();

  const [settings, setSettings] = useState<TableSettings>({
    name: '',
    game_type: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buyin_bb: 40,
    max_buyin_bb: 200,
    max_players: 9,
    allow_straddle: true,
    allow_run_it_twice: true,
    allow_rabbit_hunt: true,
    time_bank_seconds: 30,
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Union guard: redirect back if club is in a union
  // FIX: Resolve clubId to UUID — union_clubs stores UUIDs, not integer club_ids
  useEffect(() => {
    if (!clubId) return;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (data) navigate(`/clubs/${clubId}`, { replace: true });
      } catch {
        /* fail-open */
      }
    })();
  }, [clubId, navigate]);

  const handleCreate = async () => {
    if (!settings.name.trim()) {
      setError('Please enter a table name');
      return;
    }
    if (!clubId) {
      setError('No club selected');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      // UNION GUARD (defense-in-depth): Block creation even if useEffect redirect didn't fire yet
      const resolvedClubId = await resolveClubUUID(clubId);
      const { data: unionCheck } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedClubId)
        .limit(1)
        .maybeSingle();
      if (unionCheck) {
        throw new Error('Clubs inside a union cannot create standalone tables. Tables are managed at the union level.');
      }

      const { data, error: createError } = await supabase
        .from('tables')
        .insert({
          club_id: resolvedClubId, // FIX: was using raw clubId — must use resolved UUID
          name: settings.name.trim(),
          game_type: settings.game_type,
          small_blind: settings.small_blind,
          big_blind: settings.big_blind,
          min_buyin: settings.min_buyin_bb * settings.big_blind,
          max_buyin: settings.max_buyin_bb * settings.big_blind,
          max_players: settings.max_players,
          allow_straddle: settings.allow_straddle,
          allow_run_it_twice: settings.allow_run_it_twice,
          allow_rabbit_hunt: settings.allow_rabbit_hunt,
          time_bank_seconds: settings.time_bank_seconds,
          ante: settings.ante || 0,
          status: 'waiting',
          current_players: 0,
        })
        .select()
        .maybeSingle();

      if (createError) throw createError;
      if (!data) throw new Error('Table creation returned no data');

      // Notify other pages (lobby, club home) about the new table
      masterBus.emit('TABLE_CREATED', { tableId: data.id, clubId, table: data });

      navigate(`/table/${data.id}`);
    } catch (err: any) {
      console.error('Failed to create table:', err);
      setError(err.message || 'Failed to create table');
    }
    setCreating(false);
  };

  const updateSetting = <K extends keyof TableSettings>(key: K, value: TableSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const gameTypes: { value: GameType; label: string; icon: string }[] = [
    { value: 'nlh', label: "No Limit Hold'em", icon: '♠' },
    { value: 'plo', label: 'Pot Limit Omaha', icon: '♦' },
    { value: 'plo5', label: 'PLO 5-Card', icon: '♥' },
    { value: 'ofc', label: 'Open Face Chinese', icon: '♣' },
  ];

  const stakesPresets = [
    { sb: 0.5, bb: 1, label: '0.5/1' },
    { sb: 1, bb: 2, label: '1/2' },
    { sb: 2, bb: 5, label: '2/5' },
    { sb: 5, bb: 10, label: '5/10' },
    { sb: 10, bb: 20, label: '10/20' },
    { sb: 25, bb: 50, label: '25/50' },
  ];

  return (
    <div className="table-creation-page">
      <div className="creation-content">
        {error && <div className="error-message">{error}</div>}

        {/* Table Name */}
        <section className="creation-section" style={sectionAnimationStyle(0)}>
          <h3>Table Name</h3>
          <input
            type="text"
            placeholder="Enter table name..."
            value={settings.name}
            onChange={(e) => updateSetting('name', e.target.value)}
            className="name-input"
          />
        </section>

        {/* Game Type */}
        <section className="creation-section" style={sectionAnimationStyle(1)}>
          <h3>Game Type</h3>
          <div className="game-types">
            {gameTypes.map((game) => (
              <button
                key={game.value}
                className={`game-type-btn ${settings.game_type === game.value ? 'active' : ''}`}
                onClick={() => updateSetting('game_type', game.value)}
              >
                <span className="game-icon">{game.icon}</span>
                <span className="game-label">{game.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Stakes */}
        <section className="creation-section" style={sectionAnimationStyle(2)}>
          <h3>Stakes</h3>
          <div className="stakes-presets">
            {stakesPresets.map((stake) => (
              <button
                key={stake.label}
                className={`stake-btn ${settings.small_blind === stake.sb && settings.big_blind === stake.bb ? 'active' : ''}`}
                onClick={() => {
                  updateSetting('small_blind', stake.sb);
                  updateSetting('big_blind', stake.bb);
                }}
              >
                {stake.label}
              </button>
            ))}
          </div>
          <div className="custom-stakes">
            <div className="stake-input">
              <label>SB</label>
              <input
                type="number"
                value={settings.small_blind}
                onChange={(e) => updateSetting('small_blind', parseFloat(e.target.value))}
                min={0.01}
                step={0.5}
              />
            </div>
            <span className="stake-divider">/</span>
            <div className="stake-input">
              <label>BB</label>
              <input
                type="number"
                value={settings.big_blind}
                onChange={(e) => updateSetting('big_blind', parseFloat(e.target.value))}
                min={0.02}
                step={1}
              />
            </div>
          </div>
        </section>

        {/* Table Size */}
        <section className="creation-section" style={sectionAnimationStyle(3)}>
          <h3>Table Size</h3>
          <div className="size-options">
            {[2, 6, 8, 9].map((size) => (
              <button
                key={size}
                className={`size-btn ${settings.max_players === size ? 'active' : ''}`}
                onClick={() => updateSetting('max_players', size)}
              >
                {size} max
              </button>
            ))}
          </div>
        </section>

        {/* Buy-in Range */}
        <section className="creation-section" style={sectionAnimationStyle(4)}>
          <h3>Buy-in Range (BB)</h3>
          <div className="buyin-range">
            <div className="buyin-input">
              <label>Min</label>
              <input
                type="number"
                value={settings.min_buyin_bb}
                onChange={(e) => updateSetting('min_buyin_bb', parseInt(e.target.value))}
                min={20}
                max={100}
              />
            </div>
            <span className="range-divider">—</span>
            <div className="buyin-input">
              <label>Max</label>
              <input
                type="number"
                value={settings.max_buyin_bb}
                onChange={(e) => updateSetting('max_buyin_bb', parseInt(e.target.value))}
                min={100}
              />
            </div>
          </div>
        </section>

        {/* Options */}
        <section className="creation-section" style={sectionAnimationStyle(5)}>
          <h3>Options</h3>
          <div className="options-list">
            <div className="option-row">
              <span>Allow Straddle</span>
              <button
                className={`toggle-btn ${settings.allow_straddle ? 'on' : ''}`}
                onClick={() => updateSetting('allow_straddle', !settings.allow_straddle)}
              >
                {settings.allow_straddle ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="option-row">
              <span>Run It Twice</span>
              <button
                className={`toggle-btn ${settings.allow_run_it_twice ? 'on' : ''}`}
                onClick={() => updateSetting('allow_run_it_twice', !settings.allow_run_it_twice)}
              >
                {settings.allow_run_it_twice ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="option-row">
              <span>Rabbit Hunt</span>
              <button
                className={`toggle-btn ${settings.allow_rabbit_hunt ? 'on' : ''}`}
                onClick={() => updateSetting('allow_rabbit_hunt', !settings.allow_rabbit_hunt)}
              >
                {settings.allow_rabbit_hunt ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </section>

        <button
          className="btn btn-primary create-btn"
          onClick={handleCreate}
          disabled={creating || !settings.name.trim()}
        >
          {creating ? 'Creating...' : ' Create Table'}
        </button>
      </div>
    </div>
  );
}
