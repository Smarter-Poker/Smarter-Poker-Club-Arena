/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SAFE ERROR MESSAGE — Players Never See Server Error Text (Dan, 2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, binding: "Stop allowing server error messages to appear for users."
 *
 * A player must never read `PGRST116`, `duplicate key value violates unique
 * constraint "club_wallets_pkey"`, `TypeError: Failed to fetch`, a stack frame,
 * a table name, `[object Object]`, or an empty popup. Those are engineering
 * artifacts. They tell the player nothing, they leak schema, and they read as
 * a broken product.
 *
 * WHY AN ALLOWLIST, NOT A BLOCKLIST
 *
 * A blocklist is a losing race: every new Postgres code, every new browser
 * error string, every new third-party SDK invents fresh text nobody blocked
 * yet, and the first person to see it is a player. So the polarity is
 * inverted here. Text is assumed unsafe. It reaches a player only if it
 * PROVES it is a short, plain-English sentence with no machine fingerprints
 * on it. Anything that cannot prove that becomes a friendly generic line.
 *
 * The blast radius of a false positive is small (a player sees "Something
 * Went Wrong. Please Try Again." instead of a slightly more specific but
 * still human sentence). The blast radius of a false negative is Dan's
 * complaint. So the bias is deliberate.
 *
 * WHERE IT RUNS
 *
 * Wired into the Toast provider's error path (`src/components/common/Toast.tsx`),
 * which is the single door every popup in Club Arena walks through — the same
 * place `formatPopupText` enforces Title Case and the em-dash ban. Hundreds of
 * call sites already do `toast.error(e?.message || '...')`; they all become
 * safe without one of them being edited. Inline error banners that render into
 * JSX call this directly, since they bypass the Toast layer.
 *
 * DIAGNOSTICS ARE NOT LOST
 *
 * This module only decides WHAT THE PLAYER READS. The real error still goes to
 * the console and to error reporting via `reportError` — the Toast provider reports the
 * original whenever this sanitizer suppressed it, so a hidden message is
 * actually MORE visible in error reporting than it was before, not less.
 *
 * DEV ESCAPE HATCH
 *
 * Under `import.meta.env.DEV` the raw text passes through untouched, so local
 * debugging still shows the real error in the popup.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// THE FRIENDLY VOCABULARY
// ═══════════════════════════════════════════════════════════════════════════════

/** The last resort. Says nothing technical, tells the player what to do next. */
export const GENERIC_ERROR_MESSAGE = 'Something Went Wrong. Please Try Again.';

/**
 * Known categories. When a raw error matches one of these, the player gets a
 * line that is both safe AND useful, instead of the generic fallback.
 */
export const SAFE_MESSAGES = {
  network: 'Connection Problem. Please Check Your Internet And Try Again.',
  session: 'Your Session Expired. Please Sign In Again.',
  permission: 'You Do Not Have Permission To Do That.',
  funds: 'Not Enough Chips For That.',
  rateLimit: 'Too Many Requests. Please Slow Down And Try Again.',
  timeout: 'That Took Too Long. Please Try Again.',
  duplicate: 'That Already Exists. Please Try Something Different.',
  notFound: 'We Could Not Find That. Please Refresh And Try Again.',
  server: 'The Server Is Busy Right Now. Please Try Again In A Moment.',
  generic: GENERIC_ERROR_MESSAGE,
} as const;

export type SafeErrorCategory = keyof typeof SAFE_MESSAGES;

/**
 * Categories a player must never be interrupted by.
 *
 * Dan 2026-08-21, with two screenshots: "you need to stop these pop ups to
 * users. The only thing that should ever appear is a disconnection
 * notification. And it shouldn't just keep popping it up over and over."
 *
 * Both screenshots were this class of error: infrastructure telling on itself.
 * "The Table Is Busy" is a 429 the client already retried four times with
 * backoff; "Connection Problem" is a fetch that the next poll will repeat in
 * two seconds. Neither asks the player to DO anything, and neither is even
 * true by the time it is read. They arrive from retry loops, so they arrive
 * again, and again.
 *
 * These are dropped before they reach the screen and reported to error reporting
 * instead. What is NOT on this list is the class of error that answers
 * something the player deliberately just did: not enough chips, no permission,
 * session expired. Swallowing those would mean a player taps Buy In and
 * nothing happens at all, which is a worse product than a popup.
 *
 * The disconnection notice Dan wants kept is not a toast at all: it is
 * DisconnectToast, driven by the engine's own disconnect FSM, and it is
 * untouched by this.
 */
export const SILENT_ERROR_CATEGORIES: ReadonlySet<SafeErrorCategory> = new Set([
  'network',
  'timeout',
  'rateLimit',
  'server',
]);

/**
 * Should this error be shown to a player at all?
 *
 * Takes the RAW text, because the category is what decides, and by the time a
 * message has been through safeErrorMessage every network failure reads as the
 * same friendly sentence and the evidence is gone.
 */
export function shouldSurfaceError(raw: unknown): boolean {
  const text = extractRawErrorText(raw);
  if (!text) return false; // An empty popup tells a player nothing.
  if (isSelfHealingMessage(text)) return false;
  const category = categorizeError(text);
  if (category && SILENT_ERROR_CATEGORIES.has(category)) return false;
  return true;
}

/**
 * Messages THIS APP writes for states that fix themselves.
 *
 * categorizeError cannot catch these, and correctly so: it hunts for machine
 * fingerprints (`PGRST116`, `TypeError: Failed to fetch`) and these have none.
 * They are already friendly sentences, written by us, which is exactly what
 * makes them slip through and reach the player.
 *
 * Every one describes something the client is ALREADY recovering from: a 429
 * that four backoff retries just exhausted, a socket mid-reconnect, a seat
 * that is resyncing. The player cannot act on any of them, and the condition
 * is usually over before the toast finishes animating in. Meanwhile the loop
 * that produced the message is still running, so it produces it again.
 *
 * Deliberately anchored on distinctive phrases rather than loose keywords:
 * "busy" alone would also swallow a genuine "That Seat Is Busy" that a player
 * DOES need to read.
 */
const SELF_HEALING_PATTERNS: readonly RegExp[] = [
  /\btable is busy\b/i,
  /\bserver unreachable\b/i,
  /\bserver error\s*\(\d+\)/i,
  /\btable not ready\b/i,
  /\breconnecting\b/i,
  /\bresyncing\b/i,
  /\bout of sync\b/i,
];

export function isSelfHealingMessage(text: unknown): boolean {
  const raw = typeof text === 'string' ? text : extractRawErrorText(text);
  if (!raw) return false;
  return SELF_HEALING_PATTERNS.some((re) => re.test(raw));
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1 — GET THE RAW TEXT OUT OF WHATEVER WAS THROWN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pull readable text out of any thrown value. Errors, Supabase
 * `{ message, code, details, hint }` plain objects, PostgrestError, fetch
 * Responses, strings, and the odd `undefined` all arrive at catch blocks in
 * this codebase.
 *
 * Exported because callers reporting to error reporting want the same extraction.
 */
export function extractRawErrorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err.trim();
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);

  if (err instanceof Error) {
    const parts = [err.message];
    const code = (err as { code?: unknown }).code;
    if (code) parts.push(String(code));
    return parts.filter(Boolean).join(' ').trim();
  }

  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    // Supabase / PostgREST shape, plus the common wrapper shapes.
    const candidates = [
      obj.message,
      obj.error_description,
      obj.msg,
      obj.details,
      obj.hint,
      typeof obj.error === 'string' ? obj.error : undefined,
      (obj.error as Record<string, unknown> | undefined)?.message,
      obj.statusText,
      obj.code,
      obj.status,
    ];
    const text = candidates
      .filter((c) => c != null && c !== '')
      .map((c) => String(c))
      .join(' ')
      .trim();
    if (text) return text;
    try {
      return JSON.stringify(err);
    } catch {
      return '';
    }
  }

  return String(err);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2 — CATEGORISE. A KNOWN SHAPE EARNS A SPECIFIC FRIENDLY LINE.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ordered most-specific-first. `insufficient funds` must beat `permission`,
 * `not_authorised` (a union RPC code) must beat the generic `unauthorized`
 * session check, and `already exists` must beat `does not exist`.
 */
