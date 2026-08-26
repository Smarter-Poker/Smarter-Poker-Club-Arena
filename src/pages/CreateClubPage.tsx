/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Create Club Page
 * Streamlined 2-step club creation flow (Basics → Preview)
 * Rake, table, and game settings are managed post-creation in Club Settings.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { MEDIA_BASE } from '../utils/mediaBase';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate } from 'react-router-dom';
import styles from './CreateClubPage.module.css';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import ClubPromotionRulesModal from '../components/modals/ClubPromotionRulesModal';
import { masterBus } from '../core/MasterBus';
import { sanitizeInput } from '../utils/sanitizeInput';
import { buildClubSlug, escapeIlikePattern } from '../utils/clubSlug';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const BASE = MEDIA_BASE;

interface ClubFormData {
  name: string;
  description: string;
  /** Either icon ID ('gold','green',...) or 'custom' for uploaded file */
  iconId: string;
  /** true = Public (open join), false = Private (requires approval) */
  isPublic: boolean;
}

// Default club icon options — compact fallback row
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
};

const ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// ═══════════════════════════════════════════════════════════════════════════════
// STEP COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface StepProps {
  form: ClubFormData;
  updateForm: (updates: Partial<ClubFormData>) => void;
  customLogoFile: File | null;
  customLogoPreview: string | null;
  onLogoFileChange: (file: File | null) => void;
  logoError: string | null;
}

