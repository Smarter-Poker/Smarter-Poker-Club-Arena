import { getFreshAccessToken } from '../lib/authToken';
import { publicOrigin } from '../lib/appBase';
import { requestForDockActor } from '../components/messenger/dock/bindDockRequest.mjs';

export interface ClubWelcomeSettings {
  club_id: string;
  club_name: string;
  role: string;
  content: string;
  enabled: boolean;
  revision: number;
  owner_content?: string;
  owner_enabled?: boolean;
  owner_revision?: number;
}
export const WELCOME_STAFF_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'co_owner',
  'admin',
  'super_agent',
  'agent',
  'sub_agent',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function request(
  actorId: string,
  currentActor: () => string | null,
  body: Record<string, unknown>
) {
  const response = await requestForDockActor(
    `${publicOrigin()}/api/messenger/welcome-message`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      actorId,
      currentActor,
    },
    getFreshAccessToken
  );
  const data = await response.json();
  if (!response.ok || data.success !== true)
    throw new Error(data.error || 'Welcome Messages Are Temporarily Unavailable');
  if (currentActor() !== actorId) throw new Error('Account Changed');
  return data;
}
export async function readClubWelcomeSettings(
  actorId: string,
  currentActor: () => string | null
): Promise<ClubWelcomeSettings[]> {
  const data = await request(actorId, currentActor, { action: 'read' });
  if (
    !Array.isArray(data.clubs) ||
    data.clubs.some(
      (row: ClubWelcomeSettings) =>
        !uuid.test(row.club_id) ||
        typeof row.club_name !== 'string' ||
        !WELCOME_STAFF_ROLES.has(row.role) ||
        typeof row.content !== 'string' ||
        typeof row.enabled !== 'boolean' ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        (row.role === 'owner' &&
          (typeof row.owner_content !== 'string' ||
            typeof row.owner_enabled !== 'boolean' ||
            !Number.isSafeInteger(row.owner_revision) ||
            Number(row.owner_revision) < 0))
    )
  ) {
    throw new Error('Welcome Message Settings Could Not Be Verified');
  }
  return data.clubs;
}
export async function saveClubWelcomeSettings(
  actorId: string,
  currentActor: () => string | null,
  input: {
    clubId: string;
    messageKind?: 'downline' | 'club_owner';
    content: string;
    enabled: boolean;
    revision: number;
    requestId: string;
  }
): Promise<{ revision: number; content: string; enabled: boolean }> {
  const receipt = await request(actorId, currentActor, { action: 'save', ...input });
  if (
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 1 ||
    typeof receipt.content !== 'string' ||
    typeof receipt.enabled !== 'boolean'
  )
    throw new Error('Welcome Message Save Could Not Be Confirmed');
  return receipt;
}

export type ClubWelcomeKind = 'downline' | 'club_owner';
export function clubWelcomeTemplate(row: ClubWelcomeSettings, kind: ClubWelcomeKind) {
  return kind === 'club_owner'
    ? {
        content: row.owner_content || '',
        enabled: row.owner_enabled === true,
        revision: row.owner_revision || 0,
      }
    : { content: row.content, enabled: row.enabled, revision: row.revision };
}
export function clubWelcomeSetupMissing(row: ClubWelcomeSettings): boolean {
  return (
    !row.enabled ||
    !row.content.trim() ||
    (row.role === 'owner' && (!row.owner_enabled || !row.owner_content?.trim()))
  );
}