const CATEGORY_PATTERNS: Array<[SafeErrorCategory, RegExp]> = [
  [
    'funds',
    /insufficient[\s_](?:funds|chips|balance|credit|stack)|not\s+enough\s+(?:chips|funds|money|balance|credit)|balance\s+too\s+low|\binsufficient_funds\b|\bover_credit_limit\b/i,
  ],
  [
    'duplicate',
    /duplicate\s+key|unique\s+constraint|\b23505\b|already\s+(?:exists|registered|joined|seated)/i,
  ],
  ['rateLimit', /\brate[\s_-]?limit|too\s+many\s+requests|over_request_rate_limit|\bthrottl/i],
  [
    'permission',
    /permission\s+denied|row[\s-]level\s+security|\bnot_author(?:i[sz])ed\b|\bforbidden\b|\b42501\b|\bnot_an_agent\b|do(?:es)?\s+not\s+have\s+(?:permission|access)|\bnot\s+allowed\b/i,
  ],
  [
    'session',
    /\bjwt\b|(?:token|session)\s+(?:is\s+)?expired|expired\s+(?:token|session)|invalid\s+(?:refresh[\s_])?token|refresh_token|not\s+authenticated|auth\s+session\s+missing|\bunauthorized\b|\bunauthorised\b|\bauthapierror\b|invalid\s+login\s+credentials/i,
  ],
  [
    'timeout',
    /\btimed?\s?-?\s?out\b|\btimeout\b|\betimedout\b|\b57014\b|statement\s+timeout|\baborterror\b|request\s+aborted|\bdeadline\s+exceeded\b/i,
  ],
  [
    'network',
    /failed\s+to\s+fetch|network\s*error|\bnetwork\b|load\s+failed|err_internet|err_network|\beconnrefused\b|\beconnreset\b|\benotfound\b|\beai_again\b|\boffline\b|net::|connection\s+refused|dynamically\s+imported\s+module|chunkloaderror|\bnetworkerror\b|\bfetcherror\b|\bfailed\s+to\s+load\b/i,
  ],
  // Deliberately narrow. `relation "x" does not exist` is a schema BUG, not a
  // missing record, and telling a player to refresh would be a lie; it is left
  // to fall through to the generic line instead.
  [
    'notFound',
    /\bpgrst116\b|no\s+rows\s+returned|\b0\s+rows\b|json\s+object\s+requested|\bnot\s+found\b/i,
  ],
  [
    'server',
    /internal\s+server\s+error|bad\s+gateway|service\s+unavailable|\bupstream\b|\beconnaborted\b|status\s+(?:code\s+)?(?:500|502|503|504)\b|\b(?:500|502|503|504)\s+(?:internal|bad|service|gateway)/i,
  ],
];

