/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Create Union Page
 * Multi-club network creation wizard
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './CreateUnionPage.module.css';
import { supabase } from '../lib/supabase';
import { unionApi } from '../services/UnionApiService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { sanitizeInput } from '../utils/sanitizeInput';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
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
  const { user } = useAuthUser();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<UnionFormData>(DEFAULT_FORM);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingClubs, setCheckingClubs] = useState(true);
  const [ownsClub, setOwnsClub] = useState(false);
  const [stepVisible, setStepVisible] = useState(false);

  const totalSteps = 3;

  // Section entrance animation
  useEffect(() => {
    setStepVisible(false);
    const timer = setTimeout(() => setStepVisible(true), 50);
    return () => clearTimeout(timer);
  }, [step]);

  // Check if user owns any clubs (required to create union)
  useEffect(() => {
    let isMounted = true;
    const checkClubOwnership = async () => {
      try {
        const { count } = await supabase
          .from('clubs')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', user?.id);

        if (isMounted) setOwnsClub((count || 0) > 0);
      } catch (e) {
        reportError(e, 'CreateUnionPage.Failed_to_check_club_ownership');
        if (isMounted) {
          toast.error('Failed to verify club ownership');
          setOwnsClub(false);
        }
      } finally {
        if (isMounted) setCheckingClubs(false);
      }
    };

    checkClubOwnership();
    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  // Show "create club first" message if user doesn't own a club
  if (!checkingClubs && !ownsClub) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.noClubMessage}>
            <span className={styles.noClubIcon}></span>
            <h2>Create A Club First</h2>
            <p>You Need To Own At Least One Club Before You Can Create A Union.</p>
            <button className={styles.createClubBtn} onClick={() => navigate('/?create=club')}>
              Create Your First Club
            </button>
          </div>
        </div>
      </div>
    );
  }

  const updateForm = (updates: Partial<UnionFormData>) => {
    setForm((prev) => ({ ...prev, ...updates }));
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
      // UNION AUDIT FIX 2026-07-21: unions is service-role-write-only under RLS,
      // so the old direct insert silently failed for browser users. Create via
      // the World Hub manage-union API (server-side sanitization + admin/wallet/
      // BBJ-pool provisioning; creator identity comes from the bearer token).
      const result = await unionApi.createUnion(
        sanitizeInput(form.name.trim()),
        form.description.trim() ? sanitizeInput(form.description.trim()) : '',
        {
          revenue_share_percent: form.revenueSharePercent,
          shared_player_pool: form.sharedPlayerPool,
          cross_club_tournaments: form.crossClubTournaments,
          settlement_day: form.settlementDay,
          grace_period_days: form.gracePeriodDays,
        }
      );
      const data = result.union as { id: string; slug?: string } | undefined;
      if (!data) throw new Error('Union creation returned no data');

      masterBus.emit('UNION_UPDATED', { unionId: data.id });
      navigate(`/unions/${data.slug || data.id}`);
    } catch (err: any) {
      reportError(err, 'CreateUnionPage.Failed_to_create_union');
      setError(safeErrorMessage(err, 'Failed to create union'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <CasinoSurfaceHeader
          crest="club"
          eyebrow="Union Network / Creation"
          title="Forge A Union"
          description="Configure A Governed Club Network, Revenue Rules, And Shared Features Through The Existing Server-Authorized Creation Workflow."
          artPath="assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp"
          status="UNION FORGE // SECURE"
          metrics={[
            { label: 'Step', value: `${step} / ${totalSteps}`, tone: 'attention' },
            { label: 'Club Authority', value: ownsClub ? 'Verified' : 'Checking', tone: 'live' },
            { label: 'Visibility', value: form.isPublic ? 'Public' : 'Private' },
          ]}
        />

        {/* Progress */}
        <div className={styles.progress}>
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`${styles.progressStep} ${s === step ? styles.active : ''} ${s < step ? styles.completed : ''}`}
            >
              <span className={styles.progressDot}>{s < step ? '' : s}</span>
              <span className={styles.progressLabel}>
                {s === 1 && 'Basics'}
                {s === 2 && 'Revenue'}
                {s === 3 && 'Review'}
              </span>
            </div>
          ))}
          <div className={styles.progressLine}>
            <div
              className={styles.progressFill}
              style={{ width: `${((step - 1) / (totalSteps - 1)) * 100}%` }}
            />
          </div>
        </div>

        {/* Step Content */}
        <div
          className={styles.stepContainer}
          style={{
            opacity: stepVisible ? 1 : 0,
            transform: stepVisible ? 'translateY(0)' : 'translateY(12px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          {step === 1 && (
            <div className={styles.stepContent}>
              <h2> Union Basics</h2>
              <p className={styles.stepDesc}>Create A Network Of Clubs With Shared Resources.</p>

              <div className={styles.formGroup}>
                <label>Union Name *</label>
                <input
                  type="text"
                  className={styles.textInput}
                  placeholder="Enter Union Name..."
                  value={form.name}
                  onChange={(e) => updateForm({ name: e.target.value })}
                  maxLength={50}
                />
              </div>

              <div className={styles.formGroup}>
                <label>Description</label>
                <textarea
                  className={styles.textArea}
                  placeholder="Describe Your Union..."
                  value={form.description}
                  onChange={(e) => updateForm({ description: e.target.value })}
                  rows={4}
                  maxLength={500}
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
                  <p>Other Clubs Can Discover And Request To Join</p>
                </div>
              </label>
            </div>
          )}

          {step === 2 && (
            <div className={styles.stepContent}>
              <h2> Revenue & Features</h2>
              <p className={styles.stepDesc}>Configure Profit Sharing And Shared Features.</p>

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
                  <span className={styles.hint}>% Of Club Rake To Union</span>
                </div>

                <div className={styles.formGroup}>
                  <label>Settlement Day</label>
                  <select
                    className={styles.select}
                    value={form.settlementDay}
                    onChange={(e) =>
                      updateForm({
                        settlementDay: e.target.value as UnionFormData['settlementDay'],
                      })
                    }
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
                    <span>Days</span>
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
                    <p>Players Can Move Between Clubs In The Union</p>
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
                    <p>Host Tournaments Across All Member Clubs</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className={styles.stepContent}>
              <h2> Review & Create</h2>
              <p className={styles.stepDesc}>Review Your Union Settings Before Creating.</p>

              <div className={styles.previewCard}>
                <div className={styles.previewHeader}>
                  <div className={styles.previewAvatar}>
                    {form.name.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div>
                    <h3>{form.name || 'Unnamed Union'}</h3>
                    <p>{form.isPublic ? ' Public Union' : ' Private Union'}</p>
                  </div>
                </div>

                {form.description && <p className={styles.previewDesc}>{form.description}</p>}

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
                    <strong>{form.gracePeriodDays} Days</strong>
                    <span>Grace Period</span>
                  </div>
                </div>

                <div className={styles.previewTags}>
                  {form.sharedPlayerPool && <span> Shared Players</span>}
                  {form.crossClubTournaments && <span> Cross-Club MTTs</span>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && <div className={styles.error}>{error}</div>}

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
            <button className={styles.createBtn} onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : ' Create Union'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
