import type { LeaderboardProgramHistoryEntry } from '../services/LeaderboardService';
import { compactChips } from './format';
import { prizePlanLabel, totalPrizePlan } from './leaderboardPrizePlans';

const METRIC_LABELS: Record<LeaderboardProgramHistoryEntry['payout_metric'], string> = {
  profit: 'Profit',
  hands_played: 'Hands Played',
  tournaments_won: 'Tournaments Won',
  roi: 'ROI',
};

export function programMetricLabel(
  metric: LeaderboardProgramHistoryEntry['payout_metric']
): string {
  return METRIC_LABELS[metric] ?? 'Profit';
}

function samePrizes(
  a: LeaderboardProgramHistoryEntry['weekly_prizes'],
  b: LeaderboardProgramHistoryEntry['weekly_prizes']
): boolean {
  const key = (rows: LeaderboardProgramHistoryEntry['weekly_prizes']) =>
    [...rows]
      .sort((x, y) => x.rank - y.rank)
      .map((row) => `${row.rank}:${Math.round(row.amount * 100)}`)
      .join('|');
  return key(a) === key(b);
}

function totalChange(label: 'Weekly' | 'Monthly', from: number, to: number): string {
  const before = compactChips(from);
  const after = compactChips(to);
  // The house compact format floors to one decimal above 1,000, so two
  // different totals can print alike. Say that it moved rather than printing
  // "1.2K To 1.2K".
  return before === after ? `${label} Prizes Adjusted` : `${label} ${before} To ${after} Chips`;
}

/**
 * What an owner changed in a published version, measured against the version
 * it superseded. The history is the "what" of "who changed what and when";
 * the row itself carries the who and the when.
 *
 * A version with no predecessor in hand is only called the first plan when it
 * IS version 1: an older predecessor that was not fetched is not evidence that
 * nothing came before.
 */
export function describeProgramChanges(
  entry: LeaderboardProgramHistoryEntry,
  previous: LeaderboardProgramHistoryEntry | undefined
): string[] {
  if (!previous) return entry.version === 1 ? ['First Published Plan'] : [];

  const changes: string[] = [];
  if (entry.rewards_enabled !== previous.rewards_enabled) {
    changes.push(entry.rewards_enabled ? 'Prizes Enabled' : 'Prizes Disabled');
  }
  if (entry.payout_metric !== previous.payout_metric) {
    changes.push(
      `Ranked By ${programMetricLabel(entry.payout_metric)} (Was ${programMetricLabel(previous.payout_metric)})`
    );
  }
  if (entry.suggestion_key !== previous.suggestion_key) {
    changes.push(
      `${prizePlanLabel(entry.suggestion_key)} Split (Was ${prizePlanLabel(previous.suggestion_key)})`
    );
  }
  const weekly = totalPrizePlan(entry.weekly_prizes);
  const previousWeekly = totalPrizePlan(previous.weekly_prizes);
  if (weekly !== previousWeekly) changes.push(totalChange('Weekly', previousWeekly, weekly));
  const monthly = totalPrizePlan(entry.monthly_prizes);
  const previousMonthly = totalPrizePlan(previous.monthly_prizes);
  if (monthly !== previousMonthly) changes.push(totalChange('Monthly', previousMonthly, monthly));

  if (changes.length === 0) {
    const rearranged =
      !samePrizes(entry.weekly_prizes, previous.weekly_prizes) ||
      !samePrizes(entry.monthly_prizes, previous.monthly_prizes);
    changes.push(rearranged ? 'Prize Places Rearranged' : 'Republished Without Changes');
  }
  return changes;
}
