import { titleCase } from './titleCase';

export interface DailyMissionCompletion {
  id: string;
  name: string;
  diamondReward: number;
}

/** Accept Supabase's direct and nested Broadcast payload shapes. */
export function dailyMissionCompletionFromPayload(payload: unknown): DailyMissionCompletion | null {
  const candidates: unknown[] = [payload];
  if (payload && typeof payload === 'object') {
    const envelope = payload as Record<string, unknown>;
    candidates.push(envelope.payload, envelope.data);
    if (envelope.payload && typeof envelope.payload === 'object') {
      candidates.push((envelope.payload as Record<string, unknown>).data);
    }
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    if (!id) continue;
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    return {
      id,
      name: rawName ? titleCase(rawName) : 'Daily Challenge',
      diamondReward: Math.max(0, Number(record.diamondReward) || 0),
    };
  }
  return null;
}
