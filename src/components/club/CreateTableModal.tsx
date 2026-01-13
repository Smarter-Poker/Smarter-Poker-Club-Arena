/**
 * ♠ CLUB ARENA — Create Table Modal
 * Modal for creating new poker tables
 */

import { useState } from 'react';
import { tableService } from '../../services/TableService';
import type { GameVariant, TableSettings } from '../../types/database.types';
import styles from './CreateTableModal.module.css';

interface CreateTableModalProps {
    clubId: string;
    onClose: () => void;
    onSuccess: () => void;
}

const VARIANTS: { value: GameVariant; label: string }[] = [
    { value: 'nlh', label: 'No Limit Hold\'em' },
    { value: 'plo4', label: 'Pot Limit Omaha (4-Card)' },
    { value: 'plo5', label: 'PLO 5-Card' },
    { value: 'plo6', label: 'PLO 6-Card' },
    { value: 'plo8', label: 'PLO Hi/Lo (8-or-Better)' },
    { value: 'short_deck', label: 'Short Deck (6+)' },
    { value: 'ofc', label: 'Open Face Chinese' },
];

export default function CreateTableModal({ clubId, onClose, onSuccess }: CreateTableModalProps) {
    const [name, setName] = useState('');
    const [variant, setVariant] = useState<GameVariant>('nlh');
    const [smallBlind, setSmallBlind] = useState('1');
    const [bigBlind, setBigBlind] = useState('2');
    const [maxPlayers, setMaxPlayers] = useState('9');
    const [loading, setLoading] = useState(false);

    // Advanced Settings
    const [settings, setSettings] = useState<Partial<TableSettings>>({
        straddle_enabled: true,
        run_it_twice: true,
        bomb_pot_enabled: false,
        time_bank_seconds: 30,
        auto_muck: true,
    });

    const handleSettingChange = (key: keyof TableSettings) => {
        setSettings(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            await tableService.createTable(
                clubId,
                name || `New ${VARIANTS.find(v => v.value === variant)?.label} Table`,
                variant,
                Number(smallBlind),
                Number(bigBlind),
                Number(maxPlayers),
                settings
            );
            onSuccess();
        } catch (error) {
            console.error('Failed to create table:', error);
            // In a real app, show error toast
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={styles['modal-overlay']} onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
        }}>
            <div className={styles['modal-content']}>
                <header className={styles['modal-header']}>
                    <h2>Create New Table</h2>
                    <button className={styles['close-btn']} onClick={onClose}>✕</button>
                </header>

                <form onSubmit={handleSubmit}>
                    <div className={styles['modal-body']}>
                        {/* Basic Info */}
                        <div className={styles['form-group']}>
                            <label>Table Name</label>
                            <input
                                type="text"
                                className="input"
                                placeholder="e.g. Friday Night High Stakes"
                                value={name}
                                onChange={e => setName(e.target.value)}
                            />
                        </div>

                        <div className={styles['form-row']}>
                            <div className={styles['form-group']}>
                                <label>Game Type</label>
                                <select
                                    className={styles['form-select']}
                                    value={variant}
                                    onChange={e => setVariant(e.target.value as GameVariant)}
                                >
                                    {VARIANTS.map(v => (
                                        <option key={v.value} value={v.value}>{v.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div className={styles['form-group']}>
                                <label>Players</label>
                                <select
                                    className={styles['form-select']}
                                    value={maxPlayers}
                                    onChange={e => setMaxPlayers(e.target.value)}
                                >
                                    <option value="2">Heads Up (2)</option>
                                    <option value="6">6-Max</option>
                                    <option value="9">Full Ring (9)</option>
                                </select>
                            </div>
                        </div>

                        <div className={styles['form-row']}>
                            <div className={styles['form-group']}>
                                <label>Small Blind ($)</label>
                                <input
                                    type="number"
                                    className="input"
                                    min="0.01"
                                    step="0.01"
                                    value={smallBlind}
                                    onChange={e => setSmallBlind(e.target.value)}
                                    required
                                />
                            </div>
                            <div className={styles['form-group']}>
                                <label>Big Blind ($)</label>
                                <input
                                    type="number"
                                    className="input"
                                    min="0.02"
                                    step="0.01"
                                    value={bigBlind}
                                    onChange={e => setBigBlind(e.target.value)}
                                    required
                                />
                            </div>
                        </div>

                        {/* Advanced Settings */}
                        <div className={styles['form-group']}>
                            <label>Table Options</label>
                            <div className={styles['settings-grid']}>
                                <label className={styles['checkbox-label']}>
                                    <input
                                        type="checkbox"
                                        checked={settings.straddle_enabled}
                                        onChange={() => handleSettingChange('straddle_enabled')}
                                    />
                                    Enable Straddle
                                </label>
                                <label className={styles['checkbox-label']}>
                                    <input
                                        type="checkbox"
                                        checked={settings.run_it_twice}
                                        onChange={() => handleSettingChange('run_it_twice')}
                                    />
                                    Run It Twice (RIT)
                                </label>
                                <label className={styles['checkbox-label']}>
                                    <input
                                        type="checkbox"
                                        checked={settings.bomb_pot_enabled}
                                        onChange={() => handleSettingChange('bomb_pot_enabled')}
                                    />
                                    Bomb Pots
                                </label>
                                <label className={styles['checkbox-label']}>
                                    <input
                                        type="checkbox"
                                        checked={settings.auto_muck}
                                        onChange={() => handleSettingChange('auto_muck')}
                                    />
                                    Auto Muck
                                </label>
                            </div>
                        </div>
                    </div>

                    <div className={styles['modal-footer']}>
                        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={loading}>
                            {loading ? 'Creating...' : 'Create Table'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
