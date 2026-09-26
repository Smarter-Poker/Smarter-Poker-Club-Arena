import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  LeaderboardPrize,
  LeaderboardPrizePlanKey,
  LeaderboardSettings,
} from '../../services/LeaderboardService';
import { LeaderboardService } from '../../services/LeaderboardService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { SpadeConsole } from '../console/SpadeConsole';
import { Toggle } from '../table-config/controls';
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

/** Another club of the same union whose prizes this owner manages. */
export interface LeaderboardTemplateClub {
  club_id: string;
  club_name: string;
}

/** What happened when the plan was sent to one template club. */
export interface LeaderboardTemplateResult extends LeaderboardTemplateClub {
  ok: boolean;
  message: string;
}

interface LeaderboardPrizeWizardProps {
  isOpen: boolean;
  setup: LeaderboardSettings;
  onClose: () => void;
  /* templateResults is present only when the plan was also sent to other
     union clubs, so a single-club publish keeps its original call shape. */
  onSaved: (setup: LeaderboardSettings, templateResults?: LeaderboardTemplateResult[]) => void;
  /* Union template targets: the other clubs of this union the owner manages.
     Empty for a standalone club. */
  templateClubs?: LeaderboardTemplateClub[];
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

function describeSaveError(
  error: Error,
  fundingLabel: string,
  context: 'setup' | 'template' = 'setup'
): string {
  // In the template results the next step is Retry Refused, which re-reads
  // that club's current version and capacity first; in the setup itself it is
  // reopening the setup, which refetches the owner record.
  if (FUNDING_REFUSAL.test(error.message)) {
    return context === 'template'
      ? `${fundingLabel} Cannot Cover This Club's Plan After Other Published Commitments.`
      : `${fundingLabel} No Longer Covers This Plan After Other Published Commitments. Close And Reopen To See The Current Capacity.`;
  }
  if (VERSION_REFUSAL.test(error.message)) {
    return context === 'template'
      ? "This Club's Prize Setup Changed In Another Session."
      : 'This Prize Setup Changed In Another Session. Close And Reopen To Load The Current Version.';
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

const NO_TEMPLATE_CLUBS: LeaderboardTemplateClub[] = [];

function editableRows(prizes: LeaderboardPrize[]): LeaderboardPrize[] {
  return Array.from({ length: 5 }, (_, index) => ({
    rank: index + 1,
    amount: prizes.find((prize) => prize.rank === index + 1)?.amount || 0,
  }));
}

/**
 * A budget or a place amount as whole chips (2026-09-23). The owner types
 * chips, and a forward-facing figure never carries decimals, so whatever is
 * typed is floored to a whole chip: the wizard never publishes more than the
 * owner entered.
 */
function wholeChips(value: number | string): number {
  return Math.floor(clampPrizeBudget(Number(value)));
}

/**
 * WHOLE CHIPS THAT ADD UP TO EXACTLY THE BUDGET (2026-09-23).
 *
 * The shared plan helpers split in cents: a 101-chip Balanced Podium is
 * 50.50 / 30.30 / 20.20 and a 100-chip Even Podium is 33.33 / 33.33 / 33.34,
 * and those decimals were printed in the place fields and published. Every
 * place now keeps its whole-chip floor, and the few chips that leaves over go
 * one each to the places with the largest remainder (the ordinary way to
 * round shares to whole units). The helpers push their cent residue onto the
 * last place, so remainders within a cent of the largest are a tie, and a tie
 * goes to the better place: the odd chip goes to first, as at a poker table.
 * The result always sums to the whole budget, and it is the exact list the
 * wizard shows and then publishes (the component keeps the cent split only as
 * the shape a later budget is scaled from).
 */
function wholeChipPrizes(prizes: LeaderboardPrize[], budget: number): LeaderboardPrize[] {
  const target = wholeChips(budget);
  const rows = normalizeCustomPrizes(prizes);
  if (target === 0 || rows.length === 0) return [];
  const whole = rows.map((row) => Math.floor(row.amount));
  const remainder = rows.map((row, index) => Math.round((row.amount - whole[index]) * 100));
  const given = new Set<number>();
  let left = target - whole.reduce((sum, amount) => sum + amount, 0);
  while (left > 0) {
    const open = remainder
      .map((cents, index) => ({ cents, index }))
      .filter(({ index }) => !given.has(index));
    const best = Math.max(...open.map((row) => row.cents));
    // Cannot run dry (the floors lose less than one chip per place); if it
    // ever did, the chip goes to first place rather than out of the total.
    const pick = open.find(({ cents }) => cents >= best - 1)?.index ?? 0;
    given.add(pick);
    whole[pick] += 1;
    left -= 1;
  }
  // A budget below the places' own floors (no caller passes one) comes off
  // the lowest places, so the list still never exceeds the budget.
  for (let index = whole.length - 1; left < 0 && index >= 0; index -= 1) {
    const take = Math.min(whole[index], -left);
    whole[index] -= take;
    left += take;
  }
  return rows
    .map((row, index) => ({ rank: row.rank, amount: whole[index] }))
    .filter((row) => row.amount > 0);
}

/**
 * EXACT FIGURES WHERE THE OWNER IS CONFIRMING MONEY (lead ruling, 2026-09-20).
 * compactChips() is the house format for a glance ("12.3K"), and it is used
 * for every balance here. A figure the owner is agreeing to publish, or a
 * limit they must type a plan under, is printed whole with separators and is
 * never abbreviated. Floored: a plan is whole chips, so the largest plan a
 * capacity of 100.50 allows is 100.
 */
function exactChips(value: number | null | undefined): string {
  return Math.floor(Math.max(Number(value) || 0, 0)).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  });
}

/**
 * WHAT HAPPENS WHEN THE PROMO WALLET FALLS SHORT: the one place it is said.
 *
 * Settlement pays a closed round in full or not at all (fn_payout_leaderboard,
 * 20260923143157): a standalone club's round from any leftover opening prize
 * seed first, then its recorded Promo Wallet; a union's round from the union
 * Promo Wallet alone. A round they cannot cover is left unpaid, no winner is
 * partly paid, and the daily settlement run retries it.
 *
 * THE CLUB BANK OVERLAY (20260923143157). A paid standalone club program also
 * carries the owner's explicit answer, per published version, to one question:
 * may the club's own Club Bank cover a shortfall? It is Off unless chosen
 * (leaderboard_reward_program_versions.overlay_enabled, default false), so for
 * that program this row is the labelled On/Off Toggle from table-config/controls,
 * and planPayload() sends the answer with every publication: a republish from
 * here keeps an owner's earlier On instead of silently turning it Off.
 *   On:  when the seed and the Promo Wallet together hold less than the round,
 *        the Club Bank pays only the missing chips, as its own overlay leg
 *        (journal category overlay, recorded on the batch as overlay_funded).
 *        A Club Bank that cannot hold the whole shortfall pays nothing, and the
 *        round stays unpaid and is retried, exactly as with the answer Off.
 *   Off: the Club Bank is never debited.
 * A union program cannot carry the opt-in (a table CHECK and the publication
 * RPC both refuse it), so a union-funded program keeps the fixed row, and no
 * bank is ever used. Either way publication is checked against the Promo
 * Wallet alone: the overlay covers a later round's shortfall, it is never
 * capacity to publish against.
 */
function shortfallRule(ownerType: LeaderboardSettings['funding_owner_type'], overlayOn: boolean) {
  if (ownerType !== 'club') {
    return {
      label: 'If Promo Falls Short',
      value: 'Round Waits Unpaid',
      note: 'A Closed Round Is Paid In Full Or Not At All. If The Union Promo Wallet Holds Less Than The Prizes, No Winner Is Paid, The Round Stays Unpaid, And The Daily Settlement Run Retries It Until The Wallet Covers It. The Union Bank And Club Banks Are Never Used.',
    };
  }
  return {
    label: 'Club Bank Covers Shortfalls',
    value: overlayOn ? 'On' : 'Off',
    note: overlayOn
      ? 'A Closed Round Is Paid In Full Or Not At All. Any Leftover Opening Prize Seed Pays First, Then The Promo Wallet. If They Together Hold Less Than The Prizes, The Club Bank Pays Only The Missing Chips, As A Separate Overlay Entry. If The Club Bank Cannot Cover All Of Them Either, No Winner Is Paid, The Round Stays Unpaid, And The Daily Settlement Run Retries It.'
      : 'A Closed Round Is Paid In Full Or Not At All. If Any Leftover Opening Prize Seed And The Promo Wallet Together Hold Less Than The Prizes, No Winner Is Paid, The Round Stays Unpaid, And The Daily Settlement Run Retries It Until They Cover It. The Club Bank Is Never Used.',
  };
}

export function LeaderboardPrizeWizard({
  isOpen,
  setup,
  onClose,
  onSaved,
  onSaveError,
  templateClubs = NO_TEMPLATE_CLUBS,
}: LeaderboardPrizeWizardProps) {
  const dialogRef = useFocusTrap(isOpen);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [enabled, setEnabled] = useState(setup.rewards_enabled);
  /* The owner's Club Bank overlay answer, as the current program carries it
     (Off unless it was chosen). Only a paid standalone club program sends it. */
  const [overlayEnabled, setOverlayEnabled] = useState(setup.overlay_enabled === true);
  const [metric, setMetric] = useState(setup.payout_metric);
  const [planKey, setPlanKey] = useState<LeaderboardPrizePlanKey>(setup.suggestion_key);
  const [weeklyPrizes, setWeeklyPrizes] = useState<LeaderboardPrize[]>(setup.weekly_prizes);
  const [monthlyPrizes, setMonthlyPrizes] = useState<LeaderboardPrize[]>(setup.monthly_prizes);
  /* The prize state is the SHAPE of each split, as the plan helpers produce it
     (cents); the budget is whole chips. What is shown and published is the
     whole-chip projection below, never the shape itself. */
  const [weeklyBudget, setWeeklyBudget] = useState(wholeChips(totalPrizePlan(setup.weekly_prizes)));
  const [monthlyBudget, setMonthlyBudget] = useState(
    wholeChips(totalPrizePlan(setup.monthly_prizes))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateTargets, setTemplateTargets] = useState<string[]>([]);
  const [templateResults, setTemplateResults] = useState<LeaderboardTemplateResult[] | null>(null);
  // The edited club's saved record while template results are on screen: the
  // page receives it when the owner is done reading them.
  const [publishedSetup, setPublishedSetup] = useState<LeaderboardSettings | null>(null);
  const showingResults = templateResults !== null;

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
    setOverlayEnabled(setup.overlay_enabled === true);
    setMetric(setup.payout_metric);
    setPlanKey(initialKey);
    setWeeklyPrizes(initialWeekly);
    setMonthlyPrizes(initialMonthly);
    // A program published before whole chips carries cent amounts; its budget
    // is its own whole total, and it is shown and republished as whole chips.
    setWeeklyBudget(wholeChips(totalPrizePlan(initialWeekly)));
    setMonthlyBudget(wholeChips(totalPrizePlan(initialMonthly)));
    setSaving(false);
    setError(null);
    setTemplateTargets([]);
    setTemplateResults(null);
    setPublishedSetup(null);
  }, [isOpen, setup]);

  // Once the edited club is published, leaving the dialog by any route hands
  // the page that saved record; plain Close would drop it.
  const finish = useCallback(() => {
    if (publishedSetup) onSaved(publishedSetup, templateResults ?? []);
  }, [onSaved, publishedSetup, templateResults]);
  const dismiss = publishedSetup ? finish : onClose;

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) dismiss();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [isOpen, dismiss, saving]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => stepHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, step, showingResults]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const selectedPlan = planKey === 'custom' ? null : planKey;
  /* WHAT THE OWNER SEES IS WHAT IS PUBLISHED. Each split's whole-chip
     projection is the list the place fields show, the review prints and
     planPayload() sends. Keeping the shape underneath means a budget typed a
     digit at a time rescales the owner's split, not whatever a two-chip
     intermediate budget had rounded it to. */
  const weeklyPlaces = useMemo(
    () => wholeChipPrizes(weeklyPrizes, weeklyBudget),
    [weeklyPrizes, weeklyBudget]
  );
  const monthlyPlaces = useMemo(
    () => wholeChipPrizes(monthlyPrizes, monthlyBudget),
    [monthlyPrizes, monthlyBudget]
  );
  const weeklyTotal = totalPrizePlan(weeklyPlaces);
  const monthlyTotal = totalPrizePlan(monthlyPlaces);
  const proposedCommitment = enabled ? weeklyTotal + monthlyTotal : 0;
  const publicationCapacity = setup.publication_capacity ?? setup.available_balance;
  const projectedUncommitted =
    publicationCapacity == null ? null : Math.max(publicationCapacity - proposedCommitment, 0);
  const hasPrizes = weeklyTotal > 0 || monthlyTotal > 0;
  const exceedsAvailable = publicationCapacity != null && proposedCommitment > publicationCapacity;

  /* Where prize chips come from, exactly as the SQL does it. Publication is
     checked against the Promo Wallet alone (20260906003717); a standalone
     club's settlement draws any leaderboard prize seed left from its opening
     before its Promo Wallet (20260906084547), and a union batch has no seed. */
  const sourceDescription =
    setup.funding_owner_type === 'union'
      ? `This Club Belongs To ${setup.union_name || 'A Union'}, So The Union Promo Wallet Pays Its Leaderboard Prizes.`
      : `${setup.club_name} Is Standalone, So Its Promo Wallet Pays Its Leaderboard Prizes. Any Leaderboard Prize Seed Left From Opening Is Used First.`;
  /* The Club Bank overlay exists only on a paid standalone club program: the
     switch is offered there, the answer is printed there, and planPayload()
     sends it there. Everywhere else the row is fixed and no bank is used. */
  const offersOverlay = setup.funding_owner_type === 'club' && enabled;
  const overlayOn = offersOverlay && overlayEnabled;
  const shortfall = shortfallRule(setup.funding_owner_type, overlayOn);
  const placesLine = (prizes: LeaderboardPrize[]) =>
    prizes.length ? prizes.map((prize) => exactChips(prize.amount)).join(' / ') : 'None';

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
    const budget = wholeChips(rawValue);
    const split = (current: LeaderboardPrize[]) =>
      selectedPlan
        ? distributePrizeBudget(budget, selectedPlan)
        : scaleCustomPrizesToBudget(current, budget);
    if (period === 'weekly') {
      setWeeklyBudget(budget);
      setWeeklyPrizes(split);
    } else {
      setMonthlyBudget(budget);
      setMonthlyPrizes(split);
    }
  };

  const updateCustomPrize = (period: 'weekly' | 'monthly', rank: number, rawValue: string) => {
    const amount = wholeChips(rawValue);
    setPlanKey('custom');
    const setRows = period === 'weekly' ? setWeeklyPrizes : setMonthlyPrizes;
    // An edit starts from the places on screen, so every other place keeps
    // exactly the whole chips the owner is looking at.
    const current = period === 'weekly' ? weeklyPlaces : monthlyPlaces;
    const rows = editableRows(current).map((row) => (row.rank === rank ? { rank, amount } : row));
    setRows(normalizeCustomPrizes(rows));
    const total = totalPrizePlan(rows);
    if (period === 'weekly') setWeeklyBudget(total);
    else setMonthlyBudget(total);
  };

  const planPayload = () => ({
    rewards_enabled: enabled,
    payout_metric: metric,
    weekly_prizes: normalizeCustomPrizes(weeklyPlaces),
    monthly_prizes: normalizeCustomPrizes(monthlyPlaces),
    suggestion_key: planKey,
    overlay_enabled: setup.funding_owner_type === 'club' && enabled && overlayEnabled,
  });

  /* Sends the plan to one union sibling as that club's own next version. Its
     current record is read first: the expected version must be ITS version,
     the owner must still manage it, and it must still be funded by the same
     union (a club that left would otherwise receive a plan funded from its
     own wallet, which is not what the owner chose). The server remains the
     authority on funding, version and permission; a refusal is reported, not
     retried here. */
  const publishToTemplateClub = async (
    club: LeaderboardTemplateClub
  ): Promise<LeaderboardTemplateResult> => {
    const target = { club_id: club.club_id, club_name: club.club_name };
    try {
      const current = await LeaderboardService.getLeaderboardRewardSetup(club.club_id);
      if (!current.can_manage) {
        return { ...target, ok: false, message: 'You No Longer Manage Prizes For This Club.' };
      }
      if (current.funding_owner_type !== 'union' || current.union_id !== setup.union_id) {
        return { ...target, ok: false, message: 'This Club Is No Longer Funded By This Union.' };
      }
      const saved = await LeaderboardService.saveLeaderboardRewardSetup(club.club_id, {
        ...planPayload(),
        program_version: current.program_version,
      });
      return { ...target, ok: true, message: `Program V${saved.program_version} Published.` };
    } catch (targetError) {
      const failure =
        targetError instanceof Error ? targetError : new Error('Prize Setup Could Not Be Saved');
      return {
        ...target,
        ok: false,
        message: describeSaveError(failure, setup.funding_label, 'template'),
      };
    }
  };

  /* One club at a time, in the owner's order: each publication claims union
     wallet capacity, so the next club is checked against what is left. */
  const publishToTemplateClubs = async (
    clubs: LeaderboardTemplateClub[]
  ): Promise<LeaderboardTemplateResult[]> => {
    const results: LeaderboardTemplateResult[] = [];
    for (const club of clubs) {
      results.push(await publishToTemplateClub(club));
    }
    return results;
  };

  const save = async () => {
    if (saving || (enabled && (!hasPrizes || exceedsAvailable))) return;
    setSaving(true);
    setError(null);
    let saved: LeaderboardSettings;
    try {
      saved = await LeaderboardService.saveLeaderboardRewardSetup(setup.club_id, {
        ...planPayload(),
        program_version: setup.program_version,
      });
    } catch (saveError) {
      const failure =
        saveError instanceof Error ? saveError : new Error('Prize Setup Could Not Be Saved');
      setError(describeSaveError(failure, setup.funding_label));
      onSaveError?.(failure);
      setSaving(false);
      return;
    }

    const targets = templateClubs.filter((club) => templateTargets.includes(club.club_id));
    if (targets.length === 0) {
      setSaving(false);
      onSaved(saved);
      return;
    }
    const results = await publishToTemplateClubs(targets);
    setSaving(false);
    if (results.every((result) => result.ok)) {
      onSaved(saved, results);
      return;
    }
    setPublishedSetup(saved);
    setTemplateResults(results);
  };

  const retryRefused = async () => {
    if (saving || !templateResults) return;
    setSaving(true);
    const retried = await publishToTemplateClubs(templateResults.filter((result) => !result.ok));
    const byClub = new Map(retried.map((result) => [result.club_id, result]));
    setTemplateResults(templateResults.map((result) => byClub.get(result.club_id) ?? result));
    setSaving(false);
  };

  const steps = useMemo(() => ['Reward Decision', 'Funding Source', 'Prize Plan', 'Review'], []);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="lb-prize-wizard-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) dismiss();
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
          pill={showingResults ? 'Results' : `${step + 1} Of 4`}
          plates={{
            // Always exactly two painted plates: the results view swaps what
            // they do, never how many there are.
            secondary: templateResults
              ? {
                  label: saving ? 'Retrying...' : 'Retry Refused',
                  'aria-label': 'Retry Refused Clubs',
                  onClick: retryRefused,
                  disabled: saving || templateResults.every((result) => result.ok),
                }
              : {
                  label: step === 0 ? 'Cancel' : 'Back',
                  onClick:
                    step === 0 ? onClose : () => setStep(step === 3 && !enabled ? 0 : step - 1),
                  disabled: saving,
                },
            primary: templateResults
              ? {
                  label: 'Done',
                  'aria-label': 'Done With Template Results',
                  onClick: finish,
                  disabled: saving,
                }
              : step < 3
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
              onClick={dismiss}
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
                className={
                  showingResults
                    ? 'complete'
                    : index === step
                      ? 'active'
                      : index < step
                        ? 'complete'
                        : ''
                }
                aria-current={!showingResults && index === step ? 'step' : undefined}
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
                {offersOverlay ? (
                  <div role="group" aria-label="Shortfall Rule">
                    <Toggle
                      label="Club Bank Covers Shortfalls"
                      value={overlayEnabled}
                      onChange={setOverlayEnabled}
                      disabled={saving}
                    />
                  </div>
                ) : (
                  <dl className="lb-prize-rows" aria-label="Shortfall Rule">
                    <div>
                      <dt>{shortfall.label}</dt>
                      <dd>{shortfall.value}</dd>
                    </div>
                  </dl>
                )}
                <p className="lb-prize-rule-note">{shortfall.note}</p>
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

                <div
                  className="lb-prize-plan-buttons"
                  role="group"
                  aria-label="Suggested Prize Splits"
                >
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
                    const prizes = rewardPeriod === 'weekly' ? weeklyPlaces : monthlyPlaces;
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
                            step="1"
                            inputMode="numeric"
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
                                step="1"
                                inputMode="numeric"
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
                    To {exactChips(publicationCapacity)} Promo Chips Or Less.
                  </div>
                )}
              </div>
            )}

            {templateResults && publishedSetup && (
              <div className="lb-prize-step">
                <span className="lb-prize-step-number">Union Template</span>
                <h3 ref={stepHeadingRef} tabIndex={-1}>
                  Template Results
                </h3>
                <p>
                  {`${setup.club_name} Published Program V${publishedSetup.program_version}. Each Other Club Is Listed With What Happened.`}
                </p>
                <ul className="lb-prize-template-results" role="list" aria-live="polite">
                  {templateResults.map((result) => (
                    <li key={result.club_id} className={result.ok ? 'is-published' : 'is-refused'}>
                      <strong>{result.club_name}</strong>
                      <span>{result.message}</span>
                    </li>
                  ))}
                </ul>
                <div className="lb-prize-safety-note" role="note">
                  <strong>Nothing Was Rolled Back.</strong>
                  <span>
                    Every Published Club Keeps Its New Version. Retry Sends The Plan Again Only To
                    The Refused Clubs, Each Checked Against Its Current Version.
                  </span>
                </div>
              </div>
            )}

            {step === 3 && !templateResults && (
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
                  {/* The figures being published are exact; the balance after
                      them, below, is a glance and stays compact. */}
                  {enabled && (
                    <div>
                      <dt>Weekly Places</dt>
                      <dd>{placesLine(weeklyPlaces)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Weekly Total</dt>
                    <dd>{exactChips(weeklyTotal)} Chips</dd>
                  </div>
                  {enabled && (
                    <div>
                      <dt>Monthly Places</dt>
                      <dd>{placesLine(monthlyPlaces)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Monthly Total</dt>
                    <dd>{exactChips(monthlyTotal)} Chips</dd>
                  </div>
                  <div>
                    <dt>Combined Commitment</dt>
                    <dd>{exactChips(proposedCommitment)} Chips</dd>
                  </div>
                  <div>
                    {/* With template clubs chosen, each of them also commits
                        from the same union wallet, and each replaces its own
                        current commitment, so the union-wide figure is not
                        knowable here: the label says whose it is. */}
                    <dt>
                      {templateTargets.length > 0
                        ? 'Uncommitted After This Club'
                        : 'Uncommitted After Publication'}
                    </dt>
                    <dd>
                      {projectedUncommitted == null
                        ? 'Protected'
                        : `${compactChips(projectedUncommitted)} Chips`}
                    </dd>
                  </div>
                  {enabled && (
                    <div>
                      <dt>{shortfall.label}</dt>
                      <dd>{shortfall.value}</dd>
                    </div>
                  )}
                </dl>
                {templateClubs.length > 0 && (
                  <fieldset className="lb-prize-template">
                    <legend>Use As A Union Template</legend>
                    <p>
                      {`Also Publish This Plan To Other ${setup.union_name || 'Union'} Clubs You Manage. Each Club Gets It As Its Own Next Version And Can Still Be Edited On Its Own.`}
                    </p>
                    <div
                      className="lb-prize-template-clubs"
                      role="group"
                      aria-label="Other Union Clubs"
                    >
                      {templateClubs.map((club) => {
                        const selected = templateTargets.includes(club.club_id);
                        return (
                          <button
                            key={club.club_id}
                            type="button"
                            className={selected ? 'selected' : ''}
                            aria-pressed={selected}
                            disabled={saving}
                            onClick={() =>
                              setTemplateTargets((current) =>
                                selected
                                  ? current.filter((id) => id !== club.club_id)
                                  : [...current, club.club_id]
                              )
                            }
                          >
                            <strong>{club.club_name}</strong>
                          </button>
                        );
                      })}
                    </div>
                    {templateTargets.length > 0 && (
                      <span className="lb-prize-template-note">
                        {enabled
                          ? `Publishing To ${templateTargets.length + 1} Clubs. Each Commits ${exactChips(proposedCommitment)} Chips From The Union Promo Wallet, Checked In Turn; A Club It Cannot Cover Is Refused And Listed.`
                          : `Publishing To ${templateTargets.length + 1} Clubs. Prizes Will Be Disabled For Each Of Them.`}
                      </span>
                    )}
                  </fieldset>
                )}
                <div className="lb-prize-safety-note" role="note">
                  <strong>Starts Next Period</strong>
                  <span>
                    Current Standings Keep Their Published Rules. This Becomes Program Version{' '}
                    {setup.program_version + 1} At The Next Weekly And Monthly UTC Boundaries.
                  </span>
                </div>
                <div className="lb-prize-safety-note" role="note">
                  <strong>Publishing Checks Funding And Moves No Chips.</strong>
                  {setup.funding_owner_type === 'union' ? (
                    <span>
                      The Union Promo Wallet Must Cover This Plan And Every Other Club Plan Already
                      Published From It. Its Chips Are Not Locked. After Each Period Closes, The
                      Service-Only Settlement Pays The Winners From That Wallet And Writes Immutable
                      Payout Receipts.
                    </span>
                  ) : overlayOn ? (
                    /* The overlay is never publication capacity: the Promo
                       Wallet alone is checked here, and the Club Bank is drawn
                       only at settlement, for a shortfall (20260923143157). */
                    <span>
                      The Promo Wallet Must Cover This Plan When It Is Published, And Its Chips Are
                      Not Locked. The Club Bank Never Counts Toward That Check. After Each Period
                      Closes, The Service-Only Settlement Pays The Winners From Any Leftover Opening
                      Prize Seed, Then The Promo Wallet, Then The Club Bank For Only The Missing
                      Chips, And Writes Immutable Payout Receipts.
                    </span>
                  ) : (
                    <span>
                      The Promo Wallet Must Cover This Plan When It Is Published. Its Chips Are Not
                      Locked. After Each Period Closes, The Service-Only Settlement Pays The Winners
                      From Any Leftover Opening Prize Seed, Then The Promo Wallet, And Writes
                      Immutable Payout Receipts.
                    </span>
                  )}
                </div>
                {enabled && <p className="lb-prize-rule-note">{shortfall.note}</p>}
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
