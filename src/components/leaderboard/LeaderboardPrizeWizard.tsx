import { useEffect, useMemo, useState } from 'react';
import type {
  LeaderboardPrize,
  LeaderboardPrizePlanKey,
  LeaderboardSettings,
} from '../../services/LeaderboardService';
import { LeaderboardService } from '../../services/LeaderboardService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  distributePrizeBudget,
  normalizeCustomPrizes,
  prizePlanLabel,
  suggestedPrizeBudgets,
  totalPrizePlan,
} from '../../utils/leaderboardPrizePlans';
import './LeaderboardPrizeWizard.css';

interface LeaderboardPrizeWizardProps {
  isOpen: boolean;
  setup: LeaderboardSettings;
  onClose: () => void;
  onSaved: (setup: LeaderboardSettings) => void;
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
}: LeaderboardPrizeWizardProps) {
  const dialogRef = useFocusTrap(isOpen);
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

  const selectedPlan = planKey === 'custom' ? null : planKey;
  const weeklyTotal = totalPrizePlan(weeklyPrizes);
  const monthlyTotal = totalPrizePlan(monthlyPrizes);
  const hasPrizes = weeklyTotal > 0 || monthlyTotal > 0;
  const exceedsAvailable =
    setup.available_balance != null &&
    (weeklyTotal > setup.available_balance || monthlyTotal > setup.available_balance);

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
    const budget = Math.max(0, Math.round((Number(rawValue) || 0) * 100) / 100);
    if (period === 'weekly') {
      setWeeklyBudget(budget);
      if (selectedPlan) setWeeklyPrizes(distributePrizeBudget(budget, selectedPlan));
    } else {
      setMonthlyBudget(budget);
      if (selectedPlan) setMonthlyPrizes(distributePrizeBudget(budget, selectedPlan));
    }
  };

  const updateCustomPrize = (period: 'weekly' | 'monthly', rank: number, rawValue: string) => {
    const amount = Math.max(0, Math.round((Number(rawValue) || 0) * 100) / 100);
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
    if (saving || (enabled && !hasPrizes)) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await LeaderboardService.saveLeaderboardRewardSetup(setup.club_id, {
        rewards_enabled: enabled,
        payout_metric: metric,
        weekly_prizes: normalizeCustomPrizes(weeklyPrizes),
        monthly_prizes: normalizeCustomPrizes(monthlyPrizes),
        suggestion_key: planKey,
      });
      onSaved(saved);
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : 'Prize Setup Could Not Be Saved';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const steps = useMemo(() => ['Reward Decision', 'Funding Source', 'Prize Plan', 'Review'], []);

  if (!isOpen) return null;

  return (
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
        <header className="lb-prize-wizard-header">
          <div>
            <span className="lb-prize-kicker">Owner Prize Circuit</span>
            <h2 id="lb-prize-wizard-title">Leaderboard Prize Setup</h2>
            <p>{setup.club_name}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close Prize Setup">
            Close
          </button>
        </header>

        <ol className="lb-prize-progress" aria-label="Setup Progress">
          {steps.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''}>
              <span>{index + 1}</span>
              <strong>{label}</strong>
            </li>
          ))}
        </ol>

        <div className="lb-prize-wizard-body">
          {step === 0 && (
            <div className="lb-prize-step">
              <span className="lb-prize-step-number">Step One</span>
              <h3>Do You Want To Reward Leaderboard Prizes?</h3>
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
              <h3>Funding Source Confirmed</h3>
              <div className="lb-prize-source-card">
                <span className="lb-prize-source-mark" aria-hidden="true">
                  ◆
                </span>
                <div>
                  <span>Prize Source</span>
                  <strong>{setup.funding_label}</strong>
                  <p>{sourceDescription}</p>
                </div>
                <div className="lb-prize-balance">
                  <span>Available</span>
                  <strong>
                    {setup.available_balance == null
                      ? 'Protected'
                      : setup.available_balance.toLocaleString('en-US', {
                          maximumFractionDigits: 2,
                        })}
                  </strong>
                  <small>Promo Chips</small>
                </div>
              </div>
              <div className="lb-prize-safety-note" role="note">
                <strong>Source Is Automatic.</strong>
                <span>
                  An Affiliated Club Cannot Select Its Own Wallet. A Standalone Club Cannot Select A
                  Union Wallet.
                </span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="lb-prize-step">
              <span className="lb-prize-step-number">Step Three</span>
              <h3>Build The Prize Board</h3>
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
                              step="0.01"
                              inputMode="decimal"
                              value={row.amount || ''}
                              onChange={(event) =>
                                updateCustomPrize(rewardPeriod, row.rank, event.target.value)
                              }
                              aria-label={`${rewardPeriod} prize for rank ${row.rank}`}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="lb-prize-total">
                        <span>Total Planned</span>
                        <strong>{totalPrizePlan(prizes).toLocaleString('en-US')}</strong>
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
                <div className="lb-prize-inline-warning" role="status">
                  A Planned Period Is Larger Than The Current Promo Balance. The Plan Can Be Saved,
                  But It Is Not Funded Yet.
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="lb-prize-step">
              <span className="lb-prize-step-number">Step Four</span>
              <h3>Review The Published Plan</h3>
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
                  <dd>{weeklyTotal.toLocaleString('en-US')} Chips</dd>
                </div>
                <div>
                  <dt>Monthly Total</dt>
                  <dd>{monthlyTotal.toLocaleString('en-US')} Chips</dd>
                </div>
              </dl>
              <div className="lb-prize-safety-note" role="note">
                <strong>Planning And Display Only.</strong>
                <span>
                  This Setup Does Not Debit The Promo Wallet. Automated Payouts Remain Protected
                  Until The Platform Has A Canonical Batch Transfer With Full Idempotency And Ledger
                  Coverage.
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

        <footer className="lb-prize-wizard-footer">
          <button
            type="button"
            onClick={step === 0 ? onClose : () => setStep((value) => value - 1)}
            disabled={saving}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < 3 ? (
            <button
              type="button"
              className="primary"
              onClick={() => setStep(step === 0 && !enabled ? 3 : step + 1)}
              disabled={step === 2 && enabled && !hasPrizes}
            >
              {step === 0 && !enabled ? 'Review Disabled Plan' : 'Continue'}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={save}
              disabled={saving || (enabled && !hasPrizes)}
            >
              {saving ? 'Saving Prize Setup' : 'Save Prize Setup'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

export default LeaderboardPrizeWizard;
