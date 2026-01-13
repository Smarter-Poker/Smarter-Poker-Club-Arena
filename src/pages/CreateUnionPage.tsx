/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Create Union Page
 * Multi-club network creation wizard
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './CreateUnionPage.module.css';
import { supabase, isDemoMode } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UnionFormData {
    name: string;
    description: string;
    isPublic: boolean;

    // Revenue sharing
    revenueSharePercent: number;
    sharedPlayerPool: boolean;
    crossClubTournaments: boolean;

    // Settlement
    settlementDay: 'sunday' | 'monday' | 'friday';
    gracePeriodDays: number;
}

const DEFAULT_FORM: UnionFormData = {
    name: '',
    description: '',
    isPublic: true,

    revenueSharePercent: 10,
    sharedPlayerPool: true,
    crossClubTournaments: true,

    settlementDay: 'sunday',
    gracePeriodDays: 3,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function CreateUnionPage() {
    const navigate = useNavigate();
    const { user } = useUserStore();
    const [step, setStep] = useState(1);
    const [form, setForm] = useState<UnionFormData>(DEFAULT_FORM);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checkingClubs, setCheckingClubs] = useState(true);
    const [ownsClub, setOwnsClub] = useState(false);

    const totalSteps = 3;

    // Check if user owns any clubs (required to create union)
    useState(() => {
        const checkClubOwnership = async () => {
            if (isDemoMode) {
                // In demo mode, assume they have a club
                setOwnsClub(true);
                setCheckingClubs(false);
                return;
            }

            try {
                const { count } = await supabase
                    .from('clubs')
                    .select('id', { count: 'exact', head: true })
                    .eq('owner_id', user?.id);

                setOwnsClub((count || 0) > 0);
            } catch (e) {
                console.error('Failed to check club ownership:', e);
                setOwnsClub(false);
            } finally {
                setCheckingClubs(false);
            }
        };

        checkClubOwnership();
    });

    // Show "create club first" message if user doesn't own a club
    if (!checkingClubs && !ownsClub) {
        return (
            <div className={styles.page}>
                <div className={styles.container}>
                    <div className={styles.noClubMessage}>
                        <span className={styles.noClubIcon}>🏠</span>
                        <h2>Create a Club First</h2>
                        <p>You need to own at least one club before you can create a union.</p>
                        <button
                            className={styles.createClubBtn}
                            onClick={() => navigate('/clubs/create')}
                        >
                            Create Your First Club
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const updateForm = (updates: Partial<UnionFormData>) => {
        setForm(prev => ({ ...prev, ...updates }));
        setError(null);
    };

    const validateStep = (): boolean => {
        switch (step) {
            case 1:
                if (!form.name.trim()) {
                    setError('Union name is required');
                    return false;
                }
                if (form.name.length < 3) {
                    setError('Union name must be at least 3 characters');
                    return false;
                }
                break;
        }
        return true;
    };

    const handleNext = () => {
        if (!validateStep()) return;
        if (step < totalSteps) setStep(step + 1);
    };

    const handleBack = () => {
        if (step > 1) setStep(step - 1);
    };

    const handleCreate = async () => {
        if (!validateStep()) return;

        setCreating(true);
        setError(null);

        try {
            if (isDemoMode) {
                await new Promise(r => setTimeout(r, 1000));
                navigate('/unions/demo-new-union');
                return;
            }

            const { data, error: insertError } = await supabase
                .from('unions')
                .insert({
                    name: form.name.trim(),
                    description: form.description.trim() || null,
                    owner_id: user?.id,
                    settings: {
                        revenue_share_percent: form.revenueSharePercent,
                        shared_player_pool: form.sharedPlayerPool,
                        cross_club_tournaments: form.crossClubTournaments,
                        settlement_day: form.settlementDay,
                        grace_period_days: form.gracePeriodDays,
                    },
                })
                .select()
                .single();

            if (insertError) throw insertError;
            navigate(`/unions/${data.id}`);
        } catch (err: any) {
            console.error('Failed to create union:', err);
            setError(err.message || 'Failed to create union');
        } finally {
            setCreating(false);
        }
    };

    return (
        <div className={styles.page}>
            <div className={styles.container}>
                {/* Header */}
                <header className={styles.header}>
                    <button className={styles.backButton} onClick={() => navigate('/unions')}>
                        ← Back
                    </button>
                    <h1>Create Your Union</h1>
                </header>

                {/* Progress */}
                <div className={styles.progress}>
                    {[1, 2, 3].map(s => (
                        <div
                            key={s}
                            className={`${styles.progressStep} ${s === step ? styles.active : ''} ${s < step ? styles.completed : ''}`}
                        >
                            <span className={styles.progressDot}>{s < step ? '✓' : s}</span>
                            <span className={styles.progressLabel}>
                                {s === 1 && 'Basics'}
                                {s === 2 && 'Revenue'}
                                {s === 3 && 'Review'}
                            </span>
                        </div>
                    ))}
                    <div className={styles.progressLine}>
                        <div className={styles.progressFill} style={{ width: `${((step - 1) / (totalSteps - 1)) * 100}%` }} />
                    </div>
                </div>

                {/* Step Content */}
                <div className={styles.stepContainer}>
                    {step === 1 && (
                        <div className={styles.stepContent}>
                            <h2>🌐 Union Basics</h2>
                            <p className={styles.stepDesc}>Create a network of clubs with shared resources.</p>

                            <div className={styles.formGroup}>
                                <label>Union Name *</label>
                                <input
                                    type="text"
                                    className={styles.textInput}
                                    placeholder="Enter union name..."
                                    value={form.name}
                                    onChange={(e) => updateForm({ name: e.target.value })}
                                    maxLength={50}
                                />
                            </div>

                            <div className={styles.formGroup}>
                                <label>Description</label>
                                <textarea
                                    className={styles.textArea}
                                    placeholder="Describe your union..."
                                    value={form.description}
                                    onChange={(e) => updateForm({ description: e.target.value })}
                                    rows={4}
                                />
                            </div>

                            <label className={styles.checkbox}>
                                <input
                                    type="checkbox"
                                    checked={form.isPublic}
                                    onChange={(e) => updateForm({ isPublic: e.target.checked })}
                                />
                                <span className={styles.checkmark} />
                                <div>
                                    <strong>Public Union</strong>
                                    <p>Other clubs can discover and request to join</p>
                                </div>
                            </label>
                        </div>
                    )}

                    {step === 2 && (
                        <div className={styles.stepContent}>
                            <h2>💰 Revenue & Features</h2>
                            <p className={styles.stepDesc}>Configure profit sharing and shared features.</p>

                            <div className={styles.settingsGrid}>
                                <div className={styles.formGroup}>
                                    <label>Union Revenue Share</label>
                                    <div className={styles.inputWithUnit}>
                                        <input
                                            type="number"
                                            className={styles.numberInput}
                                            value={form.revenueSharePercent}
                                            onChange={(e) => updateForm({ revenueSharePercent: Number(e.target.value) })}
                                            min={0}
                                            max={50}
                                        />
                                        <span>%</span>
                                    </div>
                                    <span className={styles.hint}>% of club rake to union</span>
                                </div>

                                <div className={styles.formGroup}>
                                    <label>Settlement Day</label>
                                    <select
                                        className={styles.select}
                                        value={form.settlementDay}
                                        onChange={(e) => updateForm({ settlementDay: e.target.value as UnionFormData['settlementDay'] })}
                                    >
                                        <option value="sunday">Sunday</option>
                                        <option value="monday">Monday</option>
                                        <option value="friday">Friday</option>
                                    </select>
                                </div>

                                <div className={styles.formGroup}>
                                    <label>Grace Period</label>
                                    <div className={styles.inputWithUnit}>
                                        <input
                                            type="number"
                                            className={styles.numberInput}
                                            value={form.gracePeriodDays}
                                            onChange={(e) => updateForm({ gracePeriodDays: Number(e.target.value) })}
                                            min={1}
                                            max={7}
                                        />
                                        <span>days</span>
                                    </div>
                                </div>
                            </div>

                            <div className={styles.togglesContainer}>
                                <label className={styles.toggle}>
                                    <input
                                        type="checkbox"
                                        checked={form.sharedPlayerPool}
                                        onChange={(e) => updateForm({ sharedPlayerPool: e.target.checked })}
                                    />
                                    <span className={styles.toggleSlider} />
                                    <div>
                                        <strong>Shared Player Pool</strong>
                                        <p>Players can move between clubs in the union</p>
                                    </div>
                                </label>

                                <label className={styles.toggle}>
                                    <input
                                        type="checkbox"
                                        checked={form.crossClubTournaments}
                                        onChange={(e) => updateForm({ crossClubTournaments: e.target.checked })}
                                    />
                                    <span className={styles.toggleSlider} />
                                    <div>
                                        <strong>Cross-Club Tournaments</strong>
                                        <p>Host tournaments across all member clubs</p>
                                    </div>
                                </label>
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className={styles.stepContent}>
                            <h2>✨ Review & Create</h2>
                            <p className={styles.stepDesc}>Review your union settings before creating.</p>

                            <div className={styles.previewCard}>
                                <div className={styles.previewHeader}>
                                    <div className={styles.previewAvatar}>
                                        {form.name.charAt(0).toUpperCase() || '?'}
                                    </div>
                                    <div>
                                        <h3>{form.name || 'Unnamed Union'}</h3>
                                        <p>{form.isPublic ? '🌍 Public Union' : '🔒 Private Union'}</p>
                                    </div>
                                </div>

                                {form.description && (
                                    <p className={styles.previewDesc}>{form.description}</p>
                                )}

                                <div className={styles.previewStats}>
                                    <div>
                                        <strong>{form.revenueSharePercent}%</strong>
                                        <span>Revenue Share</span>
                                    </div>
                                    <div>
                                        <strong>{form.settlementDay}</strong>
                                        <span>Settlement</span>
                                    </div>
                                    <div>
                                        <strong>{form.gracePeriodDays} days</strong>
                                        <span>Grace Period</span>
                                    </div>
                                </div>

                                <div className={styles.previewTags}>
                                    {form.sharedPlayerPool && <span>🔗 Shared Players</span>}
                                    {form.crossClubTournaments && <span>🏆 Cross-Club MTTs</span>}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Error */}
                {error && (
                    <div className={styles.error}>
                        ⚠️ {error}
                    </div>
                )}

                {/* Navigation */}
                <div className={styles.navigation}>
                    {step > 1 && (
                        <button className={styles.backBtn} onClick={handleBack}>
                            ← Previous
                        </button>
                    )}
                    <div className={styles.spacer} />
                    {step < totalSteps ? (
                        <button className={styles.nextBtn} onClick={handleNext}>
                            Next →
                        </button>
                    ) : (
                        <button
                            className={styles.createBtn}
                            onClick={handleCreate}
                            disabled={creating}
                        >
                            {creating ? 'Creating...' : '🌐 Create Union'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
