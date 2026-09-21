import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  LeaderboardPrize,
  LeaderboardPrizePlanKey,
  LeaderboardSettings,
} from '../../services/LeaderboardService';
import { LeaderboardService } from '../../services/LeaderboardService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import {
  MAX_PRIZE_PLAN_BUDGET,
  clampPrizeBudget,
  distributePrizeBudget,
  normalizeCustomPrizes,
  prizePlanLabel,
  scaleCustomPrizesToBudget,
  suggestedPrizeBudgets,
  totalPrizePlan,
} from '../../utils/leaderboardPrizePlans';
import './LeaderboardPrizeWizard.css';

interface LeaderboardPrizeWizardProps {
  isOpen: boolean;
  setup: LeaderboardSettings;
  onClose: () => void;
  onSaved: (setup: LeaderboardSettings) => void;
  /* A refused publish (a version conflict, a funding refusal, a lost
     response) means the snapshot the wizard was opened with may no longer be
     the club's current program. The page uses this to refetch the owner
     record when the dialog closes, so the next attempt starts from truth. */
  onSaveError?: (error: Error) => void;
}

/* The two refusals the publish RPC raises on purpose, restated for the owner.
   The funding refusal carries both amounts with two decimals ("Requires
   1000000.00 Promo Chips But Only 250000.00 Are Available ..."): a seven-digit
   figure trips the house sanitiser, which would swap the reason for a generic
   line exactly for the largest clubs, and forward-facing copy never prints
   decimals. Neither restatement re-prices anything: closing the wizard
   refetches the owner record, and the reopened plan step shows the current
   capacity and version. Everything else goes through the house sanitiser. */
const FUNDING_REFUSAL =
  /Leaderboard Prize Program Requires .+ Promo Chips But Only .+ Are Available/i;
const VERSION_REFUSAL = /Leaderboard Prize Setup Changed In Another Session/i;

function describeSaveError(error: Error, fundingLabel: string): string {
  if (FUNDING_REFUSAL.test(error.message)) {
    return `${fundingLabel} No Longer Covers This Plan After Other Published Commitments. Close And Reopen To See The Current Capacity.`;
  }
  if (VERSION_REFUSAL.test(error.message)) {
    return 'This Prize Setup Changed In Another Session. Close And Reopen To Load The Current Version.';
  }
  return safeErrorMessage(error, 'Prize Setup Could Not Be Saved');
}

const METRICS: Array<{ value: LeaderboardSettings['payout_metric']; label: string }> = [
  { value: 'profit', label: 'Profit' },
  { value: 'hands_played', label: 'Hands Played' },
  { value: 'tournaments_won', label: 'Tournaments Won' },
  { value: 'roi', label: 'Return On Investment' },
];

const PLAN_KEYS: Array<Exclude<LeaderboardPrizePlanKey, 'custom'>> = [
  'balanced',
  'top_heavy',
  'even',
];

function editableRows(prizes: LeaderboardPrize[]): LeaderboardPrize[] {
  return Array.from({ length: 5 }, (_, index) => ({
    rank: index + 1,
    amount: prizes.find((prize) => prize.rank === index + 1)?.amount || 0,
  }));
}

