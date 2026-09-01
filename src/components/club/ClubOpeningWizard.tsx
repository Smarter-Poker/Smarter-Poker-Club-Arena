import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { requiredSeedForStake, SPIN_BOARD_STAKES } from '../../services/SpinActivationService';
import {
  clubOpeningSetupService,
  type OpeningPromotionType,
} from '../../services/ClubOpeningSetupService';
import { reportError } from '../../utils/errorReporter';
import { useToast } from '../common/Toast';
import './ClubOpeningWizard.css';

interface Props {
  clubId: string;
  clubName: string;
  clubBank: number;
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

function chips(value: number) {
  return Math.max(0, Number(value) || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

export default function ClubOpeningWizard({
  clubId,
  clubName,
  clubBank,
  onClose,
  onComplete,
}: Props) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [tagline, setTagline] = useState('');
  const [rakeMode, setRakeMode] = useState<'house' | 'custom'>('house');
  const [rakePercent, setRakePercent] = useState(10);
  const [rakeCap, setRakeCap] = useState(3);
  const [bbjEnabled, setBbjEnabled] = useState(true);
  const [bbjSeed, setBbjSeed] = useState(100);
  const [spinsEnabled, setSpinsEnabled] = useState(false);
  const [spinMaxStake, setSpinMaxStake] = useState(1);
  const spinCoverageMinimum = Math.max(100, requiredSeedForStake(spinMaxStake));
  const [spinSeed, setSpinSeed] = useState(requiredSeedForStake(1));
  const [promoEnabled, setPromoEnabled] = useState(true);
  const [promoType, setPromoType] = useState<OpeningPromotionType>('high_hand');
  const [promoName, setPromoName] = useState(`${clubName} Opening High Hand`);
  const [promoDescription, setPromoDescription] = useState(
    'Play During Our Opening Month And Chase The Featured High Hand.'
  );
  const [promoBudget, setPromoBudget] = useState(500);
  const [leaderboardRewardsEnabled, setLeaderboardRewardsEnabled] = useState(false);
  const [leaderboardMetric, setLeaderboardMetric] = useState<
    'profit' | 'hands_played' | 'tournaments_won' | 'roi'
  >('profit');
  const [leaderboardPrizeBudget, setLeaderboardPrizeBudget] = useState(500);
  const [saving, setSaving] = useState(false);

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

  const stepError = useMemo(() => {
    if (step === 1 && tagline.trim().length < 3) return 'Write A Custom Club Tag Line';
    if (
      step === 1 &&
      /all fish of all shapes and sizes are welcome/i.test(tagline) &&
      !/^shark club$/i.test(clubName.trim())
    ) {
      return 'That Tag Line Belongs To Shark Club';
    }
    if (step === 3 && bbjEnabled && bbjSeed < 100) return 'BBJ Seed Must Be At Least 100 Chips';
    if (step === 4 && spinsEnabled && spinSeed < spinCoverageMinimum) {
      return `This Spin Board Requires At Least ${chips(spinCoverageMinimum)} Chips`;
    }
    if (step === 5 && promoEnabled) {
      if (promoName.trim().length < 3) return 'Promotion Name Must Be At Least 3 Characters';
      if (promoBudget < 100) return 'Promotion Budget Must Be At Least 100 Chips';
    }
    if (step === 6 && leaderboardRewardsEnabled && leaderboardPrizeBudget < 100) {
      return 'Leaderboard Prize Budget Must Be At Least 100 Chips';
    }
    if (step === 7 && remaining < 0) return 'Setup Allocation Exceeds The Club Bank';
    return '';
  }, [
    step,
    tagline,
    clubName,
    bbjEnabled,
    bbjSeed,
    spinsEnabled,
    spinSeed,
    spinCoverageMinimum,
    promoEnabled,
    promoName,
    promoBudget,
    leaderboardRewardsEnabled,
    leaderboardPrizeBudget,
    remaining,
  ]);

  const finish = async () => {
    if (stepError || saving) return;
    setSaving(true);
    try {
      const result = await clubOpeningSetupService.complete({
        clubId,
        tagline: tagline.trim(),
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
      });
      toast.success('Club Opening Setup Completed');
      onComplete({
        clubBankAfter: Number(result.club_bank_after),
        spinsEnabled,
        tagline: tagline.trim(),
      });
    } catch (error) {
      reportError(error, 'ClubOpeningWizard.complete');
      toast.error(
        error instanceof Error ? error.message : 'Club Opening Setup Could Not Be Completed'
      );
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <div
      className="club-setup-wizard"
      role="dialog"
      aria-modal="true"
      aria-labelledby="club-setup-title"
    >
      <div className="club-setup-wizard__shell">
        <header className="club-setup-wizard__header">
          <div>
            <span>Club Arena / Opening Pit Boss</span>
            <h1 id="club-setup-title">Open {clubName}</h1>
          </div>
          <div
            className="club-setup-wizard__bank"
            aria-label={`${chips(clubBank)} Chips In Club Bank`}
          >
            <span>Club Bank</span>
            <strong>{chips(clubBank)}</strong>
            <small>Opening Capital</small>
          </div>
          <button
            type="button"
            className="club-setup-wizard__close"
            onClick={onClose}
            aria-label="Close Opening Wizard"
          >
            Close
          </button>
        </header>

        <nav className="club-setup-wizard__steps" aria-label="Club Opening Steps">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={index === step ? 'is-current' : index < step ? 'is-complete' : ''}
              aria-current={index === step ? 'step' : undefined}
              onClick={() => index < step && setStep(index)}
              disabled={index > step}
            >
              <span>{index < step ? '✓' : String(index + 1).padStart(2, '0')}</span>
              {label}
            </button>
          ))}
        </nav>

        <main className="club-setup-wizard__main">
          {step === 0 && (
            <section className="club-setup-wizard__panel club-setup-wizard__intro">
              <span className="club-setup-wizard__eyebrow">Opening Capital Control</span>
              <h2>Configure The Systems That Move Club Chips</h2>
              <p>
                This Guided Setup Configures Rake, Bad Beat Jackpot Funding, Spin Coverage, Your
                First Promotion, And Leaderboard Rewards. Every Enabled Treasury Is Funded From The
                Club Bank And Recorded In The Opening Ledger.
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
              <h2>Write A Tag Line That Belongs To {clubName}</h2>
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
              <h2>Choose Your Cash-Game Rake</h2>
              <p>
                The House Schedule Uses The Published 10% Rate And Stake-Specific Caps. A Custom
                Schedule Applies Club-Wide Unless A Table Overrides It.
              </p>
              <div className="club-setup-wizard__choice-grid">
                <button
                  type="button"
                  className={rakeMode === 'house' ? 'is-selected' : ''}
                  onClick={() => setRakeMode('house')}
                >
                  <strong>Use House Schedule</strong>
                  <span>Recommended Published Rate And Caps</span>
                </button>
                <button
                  type="button"
                  className={rakeMode === 'custom' ? 'is-selected' : ''}
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
              <h2>Do You Want A Bad Beat Jackpot?</h2>
              <p>
                Enabled Clubs Must Seed The Main Jackpot With At Least 100 Chips. Future BBJ Drops
                Continue Funding The Main, Backup, And Promotional Banks.
              </p>
              <div className="club-setup-wizard__choice-grid">
                <button
                  type="button"
                  className={bbjEnabled ? 'is-selected' : ''}
                  onClick={() => setBbjEnabled(true)}
                >
                  <strong>Enable BBJ</strong>
                  <span>Seed And Begin Collecting</span>
                </button>
                <button
                  type="button"
                  className={!bbjEnabled ? 'is-selected' : ''}
                  onClick={() => setBbjEnabled(false)}
                >
                  <strong>Not Now</strong>
                  <span>Record The Decision Without Funding</span>
                </button>
              </div>
              {bbjEnabled && (
                <div className="club-setup-wizard__fields">
                  <label>
                    BBJ Opening Seed
                    <input
                      type="number"
                      min="100"
                      step="100"
                      value={bbjSeed}
                      onChange={(event) => setBbjSeed(Math.max(0, Number(event.target.value)))}
                    />
                    <small>Minimum 100 Chips From The Club Bank</small>
                  </label>
                </div>
              )}
            </section>
          )}

          {step === 4 && (
            <section className="club-setup-wizard__panel">
              <span className="club-setup-wizard__eyebrow">Multiplier Coverage</span>
              <h2>Do You Want To Offer Spins?</h2>
              <p>
                Spins Require Operator Capital To Cover Two Top-Tier Payouts At The Largest Buy-In
                You Offer. The Minimum Is 100 Chips, And Higher Boards Require More Coverage.
              </p>
              <div className="club-setup-wizard__choice-grid">
                <button
                  type="button"
                  className={spinsEnabled ? 'is-selected' : ''}
                  onClick={() => {
                    setSpinsEnabled(true);
                    setSpinSeed((value) => Math.max(value, spinCoverageMinimum));
                  }}
                >
                  <strong>Enable Spins</strong>
                  <span>Fund The Reserve And Open The Board</span>
                </button>
                <button
                  type="button"
                  className={!spinsEnabled ? 'is-selected' : ''}
                  onClick={() => setSpinsEnabled(false)}
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
                      onChange={(event) => setSpinSeed(Math.max(0, Number(event.target.value)))}
                    />
                    <small>Coverage Minimum: {chips(spinCoverageMinimum)} Chips</small>
                  </label>
                </div>
              )}
            </section>
          )}

          {step === 5 && (
            <section className="club-setup-wizard__panel">
              <span className="club-setup-wizard__eyebrow">Opening Campaign</span>
              <h2>Set Up Your First Promotion</h2>
              <p>
                Create A 30-Day Opening Promotion And Reserve Its Prize Budget In The Club Promo
                Wallet.
              </p>
              <div className="club-setup-wizard__choice-grid">
                <button
                  type="button"
                  className={promoEnabled ? 'is-selected' : ''}
                  onClick={() => setPromoEnabled(true)}
                >
                  <strong>Create Promotion</strong>
                  <span>Publish And Fund An Opening Campaign</span>
                </button>
                <button
                  type="button"
                  className={!promoEnabled ? 'is-selected' : ''}
                  onClick={() => setPromoEnabled(false)}
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
                      onChange={(event) => setPromoType(event.target.value as OpeningPromotionType)}
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
                      onChange={(event) => setPromoBudget(Math.max(0, Number(event.target.value)))}
                    />
                    <small>Reserved In The Promo Wallet</small>
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
            </section>
          )}

          {step === 6 && (
            <section className="club-setup-wizard__panel">
              <span className="club-setup-wizard__eyebrow">Player Rankings</span>
              <h2>Will Leaderboards Be Display Only Or Pay Prizes?</h2>
              <p>
                Display Only Is Recommended For A New Club. Add Prizes After The Club Has Enough
                Reliable Play Volume To Make Weekly Rankings Meaningful.
              </p>
              <div className="club-setup-wizard__choice-grid">
                <button
                  type="button"
                  className={!leaderboardRewardsEnabled ? 'is-selected' : ''}
                  onClick={() => setLeaderboardRewardsEnabled(false)}
                >
                  <strong>Display Only</strong>
                  <span>Recommended For New Clubs</span>
                </button>
                <button
                  type="button"
                  className={leaderboardRewardsEnabled ? 'is-selected' : ''}
                  onClick={() => setLeaderboardRewardsEnabled(true)}
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
                        onChange={(event) =>
                          setLeaderboardPrizeBudget(Math.max(0, Number(event.target.value)))
                        }
                      />
                      <small>Reserved In The Promo Wallet</small>
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
                        onClick={() => setLeaderboardPrizeBudget(budget)}
                      >
                        {chips(budget)} Chips
                      </button>
                    ))}
                  </div>
                  <div className="club-setup-wizard__prize-plan">
                    <span>Suggested Balanced Plan</span>
                    <strong>1st {chips(leaderboardPrizeBudget * 0.5)}</strong>
                    <strong>2nd {chips(leaderboardPrizeBudget * 0.3)}</strong>
                    <strong>3rd {chips(leaderboardPrizeBudget * 0.2)}</strong>
                  </div>
                </>
              )}
            </section>
          )}

          {step === 7 && (
            <section className="club-setup-wizard__panel">
              <span className="club-setup-wizard__eyebrow">Opening Ledger Review</span>
              <h2>Review Before Opening The Club</h2>
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
                  <strong>{tagline.trim()}</strong>
                </div>
                <div>
                  <span>Bad Beat Jackpot</span>
                  <strong>{bbjEnabled ? `${chips(bbjSeed)} Chips` : 'Not Enabled'}</strong>
                </div>
                <div>
                  <span>Spin Reserve</span>
                  <strong>{spinsEnabled ? `${chips(spinSeed)} Chips` : 'Not Enabled'}</strong>
                </div>
                <div>
                  <span>Promotion Budget</span>
                  <strong>{promoEnabled ? `${chips(promoBudget)} Chips` : 'Not Enabled'}</strong>
                </div>
                <div>
                  <span>Leaderboard Rewards</span>
                  <strong>
                    {leaderboardRewardsEnabled
                      ? `${chips(leaderboardPrizeBudget)} Chips / Week, First Round Seeded`
                      : 'Display Only'}
                  </strong>
                </div>
                <div className="club-setup-wizard__ledger-total">
                  <span>Total Opening Allocation</span>
                  <strong>{chips(allocation)} Chips</strong>
                </div>
                <div className="club-setup-wizard__ledger-balance">
                  <span>Club Bank After Setup</span>
                  <strong>{chips(remaining)} Chips</strong>
                </div>
              </div>
              <p className="club-setup-wizard__commit-note">
                Completing Setup Commits Every Enabled System In One Transaction. Paid Leaderboards
                Seed Their First Round Now; Later Rounds Use Promo Funds First And The Club Bank
                Covers Any Overlay. If Any Treasury, Permission, Or Promotion Step Fails, Nothing Is
                Deducted.
              </p>
            </section>
          )}
          {stepError && (
            <div className="club-setup-wizard__error" role="alert">
              {stepError}
            </div>
          )}
        </main>

        <footer className="club-setup-wizard__footer">
          <button
            type="button"
            onClick={() => setStep((value) => Math.max(0, value - 1))}
            disabled={step === 0 || saving}
          >
            Back
          </button>
          <span>
            Step {step + 1} Of {STEPS.length}
          </span>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className="primary"
              onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}
              disabled={Boolean(stepError)}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={finish}
              disabled={Boolean(stepError) || saving}
            >
              {saving ? 'Opening Club...' : 'Complete Opening Setup'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
