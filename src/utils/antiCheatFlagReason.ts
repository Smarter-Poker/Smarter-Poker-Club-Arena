import { fmt } from './format';

/**
 * A flag's `reason` in words (2026-10-22). Detectors write JSON into `reason`,
 * and the console printed it raw: `{"detector":"multi_account_ip_match_v1",...`
 * cut off mid-key, so a reviewer could not tell why anyone was flagged.
 *
 * Returns the sentence and the other accounts involved, so the row can link
 * straight to them. Anything that is not JSON is a sentence already and is
 * shown as written.
 */
export interface FlagReasonView {
  summary: string;
  otherIds: string[];
  handNumbers: number[];
}

export function describeFlagReason(reason: string | null | undefined): FlagReasonView {
  const empty: FlagReasonView = { summary: 'No Reason Recorded', otherIds: [], handNumbers: [] };
  if (!reason || !reason.trim()) return empty;
  let r: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(reason);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...empty, summary: reason };
    }
    r = parsed as Record<string, unknown>;
  } catch {
    return { ...empty, summary: reason };
  }
  const otherIds = Array.isArray(r.other_user_ids)
    ? (r.other_user_ids.filter((v) => typeof v === 'string') as string[])
    : [];
  const handNumbers = Array.isArray(r.hand_numbers)
    ? (r.hand_numbers.map(Number).filter((n) => Number.isFinite(n)) as number[])
    : [];
  const n = (key: string): number => {
    const v = Number(r[key]);
    return Number.isFinite(v) ? v : 0;
  };
  const evidence = Array.isArray(r.evidence)
    ? (r.evidence as unknown[]).map(String)
    : typeof r.evidence === 'string'
      ? [r.evidence]
      : [];
  const parts: string[] = [];
  const hands = n('shared_hands');
  const ips = n('shared_ips');
  if (evidence.includes('same_device')) parts.push('Same Device');
  if (evidence.includes('same_hands') && hands > 0) {
    parts.push(`${fmt(hands)} Hand${hands === 1 ? '' : 's'} Played Together`);
  }
  if (evidence.includes('same_table_same_ip')) parts.push('Same Table From The Same Address');
  if (
    evidence.includes('shared_household_ips') ||
    evidence.includes('multiple_shared_household_ips')
  ) {
    parts.push(`${fmt(Math.max(ips, 2))} Shared Home Addresses`);
  } else if (evidence.includes('shared_household_ip') && parts.length > 0) {
    parts.push('Same Home Address');
  }
  if (parts.length === 0 && typeof r.detector === 'string' && r.detector.startsWith('multi_account')) {
    const count = n('account_count');
    parts.push(
      count > 1
        ? `Same IP Address As ${fmt(count - 1)} Other Account${count - 1 === 1 ? '' : 's'} (Retired Check)`
        : 'Same IP Address (Retired Check)'
    );
  }
  if (parts.length === 0) {
    const detector = typeof r.detector === 'string' ? r.detector.replace(/_/g, ' ') : 'Detector';
    parts.push(`Raised By ${detector}`);
  }
  return { summary: parts.join(' · '), otherIds, handNumbers };
}