export function LeaderboardPrizeWizard({
  isOpen,
  setup,
  onClose,
  onSaved,
  onSaveError,
}: LeaderboardPrizeWizardProps) {
  const dialogRef = useFocusTrap(isOpen);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [enabled, setEnabled] = useState(setup.rewards_enabled);
  const [metric, setMetric] = useState(setup.payout_metric);
  const [planKey, setPlanKey] = useState<LeaderboardPrizePlanKey>(setup.suggestion_key);
  const [weeklyPrizes, setWeeklyPrizes] = useState<LeaderboardPrize[]>(setup.weekly_prizes);
  const [monthlyPrizes, setMonthlyPrizes] = useState<LeaderboardPrize[]>(setup.monthly_prizes);
  const [weeklyBudget, setWeeklyBudget] = useState(totalPrizePlan(setup.weekly_prizes));
  const [monthlyBudget, setMonthlyBudget] = useState(totalPrizePlan(setup.monthly_prizes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const suggested = suggestedPrizeBudgets(setup.available_balance);
    const initialKey = setup.setup_complete ? setup.suggestion_key : 'balanced';
    const initialWeekly = setup.weekly_prizes.length
      ? setup.weekly_prizes
      : distributePrizeBudget(suggested.weekly, 'balanced');
    const initialMonthly = setup.monthly_prizes.length
      ? setup.monthly_prizes
      : distributePrizeBudget(suggested.monthly, 'balanced');
    setStep(0);
    setEnabled(setup.rewards_enabled);
    setMetric(setup.payout_metric);
    setPlanKey(initialKey);
    setWeeklyPrizes(initialWeekly);
    setMonthlyPrizes(initialMonthly);
    setWeeklyBudget(totalPrizePlan(initialWeekly));
    setMonthlyBudget(totalPrizePlan(initialMonthly));
    setSaving(false);
    setError(null);
  }, [isOpen, setup]);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [isOpen, onClose, saving]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => stepHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, step]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const selectedPlan = planKey === 'custom' ? null : planKey;
  const weeklyTotal = totalPrizePlan(weeklyPrizes);
  const monthlyTotal = totalPrizePlan(monthlyPrizes);
  const proposedCommitment = enabled ? weeklyTotal + monthlyTotal : 0;
  const publicationCapacity = setup.publication_capacity ?? setup.available_balance;
  const projectedUncommitted =
    publicationCapacity == null ? null : Math.max(publicationCapacity - proposedCommitment, 0);
  const hasPrizes = weeklyTotal > 0 || monthlyTotal > 0;
  const exceedsAvailable = publicationCapacity != null && proposedCommitment > publicationCapacity;

  const sourceDescription =
    setup.funding_owner_type === 'union'
      ? `${setup.union_name || 'The Union'} Controls This Club's Leaderboard Rewards.`
      : `${setup.club_name} Is Standalone, So Its Club Promo Wallet Is The Funding Source.`;

  const applyPlan = (nextPlan: Exclude<LeaderboardPrizePlanKey, 'custom'>) => {
    setPlanKey(nextPlan);
    setWeeklyPrizes(distributePrizeBudget(weeklyBudget, nextPlan));
    setMonthlyPrizes(distributePrizeBudget(monthlyBudget, nextPlan));
  };

  const disableRewards = () => {
    setEnabled(false);
    if (setup.setup_complete) return;
    setWeeklyPrizes([]);
    setMonthlyPrizes([]);
    setWeeklyBudget(0);
    setMonthlyBudget(0);
  };

  const updateBudget = (period: 'weekly' | 'monthly', rawValue: string) => {
    const budget = clampPrizeBudget(Number(rawValue));
    if (period === 'weekly') {
      setWeeklyBudget(budget);
      setWeeklyPrizes((current) =>
        selectedPlan
          ? distributePrizeBudget(budget, selectedPlan)
          : scaleCustomPrizesToBudget(current, budget)
      );
    } else {
      setMonthlyBudget(budget);
      setMonthlyPrizes((current) =>
        selectedPlan
          ? distributePrizeBudget(budget, selectedPlan)
          : scaleCustomPrizesToBudget(current, budget)
      );
    }
  };

  const updateCustomPrize = (period: 'weekly' | 'monthly', rank: number, rawValue: string) => {
    const amount = clampPrizeBudget(Number(rawValue));
    setPlanKey('custom');
    const setRows = period === 'weekly' ? setWeeklyPrizes : setMonthlyPrizes;
    const current = period === 'weekly' ? weeklyPrizes : monthlyPrizes;
    const rows = editableRows(current).map((row) => (row.rank === rank ? { rank, amount } : row));
    setRows(normalizeCustomPrizes(rows));
    const total = totalPrizePlan(rows);
    if (period === 'weekly') setWeeklyBudget(total);
    else setMonthlyBudget(total);
  };

  const save = async () => {
    if (saving || (enabled && (!hasPrizes || exceedsAvailable))) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await LeaderboardService.saveLeaderboardRewardSetup(setup.club_id, {
        rewards_enabled: enabled,
        payout_metric: metric,
        weekly_prizes: normalizeCustomPrizes(weeklyPrizes),
        monthly_prizes: normalizeCustomPrizes(monthlyPrizes),
        suggestion_key: planKey,
        program_version: setup.program_version,
      });
      onSaved(saved);
    } catch (saveError) {
      const failure =
        saveError instanceof Error ? saveError : new Error('Prize Setup Could Not Be Saved');
      setError(describeSaveError(failure, setup.funding_label));
      onSaveError?.(failure);
    } finally {
      setSaving(false);
    }
  };

  const steps = useMemo(() => ['Reward Decision', 'Funding Source', 'Prize Plan', 'Review'], []);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="lb-prize-wizard-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="lb-prize-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lb-prize-wizard-title"
      >
        <SpadeConsole
          crest="flat"
          eyebrow="Prize Program"
          title="Leaderboard Prize Setup"
          titleId="lb-prize-wizard-title"
          subtitle={setup.club_name}
          pill={`${step + 1} Of 4`}
          plates={{
            secondary: {
              label: step === 0 ? 'Cancel' : 'Back',
              onClick: step === 0 ? onClose : () => setStep(step === 3 && !enabled ? 0 : step - 1),
              disabled: saving,
            },
            primary:
              step < 3
                ? {
                    label: step === 0 && !enabled ? 'Review Plan' : 'Continue',
                    'aria-label': step === 0 && !enabled ? 'Review Disabled Plan' : 'Continue',
                    onClick: () => setStep(step === 0 && !enabled ? 3 : step + 1),
                    disabled: step === 2 && enabled && (!hasPrizes || exceedsAvailable),
                  }
                : {
                    label: saving ? 'Publishing...' : 'Publish Plan',
                    'aria-label': saving ? 'Publishing Prize Program' : 'Publish Prize Program',
                    onClick: save,
                    disabled: saving || (enabled && (!hasPrizes || exceedsAvailable)),
                  },
          }}
        >
          <div className="lb-prize-close">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label="Close Prize Setup"
            >
              Close
            </button>
          </div>

          <ol className="lb-prize-progress" aria-label="Setup Progress">
            {steps.map((label, index) => (
              <li
                key={label}
                className={index === step ? 'active' : index < step ? 'complete' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{index + 1}</span>
                <strong>{label}</strong>
              </li>
            ))}
          </ol>

          <div className="lb-prize-wizard-body">
            {step === 0 && (
              <div className="lb-prize-step">
                <span className="lb-prize-step-number">Step One</span>
                <h3 ref={stepHeadingRef} tabIndex={-1}>
                  Do You Want To Reward Leaderboard Prizes?
                </h3>
                <p>
                  The Plan Appears On The Live Board. Saving This Setup Never Moves Chips Or Pays A
                  Player.
                </p>
                <div className="lb-prize-choice-grid">
                  <button
                    type="button"
                    className={enabled ? 'selected' : ''}
                    onClick={() => setEnabled(true)}
                    aria-pressed={enabled}
                  >
                    <strong>Yes, Show Prizes</strong>
                    <span>Publish Weekly Or Monthly Prize Rows.</span>
                  </button>
                  <button
                    type="button"
                    className={!enabled ? 'selected' : ''}
                    onClick={disableRewards}
                    aria-pressed={!enabled}
                  >
                    <strong>No Prizes Right Now</strong>
                    <span>Keep The Rankings Competitive Without A Reward Plan.</span>
                  </button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="lb-prize-step">
                <span className="lb-prize-step-number">Step Two</span>
                <h3 ref={stepHeadingRef} tabIndex={-1}>
                  Funding Source Confirmed
                </h3>
                <div className="lb-prize-source-card">
                  <div>
                    <span>Prize Source</span>
                    <strong>{setup.funding_label}</strong>
                    <p>{sourceDescription}</p>
                  </div>
                  <div className="lb-prize-balance">
                    <span>Publication Capacity</span>
                    <strong>
                      {publicationCapacity == null
                        ? 'Protected'
                        : compactChips(publicationCapacity)}
                    </strong>
                    <small>Promo Chips</small>
                  </div>
                </div>
                {setup.can_manage && (
                  <dl className="lb-prize-funding-grid" aria-label="Funding Commitment Summary">
                    <div>
                      <dt>Promo Wallet</dt>
                      <dd>{compactChips(setup.wallet_balance)} Chips</dd>
                    </div>
                    <div>
                      <dt>Published Commitments</dt>
                      <dd>{compactChips(setup.committed_balance)} Chips</dd>
                    </div>
                    <div>
                      <dt>Other Club Commitments</dt>
                      <dd>{compactChips(setup.other_program_commitments)} Chips</dd>
                    </div>
                    <div>
                      <dt>Committed Clubs</dt>
                      <dd>{(setup.committed_club_count ?? 0).toLocaleString('en-US')}</dd>
                    </div>
                  </dl>
                )}
                <div className="lb-prize-safety-note" role="note">
                  <strong>Source Is Automatic.</strong>
                  <span>
                    An Affiliated Club Cannot Select Its Own Wallet. A Standalone Club Cannot Select
                    A Union Wallet.
                  </span>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="lb-prize-step">
                <span className="lb-prize-step-number">Step Three</span>
                <h3 ref={stepHeadingRef} tabIndex={-1}>
                  Build The Prize Board
                </h3>
                <label className="lb-prize-field">
                  <span>Ranking Signal</span>
                  <select
                    value={metric}
                    onChange={(event) => setMetric(event.target.value as typeof metric)}
                  >
                    {METRICS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="lb-prize-plan-buttons" aria-label="Suggested Prize Splits">
                  {PLAN_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={planKey === key ? 'selected' : ''}
                      onClick={() => applyPlan(key)}
                      aria-pressed={planKey === key}
                    >
                      <strong>{prizePlanLabel(key)}</strong>
                      <span>
                        {key === 'balanced'
                          ? '50 / 30 / 20'
                          : key === 'top_heavy'
                            ? '65 / 25 / 10'
                            : 'Equal Top Three'}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className={planKey === 'custom' ? 'selected' : ''}
                    onClick={() => setPlanKey('custom')}
                    aria-pressed={planKey === 'custom'}
                  >
                    <strong>Custom</strong>
                    <span>Edit Up To Five Places.</span>
                  </button>
                </div>

                <div className="lb-prize-period-grid">
                  {(['weekly', 'monthly'] as const).map((rewardPeriod) => {
                    const prizes = rewardPeriod === 'weekly' ? weeklyPrizes : monthlyPrizes;
                    const budget = rewardPeriod === 'weekly' ? weeklyBudget : monthlyBudget;
                    return (
                      <fieldset key={rewardPeriod}>
                        <legend>
                          {rewardPeriod === 'weekly' ? 'Weekly Prizes' : 'Monthly Prizes'}
                        </legend>
                        <label className="lb-prize-field">
                          <span>Prize Budget</span>
                          <input
                            type="number"
                            min="0"
                            max={MAX_PRIZE_PLAN_BUDGET}
                            step="0.01"
                            inputMode="decimal"
                            value={budget || ''}
                            onChange={(event) => updateBudget(rewardPeriod, event.target.value)}
                          />
                        </label>
                        <div className="lb-prize-rank-list">
                          {editableRows(prizes).map((row) => (
                            <label key={row.rank}>
                              <span>Rank {row.rank}</span>
                              <input
                                type="number"
                                min="0"
                                max={MAX_PRIZE_PLAN_BUDGET}
                                step="0.01"
                                inputMode="decimal"
                                value={row.amount || ''}
                                onChange={(event) =>
                                  updateCustomPrize(rewardPeriod, row.rank, event.target.value)
                                }
                                aria-label={`${rewardPeriod === 'weekly' ? 'Weekly' : 'Monthly'} Prize For Rank ${row.rank}`}
                              />
                            </label>
                          ))}
                        </div>
                        <div className="lb-prize-total">
                          <span>Total Planned</span>
                          <strong>{compactChips(totalPrizePlan(prizes))}</strong>
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
                {enabled && !hasPrizes && (
                  <div className="lb-prize-inline-error" role="alert">
                    Add A Weekly Or Monthly Prize Before Continuing.
                  </div>
                )}
                {exceedsAvailable && (
                  <div className="lb-prize-inline-error" role="alert">
                    This Plan Cannot Be Published. Reduce The Combined Weekly And Monthly Commitment
                    To {compactChips(publicationCapacity)} Promo Chips Or Less.
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="lb-prize-step">
                <span className="lb-prize-step-number">Step Four</span>
                <h3 ref={stepHeadingRef} tabIndex={-1}>
                  Review The Published Plan
                </h3>
                <dl className="lb-prize-review">
                  <div>
                    <dt>Status</dt>
                    <dd>{enabled ? 'Prizes Enabled' : 'Prizes Disabled'}</dd>
                  </div>
                  <div>
                    <dt>Funding Source</dt>
                    <dd>{setup.funding_label}</dd>
                  </div>
                  <div>
                    <dt>Ranking Signal</dt>
                    <dd>{METRICS.find((option) => option.value === metric)?.label}</dd>
                  </div>
                  <div>
                    <dt>Prize Split</dt>
                    <dd>{prizePlanLabel(planKey)}</dd>
                  </div>
                  <div>
                    <dt>Weekly Total</dt>
                    <dd>{compactChips(weeklyTotal)} Chips</dd>
                  </div>
                  <div>
                    <dt>Monthly Total</dt>
                    <dd>{compactChips(monthlyTotal)} Chips</dd>
                  </div>
                  <div>
                    <dt>Combined Commitment</dt>
                    <dd>{compactChips(proposedCommitment)} Chips</dd>
                  </div>
                  <div>
                    <dt>Uncommitted After Publication</dt>
                    <dd>
                      {projectedUncommitted == null
                        ? 'Protected'
                        : `${compactChips(projectedUncommitted)} Chips`}
                    </dd>
                  </div>
                </dl>
                <div className="lb-prize-safety-note" role="note">
                  <strong>Starts Next Period</strong>
                  <span>
                    Current Standings Keep Their Published Rules. This Becomes Program Version{' '}
                    {setup.program_version + 1} At The Next Weekly And Monthly UTC Boundaries.
                  </span>
                </div>
                <div className="lb-prize-safety-note" role="note">
                  <strong>Publication Claims Funding Capacity.</strong>
                  <span>
                    Publishing Does Not Move Chips. The Service-Only Settlement Process Debits The
                    Recorded Promo Wallet And Writes Immutable Payout Evidence After The Period
                    Closes.
                  </span>
                </div>
                {error && (
                  <div className="lb-prize-inline-error" role="alert">
                    {error}
                  </div>
                )}
              </div>
            )}
          </div>
        </SpadeConsole>
      </section>
    </div>,
    document.body
  );
}

export default LeaderboardPrizeWizard;
