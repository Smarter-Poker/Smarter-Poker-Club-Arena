export interface AssignmentIntent {
  id: string;
  club: string;
  userId: string;
  members: string[];
  target: string;
  source?: string;
  reviewToken: string;
}
const key = (userId: string, clubId: string) => `agent_assignment_intent_v1:${userId}:${clubId}`;
export function readAssignmentIntent(userId: string, clubId: string): AssignmentIntent | null {
  const raw = sessionStorage.getItem(key(userId, clubId));
  if (!raw) return null;
  const value = JSON.parse(raw) as AssignmentIntent;
  if (
    value.userId !== userId ||
    value.club !== clubId ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.target !== 'string' ||
    !value.target ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 10000 ||
    !value.members.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128) ||
    new Set(value.members).size !== value.members.length ||
    !/^[a-f0-9]{32}$/.test(value.reviewToken) ||
    (value.source !== undefined && typeof value.source !== 'string')
  )
    throw new Error('Saved Assignment Requires Staff Review. No New Transfer Was Sent.');
  return value;
}
export function saveAssignmentIntent(value: AssignmentIntent): void {
  const previous = readAssignmentIntent(value.userId, value.club);
  if (previous && previous.id !== value.id)
    throw new Error('Resolve The Pending Assignment Before Starting Another.');
  sessionStorage.setItem(key(value.userId, value.club), JSON.stringify(value));
}
export function clearAssignmentIntent(value: AssignmentIntent): void {
  if (readAssignmentIntent(value.userId, value.club)?.id === value.id)
    sessionStorage.removeItem(key(value.userId, value.club));
}
