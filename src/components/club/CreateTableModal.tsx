/**
 * ♠ CLUB ARENA — Create Table Modal
 * Full-featured cash game creation with ALL settings required before going live
 */

import { useState, useEffect } from 'react';
import { tableService } from '../../services/TableService';
import type { GameVariant, TableSettings } from '../../types/database.types';
import styles from './CreateTableModal.module.css';

interface CreateTableModalProps {
  clubId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const VARIANTS: { value: GameVariant; label: string }[] = [
  { value: 'nlh', label: "No Limit Hold'em" },
  { value: 'plo4', label: 'Pot Limit Omaha (4-Card)' },
  { value: 'plo5', label: 'PLO 5-Card' },
  { value: 'plo6', label: 'PLO 6-Card' },
  { value: 'plo8', label: 'PLO Hi/Lo (8-or-Better)' },
  { value: 'short_deck', label: 'Short Deck (6+)' },
  { value: 'ofc', label: 'Open Face Chinese' },
];

const STAKE_PRESETS = [
  { sb: 0.01, bb: 0.02, label: '0.01/0.02' },
  { sb: 0.05, bb: 0.1, label: '0.05/0.10' },
  { sb: 0.1, bb: 0.2, label: '0.10/0.20' },
  { sb: 0.25, bb: 0.5, label: '0.25/0.50' },
  { sb: 0.5, bb: 1, label: '0.50/1' },
  { sb: 1, bb: 2, label: '1/2' },
  { sb: 2, bb: 5, label: '2/5' },
  { sb: 5, bb: 10, label: '5/10' },
  { sb: 10, bb: 20, label: '10/20' },
  { sb: 25, bb: 50, label: '25/50' },
  { sb: 50, bb: 100, label: '50/100' },
];

export default function CreateTableModal({ clubId, onClose, onSuccess }: CreateTableModalProps) {
  const [name, setName] = useState('');
  const [variant, setVariant] = useState<GameVariant>('nlh');
  const [smallBlind, setSmallBlind] = useState('1');
  const [bigBlind, setBigBlind] = useState('2');
  const [maxPlayers, setMaxPlayers] = useState('9');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useCustomStakes, setUseCustomStakes] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => {
    setModalVisible(false);
    const timer = setTimeout(() => setModalVisible(true), 30);
    return () => clearTimeout(timer);
  }, []);

  // ── Buy-in Range ──
  const [minBuyinBB, setMinBuyinBB] = useState('20');
  const [maxBuyinBB, setMaxBuyinBB] = useState('100');

  // ── Action Time ──
  const [actionTime, setActionTime] = useState('15');

  // ── Time Limit ──
  const [timeLimitMins, setTimeLimitMins] = useState('0');

  // ── Ante ──
  const [anteAmount, setAnteAmount] = useState('0');

  // ── All Feature Toggles (checkbox selectors) ──
  const [settings, setSettings] = useState<Partial<TableSettings>>({
    straddle_enabled: true,
    straddle_type: 'utg',
    run_it_twice: true,
    bomb_pot_enabled: false,
    bomb_pot_frequency: 10,
    bomb_pot_ante_bb: 2,
    time_bank_seconds: 30,
    auto_muck: true,
    vpip_display: false,
    ante_enabled: false,
    ante_amount: 0,
    no_rathole: false,
    double_board: false,
    time_limit_minutes: 0,
    action_time_seconds: 15,
    min_buyin_bb: 20,
    max_buyin_bb: 100,
    insurance_enabled: false,
    auto_restart: true,
    call_time_enabled: false,
  });

  const toggleSetting = (key: keyof TableSettings) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const applyStakePreset = (preset: (typeof STAKE_PRESETS)[0]) => {
    setSmallBlind(String(preset.sb));
    setBigBlind(String(preset.bb));
    setUseCustomStakes(false);
  };

  // ── Validation ──
  const sb = parseFloat(smallBlind) || 0;
  const bb = parseFloat(bigBlind) || 0;
  const minBB = parseFloat(minBuyinBB) || 0;
  const maxBB = parseFloat(maxBuyinBB) || 0;

  const isValid = (() => {
    if (!name.trim()) return false;
    if (sb <= 0 || bb <= 0) return false;
    if (bb <= sb) return false;
    if (minBB <= 0 || maxBB <= 0 || maxBB < minBB) return false;
    return true;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    setLoading(true);
    setError(null);

    try {
      const fullSettings: Partial<TableSettings> = {
        ...settings,
        ante_enabled: parseFloat(anteAmount) > 0,
        ante_amount: parseFloat(anteAmount) || 0,
        action_time_seconds: parseInt(actionTime) || 15,
        time_limit_minutes: parseInt(timeLimitMins) || 0,
        min_buyin_bb: parseFloat(minBuyinBB) || 20,
        max_buyin_bb: parseFloat(maxBuyinBB) || 100,
      };

      await tableService.createTable(
        clubId,
        name.trim(),
        variant,
        sb,
        bb,
        Number(maxPlayers),
        fullSettings
      );
      onSuccess();
    } catch (err) {
      console.error('Failed to create table:', err);
      setError((err as Error).message || 'Failed to create table. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={styles['modal-overlay']}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles['modal-content']}
        style={{
          opacity: modalVisible ? 1 : 0,
          transform: modalVisible ? 'translateY(0)' : 'translateY(20px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <header className={styles['modal-header']}>
          <h2>Create Cash Game</h2>
          <button className={styles['close-btn']} onClick={onClose}>
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          {error && <div className={styles['error-toast']}>{error}</div>}
          <div className={styles['modal-body']}>
            {/* ── Table Name (required) ── */}
            <div className={styles['form-group']}>
              <label>
                Table Name <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                type="text"
                className="input"
                placeholder="e.g. Friday Night High Stakes"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                style={!name.trim() ? { borderColor: '#ef4444' } : undefined}
              />
            </div>

            {/* ── Game Type & Table Size (required) ── */}
            <div className={styles['form-row']}>
              <div className={styles['form-group']}>
                <label>
                  Game Type <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <select
                  className={styles['form-select']}
                  value={variant}
                  onChange={(e) => setVariant(e.target.value as GameVariant)}
                >
                  {VARIANTS.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles['form-group']}>
                <label>
                  Table Size <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <select
                  className={styles['form-select']}
                  value={maxPlayers}
                  onChange={(e) => setMaxPlayers(e.target.value)}
                >
                  <option value="2">Heads Up (2)</option>
                  <option value="6">6-Max</option>
                  <option value="9">Full Ring (9)</option>
                </select>
              </div>
            </div>

            {/* ── Stakes (required) ── */}
            <div className={styles['form-group']}>
              <label>
                Stakes <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <div className={styles['stake-presets']}>
                {STAKE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`${styles['stake-chip']} ${!useCustomStakes && sb === p.sb && bb === p.bb ? styles['stake-chip-active'] : ''}`}
                    onClick={() => applyStakePreset(p)}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`${styles['stake-chip']} ${useCustomStakes ? styles['stake-chip-active'] : ''}`}
                  onClick={() => setUseCustomStakes(true)}
                >
                  Custom
                </button>
              </div>
              {useCustomStakes && (
                <div className={styles['form-row']} style={{ marginTop: 8 }}>
                  <div className={styles['form-group']}>
                    <label>Small Blind</label>
                    <input
                      type="number"
                      className="input"
                      min="0.01"
                      step="0.01"
                      value={smallBlind}
                      onChange={(e) => setSmallBlind(e.target.value)}
                      required
                    />
                  </div>
                  <div className={styles['form-group']}>
                    <label>Big Blind</label>
                    <input
                      type="number"
                      className="input"
                      min="0.02"
                      step="0.01"
                      value={bigBlind}
                      onChange={(e) => setBigBlind(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ── Buy-in Range (required) ── */}
            <div className={styles['form-row']}>
              <div className={styles['form-group']}>
                <label>
                  Min Buy-in (BB) <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="number"
                  className="input"
                  min="1"
                  value={minBuyinBB}
                  onChange={(e) => setMinBuyinBB(e.target.value)}
                  required
                />
              </div>
              <div className={styles['form-group']}>
                <label>
                  Max Buy-in (BB) <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="number"
                  className="input"
                  min="1"
                  value={maxBuyinBB}
                  onChange={(e) => setMaxBuyinBB(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* ── Action Time & Time Limit ── */}
            <div className={styles['form-row']}>
              <div className={styles['form-group']}>
                <label>Action Time (sec)</label>
                <select
                  className={styles['form-select']}
                  value={actionTime}
                  onChange={(e) => setActionTime(e.target.value)}
                >
                  <option value="10">10s (Fast)</option>
                  <option value="15">15s (Standard)</option>
                  <option value="20">20s</option>
                  <option value="30">30s</option>
                  <option value="45">45s</option>
                  <option value="60">60s (Slow)</option>
                </select>
              </div>
              <div className={styles['form-group']}>
                <label>Table Time Limit</label>
                <select
                  className={styles['form-select']}
                  value={timeLimitMins}
                  onChange={(e) => setTimeLimitMins(e.target.value)}
                >
                  <option value="0">No Limit</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="180">3 hours</option>
                  <option value="240">4 hours</option>
                  <option value="360">6 hours</option>
                  <option value="480">8 hours</option>
                </select>
              </div>
            </div>

            {/* ── Ante ── */}
            <div className={styles['form-row']}>
              <div className={styles['form-group']}>
                <label>Ante (chips)</label>
                <input
                  type="number"
                  className="input"
                  min="0"
                  step="0.01"
                  value={anteAmount}
                  onChange={(e) => setAnteAmount(e.target.value)}
                />
                <span className={styles['helper-text']}>0 = no ante</span>
              </div>
            </div>

            {/* ═══════════════════════════════════════════
                            GAME FEATURES — Checkbox Selectors
                        ═══════════════════════════════════════════ */}
            <div className={styles['form-group']}>
              <label
                style={{ fontSize: '0.85rem', fontWeight: 700, color: '#10b981', marginBottom: 8 }}
              >
                Game Features
              </label>
              <div className={styles['settings-grid']}>
                {/* ── Straddle ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.straddle_enabled}
                    onChange={() => toggleSetting('straddle_enabled')}
                  />
                  Straddle
                </label>

                {settings.straddle_enabled && (
                  <div style={{ paddingLeft: 20, marginBottom: 4 }}>
                    <select
                      className={styles['form-select']}
                      value={settings.straddle_type || 'utg'}
                      onChange={(e) =>
                        setSettings((prev) => ({ ...prev, straddle_type: e.target.value as any }))
                      }
                      style={{ fontSize: '0.7rem', padding: '2px 6px' }}
                    >
                      <option value="utg">UTG Straddle</option>
                      <option value="any_position">Any Position</option>
                      <option value="mississippi">Mississippi</option>
                    </select>
                  </div>
                )}

                {/* ── Run It Twice ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.run_it_twice}
                    onChange={() => toggleSetting('run_it_twice')}
                  />
                  Run It Twice (RIT)
                </label>

                {/* ── VPIP Display ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.vpip_display}
                    onChange={() => toggleSetting('vpip_display')}
                  />
                  VPIP Display
                </label>

                {/* ── Bomb Pots ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.bomb_pot_enabled}
                    onChange={() => toggleSetting('bomb_pot_enabled')}
                  />
                  Bomb Pots
                </label>

                {settings.bomb_pot_enabled && (
                  <div className={styles['form-row']} style={{ paddingLeft: 20, marginBottom: 4 }}>
                    <div className={styles['form-group']} style={{ flex: 1 }}>
                      <label style={{ fontSize: '0.65rem' }}>Every N hands</label>
                      <input
                        type="number"
                        className="input"
                        min="5"
                        max="50"
                        value={settings.bomb_pot_frequency || 10}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            bomb_pot_frequency: parseInt(e.target.value) || 10,
                          }))
                        }
                        style={{ fontSize: '0.7rem', padding: '2px 6px' }}
                      />
                    </div>
                    <div className={styles['form-group']} style={{ flex: 1 }}>
                      <label style={{ fontSize: '0.65rem' }}>Ante (BB)</label>
                      <input
                        type="number"
                        className="input"
                        min="1"
                        max="10"
                        value={settings.bomb_pot_ante_bb || 2}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            bomb_pot_ante_bb: parseInt(e.target.value) || 2,
                          }))
                        }
                        style={{ fontSize: '0.7rem', padding: '2px 6px' }}
                      />
                    </div>
                  </div>
                )}

                {/* ── No Rathole ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.no_rathole}
                    onChange={() => toggleSetting('no_rathole')}
                  />
                  No Rathole
                </label>

                {/* ── Double Board ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.double_board}
                    onChange={() => toggleSetting('double_board')}
                  />
                  Double Board
                </label>

                {/* ── Insurance ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.insurance_enabled}
                    onChange={() => toggleSetting('insurance_enabled')}
                  />
                  All-in Insurance
                </label>

                {/* ── Auto Muck ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.auto_muck}
                    onChange={() => toggleSetting('auto_muck')}
                  />
                  Auto Muck
                </label>

                {/* ── Call Time / Shot Clock ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.call_time_enabled}
                    onChange={() => toggleSetting('call_time_enabled')}
                  />
                  Call Time (Shot Clock)
                </label>

                {/* ── Auto Restart ── */}
                <label className={styles['checkbox-label']}>
                  <input
                    type="checkbox"
                    checked={settings.auto_restart}
                    onChange={() => toggleSetting('auto_restart')}
                  />
                  Auto Restart
                </label>
              </div>
            </div>

            {/* ── Validation Summary ── */}
            {!isValid && (
              <div style={{ color: '#ef4444', fontSize: '0.75rem', padding: '6px 0' }}>
                {!name.trim() && <p>Table name is required</p>}
                {sb <= 0 && <p>Small blind must be greater than 0</p>}
                {bb <= sb && bb > 0 && <p>Big blind must be greater than small blind</p>}
                {maxBB < minBB && <p>Max buy-in must be greater than or equal to min buy-in</p>}
              </div>
            )}
          </div>

          <div className={styles['modal-footer']}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading || !isValid}>
              {loading ? 'Creating...' : 'Create Table'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
