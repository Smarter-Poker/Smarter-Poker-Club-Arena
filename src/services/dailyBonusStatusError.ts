import { reportError } from '../utils/errorReporter';

type StatusFailureKind = 'rpc_error' | 'invalid_payload';

/** The sheet keeps its friendly message; diagnostics retain the failed read. */
export class DailyBonusStatusError extends Error {
  readonly name = 'DailyBonusStatusError';

  constructor(
    readonly kind: StatusFailureKind,
    readonly cause: unknown,
    readonly httpStatus: number | null,
    readonly httpStatusText: string | null,
    readonly payloadKind: string
  ) {
    super('Could Not Load Your Daily Bonus');
  }
}

/** Called once by the still-active request owner, never by the service. */
export function reportDailyBonusStatusError(error: unknown, context: string): void {
  if (!(error instanceof DailyBonusStatusError)) {
    reportError(error, context);
    return;
  }
  // Do not log the response body, account, token, or reward contents. Preserve
  // transport/RPC causes instead of replacing them with the display message.
  reportError(
    error.cause ?? new Error(`Daily Bonus Status Returned ${error.payloadKind}`),
    context,
    {
      rpc: 'fn_ca_daily_bonus_status',
      failureKind: error.kind,
      httpStatus: error.httpStatus,
      httpStatusText: error.httpStatusText,
      payloadKind: error.payloadKind,
    }
  );
}