const Step1Basics = ({
  form,
  updateForm,
  customLogoFile,
  customLogoPreview,
  onLogoFileChange,
  logoError,
}: StepProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [defaultsExpanded, setDefaultsExpanded] = useState(
    !customLogoFile && form.iconId !== 'custom'
  );
  const [dragOver, setDragOver] = useState(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLogoFileChange(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onLogoFileChange(file);
  };

  const handleRemoveLogo = () => {
    onLogoFileChange(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className={styles.stepContent}>
      <h2>Club Basics</h2>
      <p className={styles.stepDesc}>Give Your Club A Name, Pick A Logo, And Set Permissions.</p>

      <div className={styles.formGroup}>
        <label>Club Name *</label>
        <input
          type="text"
          className={styles.textInput}
          placeholder="Enter Club Name..."
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          maxLength={30}
        />
        <span className={styles.charCount}>{form.name.length}/30</span>
      </div>

      {/* ── UPLOAD LOGO (Primary) ── */}
      <div className={styles.formGroup}>
        <label>Club Logo</label>

        {customLogoPreview ? (
          /* ─── Uploaded Preview ─── */
          <div className={styles.uploadedPreview}>
            <img src={customLogoPreview} alt="Club logo preview" className={styles.uploadedImg} />
            <div className={styles.uploadedInfo}>
              <span className={styles.uploadedName}>{customLogoFile?.name || 'Custom Logo'}</span>
              <span className={styles.uploadedSize}>
                {customLogoFile ? `${(customLogoFile.size / 1024).toFixed(0)} KB` : ''}
              </span>
              <div className={styles.uploadedActions}>
                <button
                  type="button"
                  className={styles.changeBtn}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Change
                </button>
                <button type="button" className={styles.removeBtn} onClick={handleRemoveLogo}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ─── Drop Zone ─── */
          <div
            className={`${styles.dropZone} ${dragOver ? styles.dropZoneActive : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <div className={styles.dropIcon}>▣</div>
            <span className={styles.dropText}>
              <strong>Upload Your Club Logo</strong>
            </span>
            <span className={styles.dropHint}>
              Drag & Drop Or Click To Browse • JPG, PNG, GIF, WebP • Max 2MB
            </span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        {logoError && <span className={styles.logoError}>{logoError}</span>}

        {/* ── DEFAULT ICONS (Fallback Row) ── */}
        <div className={styles.defaultIconsSection}>
          <button
            type="button"
            className={styles.defaultsToggle}
            onClick={() => setDefaultsExpanded(!defaultsExpanded)}
          >
            <span>Or Choose A Default Icon</span>
            <span className={styles.toggleArrow}>{defaultsExpanded ? '▲' : '▼'}</span>
          </button>

          {defaultsExpanded && (
            <div className={styles.defaultIconsRow}>
              {CLUB_ICONS.map((icon) => (
                <button
                  key={icon.id}
                  type="button"
                  className={`${styles.defaultIcon} ${form.iconId === icon.id && !customLogoFile ? styles.defaultIconSelected : ''}`}
                  onClick={() => {
                    updateForm({ iconId: icon.id });
                    handleRemoveLogo();
                  }}
                  title={icon.name}
                >
                  <img src={icon.src} alt={icon.name} loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.formGroup}>
        <label>Description</label>
        <textarea
          className={styles.textArea}
          placeholder="Describe Your Club..."
          value={form.description}
          onChange={(e) => updateForm({ description: e.target.value })}
          rows={4}
          maxLength={500}
        />
        <span className={styles.charCount}>{form.description.length}/500</span>
      </div>

      {/* ── Club Visibility (Mutually Exclusive) ── */}
      <div className={styles.formGroup}>
        <label>Club Visibility</label>
        <div className={styles.checkboxGrid}>
          <label className={`${styles.checkbox} ${form.isPublic ? styles.checkboxActive : ''}`}>
            <input
              type="radio"
              name="visibility"
              checked={form.isPublic}
              onChange={() => updateForm({ isPublic: true })}
            />
            <span className={styles.checkmark} />
            <div>
              <strong>Public</strong>
              <p>Anyone Can Find And Join Your Club. Open Membership.</p>
            </div>
          </label>

          <label className={`${styles.checkbox} ${!form.isPublic ? styles.checkboxActive : ''}`}>
            <input
              type="radio"
              name="visibility"
              checked={!form.isPublic}
              onChange={() => updateForm({ isPublic: false })}
            />
            <span className={styles.checkmark} />
            <div>
              <strong>Private</strong>
              <p>Invite Only. New Members Require Admin Approval.</p>
            </div>
          </label>
        </div>
      </div>
    </div>
  );
};

interface Step2Props {
  form: ClubFormData;
  customLogoPreview: string | null;
  hasAgreed: boolean;
  setHasAgreed: (v: boolean) => void;
  onShowRules: () => void;
}

const Step2Preview = ({
  form,
  customLogoPreview,
  hasAgreed,
  setHasAgreed,
  onShowRules,
}: Step2Props) => {
  const icon = CLUB_ICONS.find((i) => i.id === form.iconId);
  const previewSrc = customLogoPreview || icon?.src || null;

  return (
    <div className={styles.stepContent}>
      <h2>Preview & Create</h2>
      <p className={styles.stepDesc}>Review Your Club Settings Before Creating.</p>

      <div className={styles.previewCard}>
        <div className={styles.previewHeader}>
          <div className={styles.previewAvatar}>
            {previewSrc ? (
              <img
                src={previewSrc}
                alt="Club logo"
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
            <p>{form.isPublic ? 'Public • Open Join' : 'Private • Approval Required'}</p>
          </div>
        </div>

        {form.description && <p className={styles.previewDesc}>{form.description}</p>}

        <div className={styles.previewTags}>
          <span>{form.isPublic ? 'Public' : 'Private'}</span>
          <span>{form.isPublic ? 'Open Join' : 'Approval Required'}</span>
        </div>
      </div>

      {/* Settings note */}
      <div className={styles.infoCard}>
        <span className={styles.infoIcon}>⚙</span>
        <div>
          <strong>Rake & Game Settings</strong>
          <p>
            Default Rake And Game Settings Are Applied Automatically. You Can Customize Rake %, Rake
            Cap, Table Rules, And Game Visibility Anytime From Your Club Settings After Creation.
          </p>
        </div>
      </div>

      {/* First-time bonus notice */}
      <div className={styles.bonusNotice}>
        <span className={styles.bonusIcon}>◈</span>
        <p>
          If This Is The First Club That You Are Creating You Will Receive A Bonus Of{' '}
          <strong>100,000 Club Chips</strong>. Congratulations!
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
            By Clicking "Create", You Confirm You Are 18+ Years Old, And That You Understand And
            Accept Our{' '}
            <button type="button" className={styles.rulesLink} onClick={onShowRules}>
              Club Promotion Rules
            </button>{' '}
            And Media Guidelines.
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

  // Logo upload state
  const [customLogoFile, setCustomLogoFile] = useState<File | null>(null);
  const [customLogoPreview, setCustomLogoPreview] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  const totalSteps = 2;

  // Section entrance animation
  useEffect(() => {
    setStepVisible(false);
    const timer = setTimeout(() => setStepVisible(true), 50);
    return () => clearTimeout(timer);
  }, [step]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (customLogoPreview && customLogoPreview.startsWith('blob:')) {
        URL.revokeObjectURL(customLogoPreview);
      }
    };
  }, [customLogoPreview]);

  const updateForm = (updates: Partial<ClubFormData>) => {
    setForm((prev) => ({ ...prev, ...updates }));
    setError(null);
  };

  const handleLogoFileChange = useCallback(
    (file: File | null) => {
      setLogoError(null);

      // Revoke old preview URL
      if (customLogoPreview && customLogoPreview.startsWith('blob:')) {
        URL.revokeObjectURL(customLogoPreview);
      }

      if (!file) {
        setCustomLogoFile(null);
        setCustomLogoPreview(null);
        return;
      }

      // Validate file type
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        setLogoError('Invalid file type. Please upload JPG, PNG, GIF, or WebP.');
        return;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        setLogoError('File too large. Maximum size is 2MB.');
        return;
      }

      setCustomLogoFile(file);
      setCustomLogoPreview(URL.createObjectURL(file));
      setForm((prev) => ({ ...prev, iconId: 'custom' }));
    },
    [customLogoPreview]
  );

  const validateStep = (): boolean => {
    switch (step) {
      case 1:
        if (!form.name.trim()) {
          setError('Club name is required');
          return false;
        }
        if (form.name.trim().length < 3) {
          setError('Club name must be at least 3 characters');
          return false;
        }
        if (form.name.trim().length > 30) {
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

    // ── Legal agreement guard (hardened — UI disables button, this is the failsafe) ──
    if (!hasAgreed) {
      setError('You must accept the Club Promotion Rules to create a club.');
      return;
    }

    // ── Auth guard ──
    if (!user?.id) {
      setError('You must be logged in to create a club.');
      return;
    }

    // ── Double-click protection ──
    if (creating) return;
    setCreating(true);
    setError(null);

    // ── 4-club membership limit (matches ClubsService enforcement) ──
    try {
      const { count, error: countError } = await supabase
        .from('club_members')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .in('status', ['active', 'approved']);

      // FAIL CLOSED. This read `if (!countError && ...)`, so a transient error
      // on the count skipped the guard entirely and let a fifth club through --
      // and nothing on the server re-checks it: both creation paths INSERT into
      // club_members directly rather than going through fn_join_club, whose own
      // limit check lives in the non-owner branch. The client guard is the only
      // limit there is on this path, so it cannot be the one that shrugs.
      if (countError) {
        reportError(countError, 'CreateClubPage.club_limit_check_failed');
        if (isMounted.current) {
          setError('We could not check how many clubs you are in. Please try again.');
          setCreating(false);
        }
        return;
      }
      if (count !== null && count >= 4) {
        if (isMounted.current) {
          setError('You can only be a member of up to 4 clubs. Leave a club to create a new one.');
          setCreating(false);
        }
        return;
      }
    } catch (e) {
      reportError(e, 'CreateClubPage');
      if (isMounted.current) {
        setError('We could not check how many clubs you are in. Please try again.');
        setCreating(false);
      }
      return;
    }

    // ── Check for duplicate club name ──
    try {
      const { data: existing } = await supabase
        .from('clubs')
        .select('id')
        .ilike('name', escapeIlikePattern(form.name.trim()))
        .limit(1);

      if (existing && existing.length > 0) {
        if (isMounted.current) {
          setError('A club with this name already exists. Please choose a different name.');
          setCreating(false);
        }
        return;
      }
    } catch (e) {
      reportError(e, 'CreateClubPage');
      // Non-blocking — proceed even if check fails
    }

    try {
      // Determine the logo value for insert.
      // IMPORTANT: consumers (carousel, club cards, getUserMemberships) read
      // logo_url / avatar_url — the bare `logo` column is legacy. Write all of
      // them so default-icon clubs actually render a logo.
      const selectedIcon = CLUB_ICONS.find((i) => i.id === form.iconId);
      const logoValue =
        form.iconId !== 'custom' && selectedIcon
          ? `images/club-icons/icon-${form.iconId}.png`
          : null;
      const logoUrlValue = form.iconId !== 'custom' && selectedIcon ? selectedIcon.src : null;

      // Insert club with collision retry for random club_id
      let data: any = null;
      let lastInsertError: any = null;
      const MAX_RETRIES = 3;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // 5-digit code (10000-99999) — canonical format. The Join modal and all
        // existing production clubs use 5-digit codes; 6-digit codes were a bug
        // that made new clubs unjoinable by code.
        const clubIdNumber = Math.floor(10000 + Math.random() * 90000);

        const { data: insertData, error: insertError } = await supabase
          .from('clubs')
          .insert({
            club_id: clubIdNumber,
            name: sanitizeInput(form.name.trim()),
            // clubs.slug is UNIQUE — retries append the club_id (see utils/clubSlug)
            slug: buildClubSlug(form.name, clubIdNumber, attempt),
            description: sanitizeInput(form.description.trim()) || null,
            owner_id: user.id,
            is_public: form.isPublic,
            requires_approval: !form.isPublic,
            logo: logoValue,
            logo_url: logoUrlValue,
            avatar_url: logoUrlValue,
            member_count: 1,
            level: 1,
            settings: {
              icon_id: form.iconId,
              default_rake_percent: 5,
              rake_cap: 3,
            },
          })
          .select()
          .maybeSingle();

        if (!insertError && insertData) {
          data = insertData;
          break;
        }

        lastInsertError = insertError;
        // Name uniqueness (idx_clubs_name_lower) can never be fixed by a
        // retry — the name doesn't change between attempts. Bail with the
        // friendly message immediately.
        if (insertError?.message?.includes('idx_clubs_name_lower')) {
          throw new Error('A club with this name already exists. Please choose a different name.');
        }
        // If not a unique constraint error, don't retry
        if (
          insertError &&
          !insertError.message?.includes('duplicate') &&
          !insertError.message?.includes('unique')
        ) {
          throw insertError;
        }
      }

      if (!data) throw lastInsertError || new Error('Club creation failed after retries');

      // Add owner as first member — if this fails, delete the orphaned club
      const { error: memberError } = await supabase.from('club_members').insert({
        club_id: data.id,
        user_id: user.id,
        role: 'owner',
        status: 'active',
      });

      if (memberError) {
        reportError(memberError, 'CreateClubPage.Owner_membership_failed_cleaning_up_orph');
        await supabase.from('clubs').delete().eq('id', data.id);
        throw new Error('Failed to set up club ownership. Please try again.');
      }

      // ── Upload custom logo if provided (post-creation, after we have club UUID) ──
      if (customLogoFile && form.iconId === 'custom') {
        try {
          const fileExt = customLogoFile.name.split('.').pop() || 'png';
          // MUST start with `club-logos/`. The only INSERT policies that admit
          // bucket_id = 'club-assets' are `club logos authenticated insert`
          // (name LIKE 'club-logos/%') and `club cards authenticated insert`
          // (name LIKE 'club-cards/%'); the generic allowlist policy does not
          // include this bucket at all. A path of `<club-uuid>/logo-...` matched
          // neither, so every custom logo upload from this page was refused by
          // RLS -- and the failure is non-fatal below, so the club was created
          // with logo, logo_url and avatar_url all NULL and the user was never
          // told. CreateClubModal has always used the correct prefix.
          const fileName = `club-logos/${data.id}-${Date.now()}.${fileExt}`;

          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('club-assets')
            .upload(fileName, customLogoFile, {
              cacheControl: '3600',
              upsert: true,
            });

          if (uploadError) {
            reportError(uploadError, 'CreateClubPage.Logo_upload_failed_nonfatal');
          } else if (uploadData) {
            const { data: urlData } = supabase.storage
              .from('club-assets')
              .getPublicUrl(uploadData.path);

            if (urlData?.publicUrl) {
              // Save logo URL to club record — logo_url included so the
              // baked-card backfill (which keys off logo_url) can run
              await supabase
                .from('clubs')
                .update({
                  avatar_url: urlData.publicUrl,
                  logo: urlData.publicUrl,
                  logo_url: urlData.publicUrl,
                })
                .eq('id', data.id);
            }
          }
        } catch (uploadErr) {
          // Non-fatal — club is created, logo can be re-uploaded later
          reportError(uploadErr, 'CreateClubPage.Logo_upload_error_nonfatal');
        }
      }

      if (user?.id) {
        masterBus.emit('CLUB_JOINED', { clubId: data.id, action: 'club_created' });
      }

      navigate(`/clubs/${data.id}`);
    } catch (err: any) {
      reportError(err, 'CreateClubPage.Failed_to_create_club');
      if (isMounted.current) setError(safeErrorMessage(err, 'Failed to create club'));
    } finally {
      if (isMounted.current) setCreating(false);
    }
  };

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <Step1Basics
            form={form}
            updateForm={updateForm}
            customLogoFile={customLogoFile}
            customLogoPreview={customLogoPreview}
            onLogoFileChange={handleLogoFileChange}
            logoError={logoError}
          />
        );
      case 2:
        return (
          <Step2Preview
            form={form}
            customLogoPreview={customLogoPreview}
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
        <div className={styles.header}>
          <h1>Create Your Club</h1>
        </div>

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
