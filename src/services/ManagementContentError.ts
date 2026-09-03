export type ManagementContentErrorReason =
  | 'not_authenticated'
  | 'not_authorized'
  | 'invalid_scope'
  | 'invalid_payload'
  | 'invalid_colors'
  | 'inaccessible_colors'
  | 'invalid_font'
  | 'invalid_messages'
  | 'character_limit'
  | 'message_required'
  | 'club_not_found'
  | 'announcement_not_found'
  | 'version_conflict'
  | 'unavailable';

export class ManagementContentError extends Error {
  readonly reason: ManagementContentErrorReason;
  readonly currentRevision: number | null;

  constructor(
    reason: ManagementContentErrorReason,
    message: string,
    currentRevision: number | null = null
  ) {
    super(message);
    this.name = 'ManagementContentError';
    this.reason = reason;
    this.currentRevision = currentRevision;
  }
}

export function isManagementContentConflict(error: unknown): error is ManagementContentError {
  return error instanceof ManagementContentError && error.reason === 'version_conflict';
}