/** Which known bucket, if any, this raw text falls into. */
export function categorizeError(raw: string): SafeErrorCategory | null {
  if (!raw) return null;
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(raw)) return category;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3 — THE ALLOWLIST. TEXT MUST PROVE IT IS PLAIN ENGLISH.
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_LENGTH = 4;
const MAX_LENGTH = 160;
const MIN_WORDS = 2;
const MAX_WORDS = 26;

/**
 * Characters a human sentence in a poker popup can legitimately contain.
 * Everything else (braces, brackets, angle brackets, backslashes, pipes,
 * backticks, carets, tildes, asterisks, equals, semicolons, hashes, at-signs,
 * underscores, double quotes) is a machine fingerprint: snake_case identifiers,
 * quoted relation names, JSON, template noise, stack frames.
 */
const ALLOWED_CHARS = /^[A-Za-z0-9 ,.'!?%$()+/:-]+$/;

/**
 * Fingerprints of machine-generated text. Each entry exists because a real
 * production string in this codebase carried it.
 */
const TECHNICAL_MARKERS: RegExp[] = [
  // Any newline at all means a stack trace or a multi-part server payload.
  /[\r\n\t]/,
  // Source files and URLs.
  /\S+\.(?:ts|tsx|js|jsx|mjs|cjs|json|html|css|map)\b/i,
  /:\/\//,
  // UUIDs, long hex ids, long numeric ids.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b[0-9a-f]{12,}\b/i,
  /\d{7,}/,
  // Error/system code prefixes. Deliberately narrow so poker shorthand like
  // "NL200" and "PLO8" is not mistaken for a code.
  /\b(?:PGRST|ERR_|SQLSTATE|E[A-Z]{4,})\w*/,
  // Named postgres SQLSTATEs we actually see.
  /\b(?:23502|23503|23505|23514|22P02|42501|42703|42P01|40001|55P03|57014)\b/,
  // HTTP status codes, but only where the surrounding words prove they are
  // status codes rather than a chip amount.
  /\b(?:status|http|code)\b[^.]{0,12}\b\d{3}\b/i,
  // camelCase identifiers. No English sentence contains one.
  /\b[a-z]+[A-Z][a-zA-Z]*\b/,
  // JS error class names and stack frames.
  /\b(?:Type|Range|Reference|Syntax|Eval|URI|Abort|Chunk|Network|Auth|Postgrest)Error\b/i,
  /\bat\s+\S+\s*\(/,
  /\b(?:stacktrace|traceback)\b/i,
  // Words that only ever come from the plumbing.
  /\b(?:supabase|postgres|postgrest|sql|rpc|jwt|json|uuid|https?|xhr|cors|websocket|socket|api|apis|endpoint|schema|constraint|relation|column|rls|serialize|serialization|deserialize|payload|middleware|module|chunk|bundle|runtime|nullable|enum|varchar|jsonb|localhost|env|sdk)\b/i,
  /\bviolates\b/i,
  /\bcannot\s+read\s+(?:propert|of)/i,
  /\bis\s+not\s+(?:a\s+function|defined|iterable)\b/i,
  /\bunexpected\s+token\b/i,
  // Runtime-crash vocabulary. "Uncaught (in promise) Error" survived every
  // other test until this line existed.
  /\b(?:uncaught|unhandled|rejection|exception|fatal|panic|segfault|assertion)\b/i,
  // Postgres prose that is otherwise all lowercase plain words. Real leak:
  // "value too long for type character varying(32)" passed everything else.
  /\bvalue\s+too\s+long\b|\bcharacter\s+varying\b|\binvalid\s+input\s+syntax\b|\bout\s+of\s+range\b|\bnot-null\s+constraint\b|\bcheck\s+constraint\b|\b(?:foreign|primary)\s+key\b|\bcanceling\s+statement\b|\bdeadlock\b|\bon\s+conflict\b/i,
  // `identifier(42)` — a type width, an arity, an index. Never English.
  /\b[a-z]\w*\(\d+\)/i,
  // Literal JS non-values that leak straight into template strings.
  /\b(?:undefined|null|NaN)\b/,
  /\[object\s+\w+\]/i,
  // Explicit "Error: ..." framing.
  /\berror\s*:/i,
  // Placeholder copy that says nothing. "Unknown Error" is not a message, it is
  // a shrug; the generic line at least tells the player to try again.
  /^\s*(?:an?\s+|the\s+)?(?:unknown|unexpected|internal|generic|unhandled)\s+error\b/i,
];

/**
 * True only for text a player can read without knowing what a database is.
 *
 * Exported so an inline banner can ask the same question the Toast layer asks.
 */
export function isSafePlainMessage(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();

  if (t.length < MIN_LENGTH || t.length > MAX_LENGTH) return false;
  // A sentence starts with a letter. Codes and JSON do not.
  if (!/^[A-Za-z]/.test(t)) return false;
  if (!ALLOWED_CHARS.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS || words.length > MAX_WORDS) return false;

  // Mostly letters and spaces. Identifier soup fails this even when it slips
  // past the character allowlist.
  const letters = (t.match(/[A-Za-z ]/g) || []).length;
  if (letters / t.length < 0.6) return false;

  for (const marker of TECHNICAL_MARKERS) {
    if (marker.test(t)) return false;
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4 — THE PUBLIC ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Strip the "Error: " / "AuthApiError: " style prefix some runtimes prepend,
 * so a perfectly good sentence behind it still gets its chance.
 */
function stripErrorPrefix(raw: string): string {
  return raw.replace(/^\s*(?:[A-Za-z]*Error|Error|Exception)\s*:\s*/, '').trim();
}

/**
 * Turn `Minting failed: relation "club_wallets" does not exist` into
 * `Minting failed`. Call sites concatenate a human prefix onto a machine tail
 * constantly; the prefix is worth keeping when the tail is not.
 */
function headBeforeColon(raw: string): string | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const head = raw
    .slice(0, idx)
    .trim()
    .replace(/[,;]+$/, '');
  if (!head) return null;
  // A head that is itself just error framing ("Uncaught (in promise) Error",
  // "PostgrestException") is not a message. Drop it and take the generic.
  if (/\b(?:error|exception|warning|failure)\s*$/i.test(head)) return null;
  return head;
}

/**
 * The one function the rest of the app calls.
 *
 * @param err      Anything that was thrown, rejected, or returned as an error.
 * @param fallback Optional human line the call site would rather show than the
 *                 generic. It is held to the same allowlist as everything else,
 *                 so a call site cannot smuggle technical text through it.
 * @returns Text that is always safe to put in front of a player.
 */
export function safeErrorMessage(err: unknown, fallback?: string): string {
  // DEV ESCAPE HATCH — local debugging keeps the real text in the popup.
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    const devRaw = extractRawErrorText(err).trim();
    if (devRaw && devRaw !== '[object Object]') return devRaw;
    return fallback || GENERIC_ERROR_MESSAGE;
  }

  const raw = extractRawErrorText(err).trim();

  // Nothing usable at all. This is the empty-popup and `undefined` case.
  if (!raw || raw === '[object Object]' || raw === '{}') {
    return isSafePlainMessage(fallback) ? (fallback as string) : GENERIC_ERROR_MESSAGE;
  }

  // A recognised failure shape beats everything: it is safe AND specific.
  const category = categorizeError(raw);
  if (category) return SAFE_MESSAGES[category];

  // Plain-English sentence written by us? Let it through untouched.
  const stripped = stripErrorPrefix(raw);
  if (isSafePlainMessage(stripped)) return stripped;

  // `Human prefix: machine tail` — keep the prefix, drop the tail. A bare
  // "Minting Failed" is a dead end, so the advice the tail used to occupy is
  // replaced with advice the player can act on.
  const head = headBeforeColon(stripped);
  if (head && isSafePlainMessage(head)) {
    return /[.!?]$/.test(head) ? head : `${head}. Please try again.`;
  }

  // The call site's own wording, if it is itself clean.
  if (isSafePlainMessage(fallback)) return fallback as string;

  return GENERIC_ERROR_MESSAGE;
}

/**
 * True when `safeErrorMessage` would hide something. The Toast layer uses this
 * to decide whether the original is worth reporting to error reporting.
 */
export function wasSanitized(original: string, shown: string): boolean {
  return original.trim() !== shown.trim();
}

export default safeErrorMessage;
