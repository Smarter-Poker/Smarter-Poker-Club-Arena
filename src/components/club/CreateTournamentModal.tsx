import React, { useState } from 'react';
import { tournamentService, BLIND_STRUCTURES, PAYOUT_STRUCTURES } from '../../services/TournamentService';
import styles from './CreateTournamentModal.module.css';

interface Props {
    clubId: string;
    onClose: () => void;
    onSuccess: () => void;
}

export default function CreateTournamentModal({ clubId, onClose, onSuccess }: Props) {
    const [name, setName] = useState('');
    const [type, setType] = useState<'sng' | 'mtt'>('sng');
    const [buyIn, setBuyIn] = useState('10');
    const [rake, setRake] = useState('1');
    const [startingChips, setStartingChips] = useState('1500');
    const [maxPlayers, setMaxPlayers] = useState('6');
    const [blindSpeed, setBlindSpeed] = useState<'turbo' | 'regular' | 'deepStack'>('turbo');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            await tournamentService.createTournament(clubId, {
                name,
                type,
                buyIn: parseFloat(buyIn),
                rake: parseFloat(rake),
                startingStack: parseInt(startingChips),
                maxPlayers: parseInt(maxPlayers),
                minPlayers: 2,
                blindStructure: BLIND_STRUCTURES[blindSpeed],
                payoutStructure: type === 'sng' ? PAYOUT_STRUCTURES.sng6 : PAYOUT_STRUCTURES.mtt20,
                lateRegistrationLevels: 0,
                isRebuy: false,
                addOnAvailable: false
            });
            onSuccess();
        } catch (error) {
            console.error('Failed to create tournament:', error);
            alert('Failed to create tournament');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className={styles.modalOverlay} onClick={onClose}>
            <div className={styles.modal} onClick={e => e.stopPropagation()}>
                <div className={styles.header}>
                    <h2>Create Tournament</h2>
                    <button className={styles.closeParams} onClick={onClose}>&times;</button>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className={styles.formGroup}>
                        <label>Tournament Name</label>
                        <input
                            className={styles.input}
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="e.g. Saturday Night Turbo"
                            required
                        />
                    </div>

                    <div className={styles.row}>
                        <div className={styles.col}>
                            <div className={styles.formGroup}>
                                <label>Type</label>
                                <select
                                    className={styles.select}
                                    value={type}
                                    onChange={e => setType(e.target.value as any)}
                                >
                                    <option value="sng">Sit & Go (SNG)</option>
                                    <option value="mtt">Multi-Table (MTT)</option>
                                </select>
                            </div>
                        </div>
                        <div className={styles.col}>
                            <div className={styles.formGroup}>
                                <label>Max Players</label>
                                <input
                                    type="number"
                                    className={styles.input}
                                    value={maxPlayers}
                                    onChange={e => setMaxPlayers(e.target.value)}
                                    min="2"
                                    max="1000"
                                />
                            </div>
                        </div>
                    </div>

                    <div className={styles.row}>
                        <div className={styles.col}>
                            <div className={styles.formGroup}>
                                <label>Buy-in ($)</label>
                                <input
                                    type="number"
                                    className={styles.input}
                                    value={buyIn}
                                    onChange={e => setBuyIn(e.target.value)}
                                    min="0"
                                />
                            </div>
                        </div>
                        <div className={styles.col}>
                            <div className={styles.formGroup}>
                                <label>Fee ($)</label>
                                <input
                                    type="number"
                                    className={styles.input}
                                    value={rake}
                                    onChange={e => setRake(e.target.value)}
                                    min="0"
                                />
                            </div>
                        </div>
                    </div>

                    <div className={styles.row}>
                        <div className={styles.col}>
                            <div className={styles.formGroup}>
                                <label>Starting Chips</label>
                                <input
                                    type="number"
                                    className={styles.input}
                                    value={startingChips}
                                    onChange={e => setStartingChips(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className={styles.col}>
                            <div className={styles.formGroup}>
                                <label>Speed</label>
                                <select
                                    className={styles.select}
                                    value={blindSpeed}
                                    onChange={e => setBlindSpeed(e.target.value as any)}
                                >
                                    <option value="turbo">Turbo (3m)</option>
                                    <option value="regular">Regular (8m)</option>
                                    <option value="deepStack">Deep Stack (15m)</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div className={styles.actions}>
                        <button type="button" className={styles.cancelBtn} onClick={onClose}>
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className={styles.createBtn}
                            disabled={!name || isSubmitting}
                        >
                            {isSubmitting ? 'Creating...' : 'Create Tournament'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
