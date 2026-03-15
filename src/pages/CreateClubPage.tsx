/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Create Club Page
 * Complete club creation flow with settings and preview
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate } from 'react-router-dom';
import styles from './CreateClubPage.module.css';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import ClubPromotionRulesModal from '../components/modals/ClubPromotionRulesModal';
import { ClubService } from '../services/ClubService';
import { masterBus } from '../core/MasterBus';
import { sanitizeInput } from '../utils/sanitizeInput';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ClubFormData {
  name: string;
  description: string;
  iconId: string;
  isPublic: boolean;
  requiresApproval: boolean;
  gpsRestricted: boolean;

  // Rake settings
  defaultRakePercent: number;
  rakeCap: number;

  // Table defaults
  minBuyInBB: number;
  maxBuyInBB: number;
  timeBankSeconds: number;
  allowStraddle: boolean;
  allowRunItTwice: boolean;

  // Games offered
  offerCash: boolean;
  offerTournaments: boolean;
  offerSNG: boolean;

  // Game variants
  variants: string[];
}

// Club icon options
const CLUB_ICONS = [
  { id: 'eagle', emoji: '', name: 'Eagle' },
  { id: 'dragon', emoji: '', name: 'Dragon' },
  { id: 'shark', emoji: '', name: 'Shark' },
  { id: 'lion', emoji: '', name: 'Lion' },
  { id: 'phoenix', emoji: '', name: 'Phoenix' },
  { id: 'diamond', emoji: '', name: 'Diamond' },
  { id: 'crown', emoji: '', name: 'Crown' },
  { id: 'ace', emoji: '🂡', name: 'Ace' },
];

const DEFAULT_FORM: ClubFormData = {
  name: '',
  description: '',
  iconId: 'eagle',
  isPublic: true,
  requiresApproval: true,
  gpsRestricted: false,

  defaultRakePercent: 5,
  rakeCap: 3,

  minBuyInBB: 40,
  maxBuyInBB: 200,
  timeBankSeconds: 30,
  allowStraddle: true,
  allowRunItTwice: true,

  offerCash: true,
  offerTournaments: true,
  offerSNG: true,

  variants: ['nlh'],
};

