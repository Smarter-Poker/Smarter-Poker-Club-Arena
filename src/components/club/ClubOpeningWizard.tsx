import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { requiredSeedForStake, SPIN_BOARD_STAKES } from '../../services/SpinActivationService';
import {
  clubOpeningSetupService,
  isDefinitiveOpeningSetupRefusal,
  openingLeaderboardBudgetSplitsEvenly,
  openingLeaderboardFundingCapacity,
  openingLeaderboardFundingRefusal,
  openingLeaderboardPrizeSplit,
  type ClubOpeningSetupInput,
  type OpeningPromotionType,
} from '../../services/ClubOpeningSetupService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import { useToast } from '../common/Toast';
import { SpadeConsole } from '../console/SpadeConsole';
import './ClubOpeningWizard.css';

interface Props {
  clubId: string;
  clubName: string;
  clubBank: number;
  /** The club's saved tag line, so finishing setup never replaces it by accident. */
  initialTagline?: string | null;
  /** Promo Wallet chips the club already holds. A new club holds none. */
  clubPromoBalance?: number | null;
  onClose: () => void;
  onComplete: (result: { clubBankAfter: number; spinsEnabled: boolean; tagline: string }) => void;
}

const STEPS = [
  'Opening Review',
  'Club Tag Line',
  'Rake',
  'Bad Beat Jackpot',
  'Spins',
  'Promotion',
  'Leaderboards',
  'Review',
];

const PROMOTION_TYPES: { value: OpeningPromotionType; label: string }[] = [
  { value: 'rake_race', label: 'Opening Rake Race' },
  { value: 'high_hand', label: 'Opening High Hand' },
  { value: 'milestone', label: 'First-Player Milestone' },
  { value: 'mystery', label: 'Mystery Reward' },
];

/** Null until the owner answers. A chip transfer is never a default answer. */
type OpeningAnswer = 'enabled' | 'not_now' | null;

/**
 * An exact money figure: the whole integer with thousands separators and no
 * decimals. Used only where the owner confirms or must type an exact amount
 * (a transfer confirmation, a minimum, a shortfall). Every other figure on
 * this surface is compactChips().
 */
function exactChips(value: number) {
  return Math.floor(Math.abs(Number(value) || 0)).toLocaleString('en-US');
}

/** A shortfall rounds UP to the next whole chip, so lowering by it always clears it. */
function shortfallChips(remaining: number) {
  return Math.ceil(Math.abs(Math.min(0, Number(remaining) || 0))).toLocaleString('en-US');
}

/** Chip inputs accept whole chips only; chip counts never carry decimals. */
function wholeChips(raw: string) {
  return Math.max(0, Math.floor(Number(raw) || 0));
}

