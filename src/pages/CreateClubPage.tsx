/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Create Club Page
 * Streamlined 2-step club creation flow (Basics → Preview)
 * Rake, table, and game settings are managed post-creation in Club Settings.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate } from 'react-router-dom';
import styles from './CreateClubPage.module.css';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import ClubPromotionRulesModal from '../components/modals/ClubPromotionRulesModal';
import { masterBus } from '../core/MasterBus';
import { sanitizeInput } from '../utils/sanitizeInput';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

const BASE = import.meta.env.BASE_URL;

interface ClubFormData {
  name: string;
  description: string;
  iconId: string;
  isPublic: boolean;
  requiresApproval: boolean;
  gpsRestricted: boolean;
}

// Club icon options — premium generated images
const CLUB_ICONS = [
  { id: 'gold', name: 'Royal Gold', src: `${BASE}images/club-icons/icon-gold.png` },
  { id: 'green', name: 'Neon Spade', src: `${BASE}images/club-icons/icon-green.png` },
  { id: 'ice', name: 'Ice Crystal', src: `${BASE}images/club-icons/icon-ice.png` },
  { id: 'cyber', name: 'Cyber Blue', src: `${BASE}images/club-icons/icon-cyber.png` },
  { id: 'heart', name: 'Heart Ruby', src: `${BASE}images/club-icons/icon-heart.png` },
  { id: 'vintage', name: 'Classic', src: `${BASE}images/club-icons/icon-vintage.png` },
];