const GAME_VARIANTS = [
  { id: 'nlh', name: "No Limit Hold'em", icon: '' },
  { id: 'plo4', name: 'Pot Limit Omaha', icon: '' },
  { id: 'plo5', name: 'PLO 5 Card', icon: '' },
  { id: 'plo6', name: 'PLO 6 Card', icon: '' },
  { id: 'short_deck', name: 'Short Deck', icon: '' },
  { id: 'ofc', name: 'Open Face Chinese', icon: '' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// STEP COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface StepProps {
  form: ClubFormData;
  updateForm: (updates: Partial<ClubFormData>) => void;
}

const Step1Basics = ({ form, updateForm }: StepProps) => (
  <div className={styles.stepContent}>
    <h2> Club Basics</h2>
    <p className={styles.stepDesc}>Give your club a name and description.</p>

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
      <label>Select Icon</label>
      <div className={styles.iconGrid}>
        {CLUB_ICONS.map((icon) => (
          <button
            key={icon.id}
            type="button"
            className={`${styles.iconOption} ${form.iconId === icon.id ? styles.selected : ''}`}
            onClick={() => updateForm({ iconId: icon.id })}
          >
            <span className={styles.iconEmoji}>{icon.emoji}</span>
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

const Step2Rake = ({ form, updateForm }: StepProps) => (
  <div className={styles.stepContent}>
    <h2> Rake Settings</h2>
    <p className={styles.stepDesc}>Configure your club's rake structure.</p>

    <div className={styles.settingsGrid}>
      <div className={styles.formGroup}>
        <label>Default Rake %</label>
        <div className={styles.inputWithUnit}>
          <input
            type="number"
            className={styles.numberInput}
            value={form.defaultRakePercent}
            onChange={(e) => updateForm({ defaultRakePercent: Number(e.target.value) })}
            min={0}
            max={10}
            step={0.5}
          />
          <span>%</span>
        </div>
        <span className={styles.hint}>Standard: 2-5%</span>
      </div>

      <div className={styles.formGroup}>
        <label>Rake Cap (BB)</label>
        <div className={styles.inputWithUnit}>
          <input
            type="number"
            className={styles.numberInput}
            value={form.rakeCap}
            onChange={(e) => updateForm({ rakeCap: Number(e.target.value) })}
            min={0}
            max={10}
            step={0.5}
          />
          <span>BB</span>
        </div>
        <span className={styles.hint}>Maximum rake per pot</span>
      </div>
    </div>

    <div className={styles.infoCard}>
      <span className={styles.infoIcon}></span>
      <div>
        <strong>No Flop, No Drop</strong>
        <p>
          Rake is only taken when a flop is seen. This is industry standard and automatically
          applied.
        </p>
      </div>
    </div>
  </div>
);

const Step3Tables = ({ form, updateForm }: StepProps) => (
  <div className={styles.stepContent}>
    <h2> Table Defaults</h2>
    <p className={styles.stepDesc}>Set default rules for tables in your club.</p>

    <div className={styles.settingsGrid}>
      <div className={styles.formGroup}>
        <label>Min Buy-in</label>
        <div className={styles.inputWithUnit}>
          <input
            type="number"
            className={styles.numberInput}
            value={form.minBuyInBB}
            onChange={(e) => updateForm({ minBuyInBB: Number(e.target.value) })}
            min={20}
            max={100}
          />
          <span>BB</span>
        </div>
      </div>

      <div className={styles.formGroup}>
        <label>Max Buy-in</label>
        <div className={styles.inputWithUnit}>
          <input
            type="number"
            className={styles.numberInput}
            value={form.maxBuyInBB}
            onChange={(e) => updateForm({ maxBuyInBB: Number(e.target.value) })}
            min={50}
            max={500}
          />
          <span>BB</span>
        </div>
      </div>

      <div className={styles.formGroup}>
        <label>Time Bank</label>
        <div className={styles.inputWithUnit}>
          <input
            type="number"
            className={styles.numberInput}
            value={form.timeBankSeconds}
            onChange={(e) => updateForm({ timeBankSeconds: Number(e.target.value) })}
            min={10}
            max={60}
          />
          <span>sec</span>
        </div>
      </div>
    </div>

    <div className={styles.toggleGrid}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={form.allowStraddle}
          onChange={(e) => updateForm({ allowStraddle: e.target.checked })}
        />
        <span className={styles.toggleSlider} />
        <span>Allow Straddle</span>
      </label>

      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={form.allowRunItTwice}
          onChange={(e) => updateForm({ allowRunItTwice: e.target.checked })}
        />
        <span className={styles.toggleSlider} />
        <span>Allow Run It Twice</span>
      </label>
    </div>
  </div>
);

const Step4Games = ({ form, updateForm }: StepProps) => (
  <div className={styles.stepContent}>
    <h2> Games Offered</h2>
    <p className={styles.stepDesc}>Choose what games your club will offer.</p>

    <div className={styles.gameTypes}>
      <label className={`${styles.gameTypeCard} ${form.offerCash ? styles.selected : ''}`}>
        <input
          type="checkbox"
          checked={form.offerCash}
          onChange={(e) => updateForm({ offerCash: e.target.checked })}
        />
        <span className={styles.gameTypeIcon}></span>
        <strong>Cash Games</strong>
        <p>Ring games with real chip value</p>
      </label>

      <label className={`${styles.gameTypeCard} ${form.offerTournaments ? styles.selected : ''}`}>
        <input
          type="checkbox"
          checked={form.offerTournaments}
          onChange={(e) => updateForm({ offerTournaments: e.target.checked })}
        />
        <span className={styles.gameTypeIcon}></span>
        <strong>Tournaments</strong>
        <p>MTTs, bounties, and special events</p>
      </label>

      <label className={`${styles.gameTypeCard} ${form.offerSNG ? styles.selected : ''}`}>
        <input
          type="checkbox"
          checked={form.offerSNG}
          onChange={(e) => updateForm({ offerSNG: e.target.checked })}
        />
        <span className={styles.gameTypeIcon}></span>
        <strong>Sit & Go / Spins</strong>
        <p>Quick tournaments and jackpot SNGs</p>
      </label>
    </div>

    <h3 className={styles.subheading}>Game Variants</h3>
    <div className={styles.variantsGrid}>
      {GAME_VARIANTS.map((variant) => (
        <label
          key={variant.id}
          className={`${styles.variantCard} ${form.variants.includes(variant.id) ? styles.selected : ''}`}
        >
          <input
            type="checkbox"
            checked={form.variants.includes(variant.id)}
            onChange={(e) => {
              if (e.target.checked) {
                updateForm({ variants: [...form.variants, variant.id] });
              } else {
                updateForm({ variants: form.variants.filter((v) => v !== variant.id) });
              }
            }}
          />
          <span className={styles.variantIcon}>{variant.icon}</span>
          <span>{variant.name}</span>
        </label>
      ))}
    </div>
  </div>
);

interface Step5Props {
  form: ClubFormData;
  hasAgreed: boolean;
  setHasAgreed: (v: boolean) => void;
  onShowRules: () => void;
}

const Step5Preview = ({ form, hasAgreed, setHasAgreed, onShowRules }: Step5Props) => {
  const icon = CLUB_ICONS.find((i) => i.id === form.iconId);
  return (
    <div className={styles.stepContent}>
      <h2> Preview & Create</h2>
      <p className={styles.stepDesc}>Review your club settings before creating.</p>

      <div className={styles.previewCard}>
        <div className={styles.previewHeader}>
          <div className={styles.previewAvatar}>
            {icon?.emoji || form.name.charAt(0).toUpperCase() || '?'}
          </div>
          <div>
            <h3>{form.name || 'Unnamed Club'}</h3>
            <p>
              {form.isPublic ? ' Public' : ' Private'} •{' '}
              {form.requiresApproval ? 'Approval Required' : 'Open Join'}
            </p>
          </div>
        </div>

        {form.description && <p className={styles.previewDesc}>{form.description}</p>}

        <div className={styles.previewStats}>
          <div>
            <strong>{form.defaultRakePercent}%</strong>
            <span>Rake</span>
          </div>
          <div>
            <strong>{form.rakeCap} BB</strong>
            <span>Cap</span>
          </div>
          <div>
            <strong>
              {form.minBuyInBB}-{form.maxBuyInBB}
            </strong>
            <span>Buy-in (BB)</span>
          </div>
          <div>
            <strong>{form.timeBankSeconds}s</strong>
            <span>Time Bank</span>
          </div>
        </div>

        <div className={styles.previewTags}>
          {form.offerCash && <span> Cash</span>}
          {form.offerTournaments && <span> MTTs</span>}
          {form.offerSNG && <span> SNGs</span>}
          {form.allowStraddle && <span>Straddle </span>}
          {form.allowRunItTwice && <span>RIT </span>}
        </div>

        <div className={styles.previewVariants}>
          <strong>Variants:</strong>
          {form.variants.map((v) => {
            const variant = GAME_VARIANTS.find((gv) => gv.id === v);
            return (
              <span key={v}>
                {variant?.icon} {variant?.name}
              </span>
            );
          })}
        </div>
      </div>

      {/* First-time bonus notice */}
      <div className={styles.bonusNotice}>
        <span className={styles.bonusIcon}></span>
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

  const totalSteps = 5;

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

  const [nameChecking, setNameChecking] = useState(false);

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
      case 4:
        if (!form.offerCash && !form.offerTournaments && !form.offerSNG) {
          setError('Select at least one game type');
          return false;
        }
        if (form.variants.length === 0) {
          setError('Select at least one game variant');
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
          setCreating(false);
        }
        return;
      }
    } catch {
      // Non-blocking — proceed even if check fails
    }

    try {
      // Generate 6-digit club ID
      const clubIdNumber = Math.floor(100000 + Math.random() * 900000);

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
          settings: {
            default_rake_percent: form.defaultRakePercent,
            rake_cap: form.rakeCap,
            min_buy_in_bb: form.minBuyInBB,
            max_buy_in_bb: form.maxBuyInBB,
            time_bank_seconds: form.timeBankSeconds,
            allow_straddle: form.allowStraddle,
            allow_run_it_twice: form.allowRunItTwice,
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
        return <Step2Rake {...props} />;
      case 3:
        return <Step3Tables {...props} />;
      case 4:
        return <Step4Games {...props} />;
      case 5:
        return (
          <Step5Preview
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
          <button className={styles.backButton} onClick={() => navigate('/clubs')}>
            ← Back
          </button>
          <h1>Create Your Club</h1>
        </header>

        {/* Progress */}
        <div className={styles.progress}>
          {[1, 2, 3, 4, 5].map((s) => (
            <div
              key={s}
              className={`${styles.progressStep} ${s === step ? styles.active : ''} ${s < step ? styles.completed : ''}`}
            >
              <span className={styles.progressDot}>{s < step ? '' : s}</span>
              <span className={styles.progressLabel}>
                {s === 1 && 'Basics'}
                {s === 2 && 'Rake'}
                {s === 3 && 'Tables'}
                {s === 4 && 'Games'}
                {s === 5 && 'Review'}
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
              {creating ? 'Creating...' : ' Create Club'}
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