function FundingConfirmation({
  title,
  amount,
  destination,
  confirmed,
  onChange,
  bankAfter,
}: {
  title: string;
  amount: number;
  destination: string;
  confirmed: boolean;
  onChange: (value: boolean) => void;
  bankAfter: number;
}) {
  return (
    <div className="club-setup-wizard__confirm">
      <span className="club-setup-wizard__eyebrow">{title}</span>
      {/* An exact transfer is an agreement, so it is ticked, not switched: the
          kit cuts the box into the glass (sc-check, SpadeConsole.css) and it
          lights green once ticked. The amount prints in full, never compact. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={confirmed}
        className={`club-setup-wizard__tick sc-check ${
          confirmed ? 'sc-check--on sc-ink--green' : 'sc-ink--muted'
        }`}
        onClick={() => onChange(!confirmed)}
      >
        <span className="sc-check__box" aria-hidden="true" />
        <span>{`Transfer Exactly ${exactChips(amount)} Chips From The Club Bank Into ${destination}`}</span>
      </button>
      {bankAfter < 0 ? (
        <small className="club-setup-wizard__shortfall">
          Transfers Chosen So Far Exceed The Club Bank By {shortfallChips(bankAfter)} Chips
        </small>
      ) : (
        <small>Club Bank After Every Transfer Chosen So Far: {compactChips(bankAfter)} Chips</small>
      )}
    </div>
  );
}

export default function ClubOpeningWizard({
  clubId,
  clubName,
  clubBank,
  initialTagline,
  clubPromoBalance,
  onClose,
  onComplete,
}: Props) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [tagline, setTagline] = useState(() => (initialTagline ?? '').trim().slice(0, 72));
  const [rakeMode, setRakeMode] = useState<'house' | 'custom'>('house');
  const [rakePercent, setRakePercent] = useState(10);
  const [rakeCap, setRakeCap] = useState(3);
  const [bbjAnswer, setBbjAnswer] = useState<OpeningAnswer>(null);
  const bbjEnabled = bbjAnswer === 'enabled';
  const [bbjSeed, setBbjSeed] = useState(100);
  const [bbjFundingConfirmed, setBbjFundingConfirmed] = useState(false);
  const [spinsEnabled, setSpinsEnabled] = useState(false);
  const [spinFundingConfirmed, setSpinFundingConfirmed] = useState(false);
  const [spinMaxStake, setSpinMaxStake] = useState(1);
  const spinCoverageMinimum = Math.max(100, requiredSeedForStake(spinMaxStake));
  const [spinSeed, setSpinSeed] = useState(requiredSeedForStake(1));
  const [promoAnswer, setPromoAnswer] = useState<OpeningAnswer>(null);
  const promoEnabled = promoAnswer === 'enabled';
  const [promoFundingConfirmed, setPromoFundingConfirmed] = useState(false);
  const [promoType, setPromoType] = useState<OpeningPromotionType>('high_hand');
  const [promoName, setPromoName] = useState(`${titleCase(clubName)} Opening High Hand`);
  const [promoDescription, setPromoDescription] = useState(
    'Play During Our Opening Month And Chase The Featured High Hand.'
  );
  const [promoBudget, setPromoBudget] = useState(500);
  const [leaderboardRewardsEnabled, setLeaderboardRewardsEnabled] = useState(false);
  const [leaderboardMetric, setLeaderboardMetric] = useState<
    'profit' | 'hands_played' | 'tournaments_won' | 'roi'
  >('profit');
  const [leaderboardPrizeBudget, setLeaderboardPrizeBudget] = useState(500);
  const [leaderboardFundingConfirmed, setLeaderboardFundingConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  /* In-flight protection that does not wait for a render: a double tap on the
     painted plate lands before `saving` has re-rendered it disabled. */
  const savingRef = useRef(false);
  /* ONE KEY PER SUBMISSION, HELD ACROSS RETRIES. The key used to be minted
     inside the service on every call, so a setup that committed while its
     response was lost could not be told apart from somebody else's earlier
     setup. Keyed on the exact answers being submitted, so a genuinely
     different submission gets its own key. Retired on a definitive success or
     a definitive server refusal, kept when the outcome is unknown. */
  const requestKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLElement>(null);

  /* A new step opens at its own top, not wherever the last one was scrolled
     to, and its name is brought into view in the step rail, which is wider
     than a phone and used to leave the current step off the right edge. The
     rail scrolls sideways by itself only; nothing here moves the page. */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const rail = stepsRef.current;
    const current = rail?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!rail || !current) return;
    const railBox = rail.getBoundingClientRect();
    const stepBox = current.getBoundingClientRect();
    rail.scrollLeft += stepBox.left - railBox.left - (railBox.width - stepBox.width) / 2;
  }, [step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingRef.current) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const allocation = useMemo(
    () =>
      (bbjEnabled ? bbjSeed : 0) +
      (spinsEnabled ? spinSeed : 0) +
      (promoEnabled ? promoBudget : 0) +
      (leaderboardRewardsEnabled ? leaderboardPrizeBudget : 0),
    [
      bbjEnabled,
      bbjSeed,
      spinsEnabled,
      spinSeed,
      promoEnabled,
      promoBudget,
      leaderboardRewardsEnabled,
      leaderboardPrizeBudget,
    ]
  );
  const remaining = clubBank - allocation;

  const leaderboardFundingCapacity = openingLeaderboardFundingCapacity({
    promoEnabled,
    promoBudget,
    existingPromoBalance: clubPromoBalance,
  });
  const leaderboardPrizeSplit = openingLeaderboardPrizeSplit(leaderboardPrizeBudget);
  const normalizedTagline = tagline.trim().replace(/\s+/g, ' ');

  const stepError = useMemo(() => {
    const errorForStep = (index: number) => {
      if (index === 1 && normalizedTagline.length < 3) return 'Write A Custom Club Tag Line';
      if (
        index === 1 &&
        /all fish of all shapes and sizes are welcome/i.test(tagline) &&
        !/^shark club$/i.test(clubName.trim())
      ) {
        return 'That Tag Line Belongs To Shark Club';
      }
      if (index === 3 && bbjAnswer === null) {
        return 'Choose Enable BBJ Or Not Now Before Continuing';
      }
      if (index === 3 && bbjEnabled && bbjSeed < 100) return 'BBJ Seed Must Be At Least 100 Chips';
      if (index === 3 && bbjEnabled && !bbjFundingConfirmed) {
        return 'Confirm The Exact BBJ Seed Transfer Before Continuing';
      }
      if (index === 4 && spinsEnabled && spinSeed < spinCoverageMinimum) {
        return `This Spin Board Requires At Least ${compactChips(spinCoverageMinimum)} Chips`;
      }
      if (index === 4 && spinsEnabled && !spinFundingConfirmed) {
        return 'Confirm The Exact Spin Reserve Transfer Before Continuing';
      }
      if (index === 5 && promoAnswer === null) {
        return 'Choose Create Promotion Or Not Now Before Continuing';
      }
      if (index === 5 && promoEnabled) {
        if (promoName.trim().length < 3) return 'Promotion Name Must Be At Least 3 Characters';
        if (promoBudget < 100) return 'Promotion Budget Must Be At Least 100 Chips';
        if (!promoFundingConfirmed) {
          return 'Confirm The Exact Promotion Budget Transfer Before Continuing';
        }
      }
      if (index === 6 && leaderboardRewardsEnabled) {
        if (leaderboardPrizeBudget < 100) {
          return 'Leaderboard Prize Budget Must Be At Least 100 Chips';
        }
        if (!openingLeaderboardBudgetSplitsEvenly(leaderboardPrizeBudget)) {
          return 'Leaderboard Prize Budget Must Be A Multiple Of 10 Chips So Every Prize Is A Whole Chip Amount';
        }
        const fundingRefusal = openingLeaderboardFundingRefusal({
          promoEnabled,
          promoBudget,
          leaderboardPrizeBudget,
          existingPromoBalance: clubPromoBalance,
        });
        if (fundingRefusal) return fundingRefusal;
        if (!leaderboardFundingConfirmed) {
          return 'Confirm The Exact Leaderboard Prize Seed Transfer Before Continuing';
        }
      }
      return '';
    };
    if (step < STEPS.length - 1) return errorForStep(step);
    /* Review re-checks every answer, so an edit made after stepping back can
       never reach the server through a step that was valid when it was left. */
    for (let index = 1; index < STEPS.length - 1; index += 1) {
      const error = errorForStep(index);
      if (error) return error;
    }
    if (remaining < 0) return 'Setup Allocation Exceeds The Club Bank';
    return '';
  }, [
    step,
    tagline,
    normalizedTagline,
    clubName,
    bbjAnswer,
    bbjEnabled,
    bbjSeed,
    bbjFundingConfirmed,
    spinsEnabled,
    spinSeed,
    spinCoverageMinimum,
    spinFundingConfirmed,
    promoAnswer,
    promoEnabled,
    promoName,
    promoBudget,
    promoFundingConfirmed,
    leaderboardRewardsEnabled,
    leaderboardPrizeBudget,
    leaderboardFundingConfirmed,
    clubPromoBalance,
    remaining,
  ]);

  const finish = async () => {
    if (stepError || saving || savingRef.current) return;
    const input: ClubOpeningSetupInput = {
      clubId,
      tagline: normalizedTagline,
      rakePercent: rakeMode === 'house' ? -1 : rakePercent,
      rakeCapBB: rakeMode === 'house' ? -1 : rakeCap,
      bbjEnabled,
      bbjSeed,
      spinsEnabled,
      spinSeed,
      spinMaxStake,
      promoEnabled,
      promoType,
      promoName: promoName.trim(),
      promoDescription: promoDescription.trim(),
      promoBudget,
      leaderboardRewardsEnabled,
      leaderboardMetric,
      leaderboardPrizeBudget,
    };
    const fingerprint = JSON.stringify(input);
    if (!requestKeyRef.current || requestKeyRef.current.fingerprint !== fingerprint) {
      requestKeyRef.current = { fingerprint, key: crypto.randomUUID() };
    }
    const operationId = requestKeyRef.current.key;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await clubOpeningSetupService.complete(input, operationId);
      requestKeyRef.current = null;
      if (result.already_completed && result.operation_id !== operationId) {
        /* A DIFFERENT, EARLIER SETUP OWNS THIS CLUB. Nothing typed here was
           applied, so none of it is reported as applied: the page is handed
           what the server holds, or nothing at all. */
        let applied = null;
        try {
          applied = await clubOpeningSetupService.getAppliedState(clubId);
        } catch (readError) {
          reportError(readError, 'ClubOpeningWizard.appliedState');
        }
        if (applied) {
          toast.info(
            'Opening Setup Was Already Completed For This Club. Your New Answers Were Not Applied'
          );
          onComplete({
            clubBankAfter: Number(result.club_bank_after),
            spinsEnabled: applied.spinsEnabled,
            tagline: applied.tagline,
          });
        } else {
          toast.warning(
            'Opening Setup Was Already Completed For This Club. Reload To See The Saved Setup'
          );
          onClose();
        }
        return;
      }
      /* Either a fresh commit, or the server echoing THIS submission's key
         after an earlier response was lost. Both mean these answers are the
         ones the server applied. */
      toast.success('Club Opening Setup Completed');
      onComplete({
        clubBankAfter: Number(result.club_bank_after),
        spinsEnabled,
        tagline: normalizedTagline,
      });
    } catch (error) {
      reportError(error, 'ClubOpeningWizard.complete');
      if (isDefinitiveOpeningSetupRefusal(error)) requestKeyRef.current = null;
      toast.error(
        error instanceof Error ? error.message : 'Club Opening Setup Could Not Be Completed'
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const body = (
    <div
      ref={dialogRef}
      className="club-setup-wizard"
      role="dialog"
      aria-modal="true"
      aria-labelledby="club-setup-title"
    >
      <SpadeConsole
        as="div"
        className="club-setup-wizard__shell"
        eyebrow="Club Arena / Opening Pit Boss"
        title={`Open ${titleCase(clubName)}`}
        titleId="club-setup-title"
        subtitle="Set Every System Before Opening"
        pill={`Step ${step + 1} Of ${STEPS.length}`}
        pillInk="blue"
        crest="club"
        plates={{
          secondary: {
            label: step === 0 ? 'Close' : 'Back',
            ink: 'silver',
            onClick: step === 0 ? onClose : () => setStep((value) => Math.max(0, value - 1)),
            disabled: saving,
            'aria-label': step === 0 ? 'Close Opening Wizard' : 'Previous Opening Step',
          },
          primary: {
            label: step < STEPS.length - 1 ? 'Continue' : saving ? 'Opening Club...' : 'Open Club',
            ink: 'white',
            onClick:
              step < STEPS.length - 1
                ? () => setStep((value) => Math.min(STEPS.length - 1, value + 1))
                : finish,
            disabled: Boolean(stepError) || saving,
            'aria-label':
              step < STEPS.length - 1
                ? 'Continue Opening Setup'
                : 'Open Club And Complete Opening Setup',
          },
        }}
      >
        <div className="club-setup-wizard__scroll" ref={scrollRef}>
          <div className="club-setup-wizard__command-row">
            <div
              className="club-setup-wizard__bank"
              aria-label={`${compactChips(clubBank)} Chips In Club Bank`}
            >
              <span>Club Bank</span>
              <strong>{compactChips(clubBank)}</strong>
              <small>Opening Capital</small>
            </div>
            {/* Step one already carries Close on the painted plate; one way out
              per screen. From step two the plate becomes Back, so this is it. */}
            {step > 0 && (
              <button
                type="button"
                className="club-setup-wizard__close"
                onClick={onClose}
                disabled={saving}
                aria-label="Close Opening Wizard"
              >
                Close Opening Wizard
              </button>
            )}
          </div>

          <nav className="club-setup-wizard__steps" aria-label="Club Opening Steps" ref={stepsRef}>
            {STEPS.map((label, index) => (
              <button
                key={label}
                type="button"
                className={index === step ? 'is-current' : index < step ? 'is-complete' : ''}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => index < step && !saving && setStep(index)}
                disabled={index > step || saving}
              >
                <span>{index < step ? 'Done' : String(index + 1).padStart(2, '0')}</span>
                {label}
              </button>
            ))}
          </nav>

          <main className="club-setup-wizard__main">
            {step === 0 && (
              <section className="club-setup-wizard__panel club-setup-wizard__intro">
                <span className="club-setup-wizard__eyebrow">Opening Capital Control</span>
                <h2 className="sc-ink--silver">Configure The Systems That Move Club Chips</h2>
                <p>
                  This Guided Setup Configures Rake, Bad Beat Jackpot Funding, Spin Coverage, Your
                  First Promotion, And Leaderboard Rewards. Every Enabled Treasury Is Funded From
                  The Club Bank And Recorded In The Opening Ledger.
                </p>
                <div className="club-setup-wizard__assurances">
                  <article>
                    <strong>100</strong>
                    <span>Minimum BBJ Seed</span>
                  </article>
                  <article>
                    <strong>100+</strong>
                    <span>Minimum Spin Seed</span>
                  </article>
                  <article>
                    <strong>One</strong>
                    <span>Atomic Setup Commit</span>
                  </article>
                </div>
              </section>
            )}

            {step === 1 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Club Voice</span>
                <h2 className="sc-ink--silver">
                  Write A Tag Line That Belongs To {titleCase(clubName)}
                </h2>
                <p>
                  This Is A New, Club-Specific Line. It Is Never Copied From Another Club And It Is
                  Kept Separate From The Longer Club Description.
                </p>
                <div className="club-setup-wizard__fields">
                  <label>
                    Club Tag Line
                    <input
                      type="text"
                      maxLength={72}
                      value={tagline}
                      onChange={(event) => setTagline(event.target.value)}
                      placeholder="Write A Short, Original Club Tag Line"
                      autoFocus
                    />
                    <small>{tagline.length} Of 72 Characters</small>
                  </label>
                </div>
              </section>
            )}

            {step === 2 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Revenue Schedule</span>
                <h2 className="sc-ink--silver">Choose Your Cash-Game Rake</h2>
                <p>
                  The House Schedule Uses The Published 10% Rate And Stake-Specific Caps. A Custom
                  Schedule Applies Club-Wide Unless A Table Overrides It.
                </p>
                <div className="club-setup-wizard__choice-grid">
                  <button
                    type="button"
                    className={rakeMode === 'house' ? 'is-selected' : ''}
                    aria-pressed={rakeMode === 'house'}
                    onClick={() => setRakeMode('house')}
                  >
                    <strong>Use House Schedule</strong>
                    <span>Recommended Published Rate And Caps</span>
                  </button>
                  <button
                    type="button"
                    className={rakeMode === 'custom' ? 'is-selected' : ''}
                    aria-pressed={rakeMode === 'custom'}
                    onClick={() => setRakeMode('custom')}
                  >
                    <strong>Use Custom Schedule</strong>
                    <span>Set A Club Rate And Cap</span>
                  </button>
                </div>
                {rakeMode === 'custom' && (
                  <div className="club-setup-wizard__fields two-columns">
                    <label>
                      Rake Percent
                      <input
                        type="number"
                        min="0"
                        max="10"
                        step="0.5"
                        value={rakePercent}
                        onChange={(event) =>
                          setRakePercent(Math.min(10, Math.max(0, Number(event.target.value))))
                        }
                      />
                    </label>
                    <label>
                      Rake Cap In Big Blinds
                      <input
                        type="number"
                        min="0"
                        max="10"
                        step="0.5"
                        value={rakeCap}
                        onChange={(event) =>
                          setRakeCap(Math.min(10, Math.max(0, Number(event.target.value))))
                        }
                      />
                    </label>
                  </div>
                )}
              </section>
            )}

            {step === 3 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Bad Beat Protection</span>
                <h2 className="sc-ink--silver">Do You Want A Bad Beat Jackpot?</h2>
                <p>
                  Enabled Clubs Must Seed The Main Jackpot With At Least 100 Chips. Future BBJ Drops
                  Continue Funding The Main, Backup, And Promotional Banks.
                </p>
                <div className="club-setup-wizard__choice-grid">
                  <button
                    type="button"
                    className={bbjAnswer === 'enabled' ? 'is-selected' : ''}
                    aria-pressed={bbjAnswer === 'enabled'}
                    onClick={() => {
                      if (bbjAnswer !== 'enabled') setBbjFundingConfirmed(false);
                      setBbjAnswer('enabled');
                    }}
                  >
                    <strong>Enable BBJ</strong>
                    <span>Seed And Begin Collecting</span>
                  </button>
                  <button
                    type="button"
                    className={bbjAnswer === 'not_now' ? 'is-selected' : ''}
                    aria-pressed={bbjAnswer === 'not_now'}
                    onClick={() => {
                      setBbjAnswer('not_now');
                      setBbjFundingConfirmed(false);
                    }}
                  >
                    <strong>Not Now</strong>
                    <span>Record The Decision Without Funding</span>
                  </button>
                </div>
                {bbjEnabled && (
                  <>
                    <div className="club-setup-wizard__fields">
                      <label>
                        BBJ Opening Seed
                        <input
                          type="number"
                          min="100"
                          step="100"
                          value={bbjSeed}
                          onChange={(event) => {
                            setBbjFundingConfirmed(false);
                            setBbjSeed(wholeChips(event.target.value));
                          }}
                        />
                        <small>Minimum 100 Chips From The Club Bank</small>
                      </label>
                    </div>
                    <FundingConfirmation
                      title="BBJ Funding Confirmation"
                      amount={bbjSeed}
                      destination="The Bad Beat Jackpot Main Bank"
                      confirmed={bbjFundingConfirmed}
                      onChange={setBbjFundingConfirmed}
                      bankAfter={remaining}
                    />
                  </>
                )}
              </section>
            )}

            {step === 4 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Multiplier Coverage</span>
                <h2 className="sc-ink--silver">Do You Want To Offer Spins?</h2>
                <p>
                  Spins Require Operator Capital To Cover Two Top-Tier Payouts At The Largest Buy-In
                  You Offer. The Minimum Is 100 Chips, And Higher Boards Require More Coverage.
                </p>
                <div className="club-setup-wizard__choice-grid">
                  <button
                    type="button"
                    className={spinsEnabled ? 'is-selected' : ''}
                    aria-pressed={spinsEnabled}
                    onClick={() => {
                      setSpinsEnabled(true);
                      setSpinFundingConfirmed(false);
                      setSpinSeed((value) => Math.max(value, spinCoverageMinimum));
                    }}
                  >
                    <strong>Enable Spins</strong>
                    <span>Fund The Reserve And Open The Board</span>
                  </button>
                  <button
                    type="button"
                    className={!spinsEnabled ? 'is-selected' : ''}
                    aria-pressed={!spinsEnabled}
                    onClick={() => {
                      setSpinsEnabled(false);
                      setSpinFundingConfirmed(false);
                    }}
                  >
                    <strong>Not Now</strong>
                    <span>Keep Spins Closed For Launch</span>
                  </button>
                </div>
                {spinsEnabled && (
                  <div className="club-setup-wizard__fields two-columns">
                    <label>
                      Largest Spin Buy-In
                      <select
                        value={spinMaxStake}
                        onChange={(event) => {
                          const stake = Number(event.target.value);
                          setSpinMaxStake(stake);
                          setSpinFundingConfirmed(false);
                          setSpinSeed((value) =>
                            Math.max(value, Math.max(100, requiredSeedForStake(stake)))
                          );
                        }}
                      >
                        {SPIN_BOARD_STAKES.map((stake) => (
                          <option key={stake} value={stake}>
                            {stake} Chips
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Spin Reserve Seed
                      <input
                        type="number"
                        min={spinCoverageMinimum}
                        step="100"
                        value={spinSeed}
                        onChange={(event) => {
                          setSpinFundingConfirmed(false);
                          setSpinSeed(wholeChips(event.target.value));
                        }}
                      />
                      <small>Coverage Minimum: {compactChips(spinCoverageMinimum)} Chips</small>
                    </label>
                  </div>
                )}
                {spinsEnabled && (
                  <FundingConfirmation
                    title="Spin Funding Confirmation"
                    amount={spinSeed}
                    destination="The Spin Reserve"
                    confirmed={spinFundingConfirmed}
                    onChange={setSpinFundingConfirmed}
                    bankAfter={remaining}
                  />
                )}
              </section>
            )}

            {step === 5 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Opening Campaign</span>
                <h2 className="sc-ink--silver">Set Up Your First Promotion</h2>
                <p>
                  Create A 30-Day Opening Promotion And Move Its Prize Budget From The Club Bank
                  Into The Club Promo Wallet.
                </p>
                <div className="club-setup-wizard__choice-grid">
                  <button
                    type="button"
                    className={promoAnswer === 'enabled' ? 'is-selected' : ''}
                    aria-pressed={promoAnswer === 'enabled'}
                    onClick={() => {
                      if (promoAnswer !== 'enabled') setPromoFundingConfirmed(false);
                      setPromoAnswer('enabled');
                    }}
                  >
                    <strong>Create Promotion</strong>
                    <span>Publish And Fund An Opening Campaign</span>
                  </button>
                  <button
                    type="button"
                    className={promoAnswer === 'not_now' ? 'is-selected' : ''}
                    aria-pressed={promoAnswer === 'not_now'}
                    onClick={() => {
                      setPromoAnswer('not_now');
                      setPromoFundingConfirmed(false);
                    }}
                  >
                    <strong>Not Now</strong>
                    <span>Open Without A Campaign</span>
                  </button>
                </div>
                {promoEnabled && (
                  <div className="club-setup-wizard__fields two-columns">
                    <label>
                      Promotion Type
                      <select
                        value={promoType}
                        onChange={(event) =>
                          setPromoType(event.target.value as OpeningPromotionType)
                        }
                      >
                        {PROMOTION_TYPES.map((type) => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Prize Budget
                      <input
                        type="number"
                        min="100"
                        step="100"
                        value={promoBudget}
                        onChange={(event) => {
                          setPromoFundingConfirmed(false);
                          setLeaderboardFundingConfirmed(false);
                          setPromoBudget(wholeChips(event.target.value));
                        }}
                      />
                      <small>Moved Into The Club Promo Wallet</small>
                    </label>
                    <label className="full-width">
                      Promotion Name
                      <input
                        maxLength={80}
                        value={promoName}
                        onChange={(event) => setPromoName(event.target.value)}
                      />
                    </label>
                    <label className="full-width">
                      Promotion Description
                      <textarea
                        maxLength={500}
                        rows={4}
                        value={promoDescription}
                        onChange={(event) => setPromoDescription(event.target.value)}
                      />
                    </label>
                  </div>
                )}
                {promoEnabled && (
                  <FundingConfirmation
                    title="Promotion Funding Confirmation"
                    amount={promoBudget}
                    destination="The Club Promo Wallet"
                    confirmed={promoFundingConfirmed}
                    onChange={setPromoFundingConfirmed}
                    bankAfter={remaining}
                  />
                )}
              </section>
            )}

            {step === 6 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Player Rankings</span>
                <h2 className="sc-ink--silver">Will Leaderboards Be Display Only Or Pay Prizes?</h2>
                <p>
                  Display Only Is Recommended For A New Club. Add Prizes After The Club Has Enough
                  Reliable Play Volume To Make Weekly Rankings Meaningful.
                </p>
                <div className="club-setup-wizard__choice-grid">
                  <button
                    type="button"
                    className={!leaderboardRewardsEnabled ? 'is-selected' : ''}
                    aria-pressed={!leaderboardRewardsEnabled}
                    onClick={() => {
                      setLeaderboardRewardsEnabled(false);
                      setLeaderboardFundingConfirmed(false);
                    }}
                  >
                    <strong>Display Only</strong>
                    <span>Recommended For New Clubs</span>
                  </button>
                  <button
                    type="button"
                    className={leaderboardRewardsEnabled ? 'is-selected' : ''}
                    aria-pressed={leaderboardRewardsEnabled}
                    onClick={() => {
                      if (!leaderboardRewardsEnabled) setLeaderboardFundingConfirmed(false);
                      setLeaderboardRewardsEnabled(true);
                    }}
                  >
                    <strong>Pay Weekly Prizes</strong>
                    <span>Fund A Ready-Made Top-Three Plan</span>
                  </button>
                </div>
                {leaderboardRewardsEnabled && (
                  <>
                    <div className="club-setup-wizard__fields two-columns">
                      <label>
                        Ranking Metric
                        <select
                          value={leaderboardMetric}
                          onChange={(event) =>
                            setLeaderboardMetric(event.target.value as typeof leaderboardMetric)
                          }
                        >
                          <option value="profit">Profit</option>
                          <option value="hands_played">Hands Played</option>
                          <option value="tournaments_won">Tournaments Won</option>
                          <option value="roi">Return On Investment</option>
                        </select>
                      </label>
                      <label>
                        Weekly Prize Budget
                        <input
                          type="number"
                          min="100"
                          step="100"
                          value={leaderboardPrizeBudget}
                          onChange={(event) => {
                            setLeaderboardFundingConfirmed(false);
                            setLeaderboardPrizeBudget(wholeChips(event.target.value));
                          }}
                        />
                        <small>Held As The First-Round Prize Seed, Outside The Promo Wallet</small>
                      </label>
                    </div>
                    <div
                      className="club-setup-wizard__suggestions"
                      aria-label="Suggested Leaderboard Prize Budgets"
                    >
                      <span>Suggested Budgets</span>
                      {[100, 500, 1000].map((budget) => (
                        <button
                          key={budget}
                          type="button"
                          className={leaderboardPrizeBudget === budget ? 'is-selected' : ''}
                          aria-pressed={leaderboardPrizeBudget === budget}
                          /* A budget the server's funding gate would reject is
                           shown but never selectable. */
                          disabled={budget > leaderboardFundingCapacity}
                          onClick={() => {
                            setLeaderboardFundingConfirmed(false);
                            setLeaderboardPrizeBudget(budget);
                          }}
                        >
                          {compactChips(budget)} Chips
                        </button>
                      ))}
                    </div>
                    <p className="club-setup-wizard__commit-note">
                      {leaderboardFundingCapacity >= 100
                        ? `A Weekly Prize Budget Can Be At Most The ${compactChips(leaderboardFundingCapacity)} Chip Promotion Budget, Because Every Later Round Is Paid From The Promo Wallet.`
                        : 'Paid Leaderboards Need A Funded Promotion Budget First, Because Every Later Round Is Paid From The Promo Wallet.'}
                    </p>
                    <div className="club-setup-wizard__prize-plan">
                      <span>Suggested Balanced Plan</span>
                      <strong>1st {compactChips(leaderboardPrizeSplit.first)}</strong>
                      <strong>2nd {compactChips(leaderboardPrizeSplit.second)}</strong>
                      <strong>3rd {compactChips(leaderboardPrizeSplit.third)}</strong>
                    </div>
                    <FundingConfirmation
                      title="Leaderboard Funding Confirmation"
                      amount={leaderboardPrizeBudget}
                      destination="The Leaderboard First-Round Prize Seed"
                      confirmed={leaderboardFundingConfirmed}
                      onChange={setLeaderboardFundingConfirmed}
                      bankAfter={remaining}
                    />
                  </>
                )}
              </section>
            )}

            {step === 7 && (
              <section className="club-setup-wizard__panel">
                <span className="club-setup-wizard__eyebrow">Opening Ledger Review</span>
                <h2 className="sc-ink--silver">Review Before Opening The Club</h2>
                <div className="club-setup-wizard__ledger">
                  <div>
                    <span>Rake Schedule</span>
                    <strong>
                      {rakeMode === 'house'
                        ? 'House Schedule'
                        : `${rakePercent}% / ${rakeCap} BB Cap`}
                    </strong>
                  </div>
                  <div>
                    <span>Club Tag Line</span>
                    <strong>{titleCase(normalizedTagline)}</strong>
                  </div>
                  <div>
                    <span>Bad Beat Jackpot</span>
                    <strong>{bbjEnabled ? `${compactChips(bbjSeed)} Chips` : 'Not Enabled'}</strong>
                  </div>
                  <div>
                    <span>Spin Reserve</span>
                    <strong>
                      {spinsEnabled ? `${compactChips(spinSeed)} Chips` : 'Not Enabled'}
                    </strong>
                  </div>
                  <div>
                    <span>Promotion Budget</span>
                    <strong>
                      {promoEnabled ? `${compactChips(promoBudget)} Chips` : 'Not Enabled'}
                    </strong>
                  </div>
                  <div>
                    <span>Leaderboard Rewards</span>
                    <strong>
                      {leaderboardRewardsEnabled
                        ? `${compactChips(leaderboardPrizeBudget)} Chips / Week, First Round Seeded`
                        : 'Display Only'}
                    </strong>
                  </div>
                  <div className="club-setup-wizard__ledger-total">
                    <span>Total Opening Allocation</span>
                    <strong>{compactChips(allocation)} Chips</strong>
                  </div>
                  {remaining < 0 ? (
                    <div className="club-setup-wizard__ledger-balance is-short">
                      <span>Club Bank After Setup</span>
                      <strong>Short By {shortfallChips(remaining)} Chips</strong>
                    </div>
                  ) : (
                    <div className="club-setup-wizard__ledger-balance">
                      <span>Club Bank After Setup</span>
                      <strong>{compactChips(remaining)} Chips</strong>
                    </div>
                  )}
                </div>
                {remaining < 0 ? (
                  <p className="club-setup-wizard__shortfall">
                    The Club Bank Cannot Cover This Setup. Go Back And Lower A Seed Or Budget By At
                    Least {shortfallChips(remaining)} Chips.
                  </p>
                ) : (
                  <p className="club-setup-wizard__commit-note">
                    Completing Setup Transfers Exactly {exactChips(allocation)} Chips From The Club
                    Bank.
                  </p>
                )}
                <p className="club-setup-wizard__commit-note">
                  Completing Setup Commits Every Enabled System In One Transaction. A Paid
                  Leaderboard Holds Its First-Round Seed Outside The Promo Wallet. The First Round
                  Is Paid From That Seed, Then From The Promo Wallet, And Any Unused Seed Moves Into
                  The Promo Wallet. Every Later Round Is Paid Only From The Promo Wallet. If The
                  Promo Wallet Cannot Cover A Round, That Round Stays Unpaid And Is Retried
                  Automatically. No Round Is Ever Paid From The Club Bank. If Any Treasury,
                  Permission, Or Promotion Step Fails, Nothing Is Deducted.
                </p>
              </section>
            )}
          </main>
        </div>
        {/* Outside the scroll wrapper, so the reason Continue is blocked is always
            on screen above the plates, however long the step. */}
        {stepError && (
          <div className="club-setup-wizard__error" role="alert">
            {stepError}
          </div>
        )}
      </SpadeConsole>
    </div>
  );

  return createPortal(body, document.body);
}