const DEFAULT_FORM: ClubFormData = {
  name: '',
  description: '',
  iconId: 'gold',
  isPublic: true,
  requiresApproval: true,
  gpsRestricted: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STEP COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface StepProps {
  form: ClubFormData;
  updateForm: (updates: Partial<ClubFormData>) => void;
}

const Step1Basics = ({ form, updateForm }: StepProps) => (
  <div className={styles.stepContent}>
    <h2>Club Basics</h2>
    <p className={styles.stepDesc}>Give your club a name, pick an icon, and set permissions.</p>

    <div className={styles.formGroup}>
      <label>Club Name *</label>
      <input
        type="text"
        className={styles.textInput}
        placeholder="Enter club name..."
        value={form.name}
        onChange={(e) => updateForm({ name: e.target.value })}
        maxLength={50}
      />
      <span className={styles.charCount}>{form.name.length}/50</span>
    </div>

    <div className={styles.formGroup}>
      <label>Select Club Icon</label>
      <div className={styles.iconGrid}>
        {CLUB_ICONS.map((icon) => (
          <button
            key={icon.id}
            type="button"
            className={`${styles.iconOption} ${form.iconId === icon.id ? styles.selected : ''}`}
            onClick={() => updateForm({ iconId: icon.id })}
            title={icon.name}
          >
            <img
              src={icon.src}
              alt={icon.name}
              className={styles.iconImg}
              loading="lazy"
              decoding="async"
            />
            <span className={styles.iconLabel}>{icon.name}</span>
          </button>
        ))}
      </div>
    </div>

    <div className={styles.formGroup}>
      <label>Description</label>
      <textarea
        className={styles.textArea}
        placeholder="Describe your club..."
        value={form.description}
        onChange={(e) => updateForm({ description: e.target.value })}
        rows={4}
        maxLength={500}
      />
      <span className={styles.charCount}>{form.description.length}/500</span>
    </div>

    <div className={styles.checkboxGrid}>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={form.isPublic}
          onChange={(e) => updateForm({ isPublic: e.target.checked })}
        />
        <span className={styles.checkmark} />
        <div>
          <strong>Public Club</strong>
          <p>Anyone can find and request to join</p>
        </div>
      </label>

      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={form.requiresApproval}
          onChange={(e) => updateForm({ requiresApproval: e.target.checked })}
        />
        <span className={styles.checkmark} />
        <div>
          <strong>Require Approval</strong>
          <p>New members need admin approval</p>
        </div>
      </label>

      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={form.gpsRestricted}
          onChange={(e) => updateForm({ gpsRestricted: e.target.checked })}
        />
        <span className={styles.checkmark} />
        <div>
          <strong>GPS Restricted</strong>
          <p>Only allow play from certain locations</p>
        </div>
      </label>
    </div>
  </div>
);

interface Step2Props {
  form: ClubFormData;
  hasAgreed: boolean;
  setHasAgreed: (v: boolean) => void;
  onShowRules: () => void;
}

const Step2Preview = ({ form, hasAgreed, setHasAgreed, onShowRules }: Step2Props) => {
  const icon = CLUB_ICONS.find((i) => i.id === form.iconId);
  return (
    <div className={styles.stepContent}>
      <h2>Preview & Create</h2>
      <p className={styles.stepDesc}>Review your club settings before creating.</p>

      <div className={styles.previewCard}>
        <div className={styles.previewHeader}>
          <div className={styles.previewAvatar}>
            {icon ? (
              <img
                src={icon.src}
                alt={icon.name}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  borderRadius: '0.75rem',
                }}
              />
            ) : (
              form.name.charAt(0).toUpperCase() || '?'
            )}
          </div>
          <div>
            <h3>{form.name || 'Unnamed Club'}</h3>
            <p>
              {form.isPublic ? 'Public' : 'Private'} •{' '}
              {form.requiresApproval ? 'Approval Required' : 'Open Join'}
            </p>
          </div>
        </div>

        {form.description && <p className={styles.previewDesc}>{form.description}</p>}

        <div className={styles.previewTags}>
          {form.isPublic && <span>Public</span>}
          {form.requiresApproval && <span>Approval Required</span>}
          {form.gpsRestricted && <span>GPS Restricted</span>}
        </div>
      </div>

      {/* Settings note */}
      <div className={styles.infoCard}>
        <span className={styles.infoIcon}>⚙️</span>
        <div>
          <strong>Rake & Game Settings</strong>
          <p>
            Default rake and game settings are applied automatically. You can customize rake %, rake
            cap, table rules, and game visibility anytime from your Club Settings after creation.
          </p>
        </div>
      </div>

      {/* First-time bonus notice */}
      <div className={styles.bonusNotice}>
        <span className={styles.bonusIcon}>🎁</span>
        <p>
          If this is the first club that you are creating you will receive a bonus of{' '}
          <strong>10,000 club chips</strong>. Congratulations!
        </p>
      </div>

      {/* Legal Agreement */}
      <div className={styles.legalSection}>
        <label className={styles.legalCheckbox}>
          <input
            type="checkbox"
            checked={hasAgreed}
            onChange={(e) => setHasAgreed(e.target.checked)}
          />
          <span className={styles.checkmark} />
          <span>
            By clicking "Create", you confirm you are 18+ years old, and that you understand and
            accept our{' '}
            <button type="button" className={styles.rulesLink} onClick={onShowRules}>
              Club Promotion Rules
            </button>{' '}
            and Media Guidelines.
          </span>
        </label>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function CreateClubPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const isMounted = useIsMounted();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<ClubFormData>(DEFAULT_FORM);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAgreed, setHasAgreed] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [stepVisible, setStepVisible] = useState(false);

  const totalSteps = 2;

  // Section entrance animation
  useEffect(() => {
    setStepVisible(false);
    const timer = setTimeout(() => setStepVisible(true), 50);
    return () => clearTimeout(timer);
  }, [step]);

  const updateForm = (updates: Partial<ClubFormData>) => {
    setForm((prev) => ({ ...prev, ...updates }));
    setError(null);
  };

  const validateStep = (): boolean => {
    switch (step) {
      case 1:
        if (!form.name.trim()) {
          setError('Club name is required');
          return false;
        }
        if (form.name.length < 3) {
          setError('Club name must be at least 3 characters');
          return false;
        }
        if (form.name.length > 30) {
          setError('Club name must be 30 characters or less');
          return false;
        }
        break;
    }
    return true;
  };

  const handleNext = () => {
    if (!validateStep()) return;
    if (step < totalSteps) {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const handleCreate = async () => {
    if (!validateStep()) return;

    setCreating(true);
    setError(null);

    // Check for duplicate club name
    try {
      const { data: existing } = await supabase
        .from('clubs')
        .select('id')
        .ilike('name', form.name.trim())
        .limit(1);

      if (existing && existing.length > 0) {
        if (isMounted.current) {
          setError('A club with this name already exists. Please choose a different name.');
          if (isMounted.current) setCreating(false);
        }
        return;
      }
    } catch {
      // Non-blocking — proceed even if check fails
    }

    try {
      // Generate 6-digit club ID
      const clubIdNumber = Math.floor(100000 + Math.random() * 900000);

      // Find the selected icon to store its src path
      const selectedIcon = CLUB_ICONS.find((i) => i.id === form.iconId);

      const { data, error: insertError } = await supabase
        .from('clubs')
        .insert({
          club_id: clubIdNumber,
          name: sanitizeInput(form.name.trim()),
          description: sanitizeInput(form.description.trim()) || null,
          owner_id: user?.id,
          is_public: form.isPublic,
          requires_approval: form.requiresApproval,
          gps_restricted: form.gpsRestricted,
          logo: selectedIcon ? `images/club-icons/icon-${form.iconId}.png` : null,
          settings: {
            icon_id: form.iconId,
            default_rake_percent: 5,
            rake_cap: 3,
          },
        })
        .select()
        .maybeSingle();

      if (insertError) throw insertError;
      if (!data) throw new Error('Club creation returned no data');

      // Add owner as first member — if this fails, delete the orphaned club
      const { error: memberError } = await supabase.from('club_members').insert({
        club_id: data.id,
        user_id: user?.id,
        role: 'owner',
        status: 'active',
      });

      if (memberError) {
        console.error(
          '[CreateClub] Owner membership failed, cleaning up orphaned club:',
          memberError
        );
        await supabase.from('clubs').delete().eq('id', data.id);
        throw new Error('Failed to set up club ownership. Please try again.');
      }

      if (user?.id) {
        masterBus.emit('CLUB_JOINED', { clubId: data.id });
      }

      navigate(`/clubs/${data.id}`);
    } catch (err: any) {
      console.error('Failed to create club:', err);
      if (isMounted.current) setError(err.message || 'Failed to create club');
    } finally {
      if (isMounted.current) setCreating(false);
    }
  };

  const renderStep = () => {
    const props = { form, updateForm };
    switch (step) {
      case 1:
        return <Step1Basics {...props} />;
      case 2:
        return (
          <Step2Preview
            form={form}
            hasAgreed={hasAgreed}
            setHasAgreed={setHasAgreed}
            onShowRules={() => setShowRulesModal(true)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* Header */}
        <header className={styles.header}>
          <h1>Create Your Club</h1>
        </header>

        {/* Progress */}
        <div className={styles.progress}>
          {[1, 2].map((s) => (
            <div
              key={s}
              className={`${styles.progressStep} ${s === step ? styles.active : ''} ${s < step ? styles.completed : ''}`}
            >
              <span className={styles.progressDot}>{s < step ? '✓' : s}</span>
              <span className={styles.progressLabel}>
                {s === 1 && 'Basics'}
                {s === 2 && 'Review'}
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
          {renderStep()}
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
            <button
              className={styles.createBtn}
              onClick={handleCreate}
              disabled={creating || !hasAgreed}
            >
              {creating ? 'Creating...' : 'Create Club'}
            </button>
          )}
        </div>
      </div>

      {/* Club Promotion Rules Modal */}
      <ClubPromotionRulesModal
        isOpen={showRulesModal}
        onClose={() => setShowRulesModal(false)}
        onAccept={() => {
          setHasAgreed(true);
          setShowRulesModal(false);
        }}
      />
    </div>
  );
}
