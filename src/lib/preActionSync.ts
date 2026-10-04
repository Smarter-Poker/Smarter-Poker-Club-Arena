/**
 * ═══ A PRE-ACTION NEVER ARMS ITSELF (2026-10-04) ═════════════════════════════
 *
 * WHAT HAPPENED. In the heads-up sit-and-go played beside the match Dan
 * reported on 2026-10-04, his own seat folded thirteen hands in two and a
 * quarter minutes without him. The engine recorded each as
 * `fold[pre_action]`, ten of them within half a second of the deal. He had
 * armed one pre-action, once.
 *
 * WHY. The page tells the engine about a pre-action from one effect, and that
 * effect treated three different things as "the player armed this":
 *
 *   1. THE PLAYER ARMING IT. Correct.
 *   2. ITS OWN RESTORE. At a street or hand boundary the page clears the
 *      pre-action. When the hand is already over the engine answers that clear
 *      with HTTP 400 "No active hand" - it has nothing armed and nothing that
 *      could run. The API layer threw that sentence away ("Server error
 *      (400)"), the effect read the refusal as "the engine is still holding
 *      it", put the control back with setPreAction(armed), and that state
 *      change ran the ARM branch: the pre-action was sent to the engine again,
 *      now landing in the NEXT hand, where the engine executes an arm that
 *      arrives on the player's own turn immediately. That fold ended the hand,
 *      which cleared the pre-action, which was refused, which re-armed it.
 *   3. THE ENGINE'S OWN COPY. The engine pushes the armed pre-action to every
 *      socket the player has open. Each other tab and device adopted it with
 *      setPreAction(mapped), and each then sent it back as a new arm.
 *
 * Production, the same minutes: 68 to 98 refused /preaction requests a minute
 * from each of three open tabs of the one account.
 *
 * THE RULES NOW.
 *
 *   - The engine's ANSWER is read. "There is no hand" or "you are not in it"
 *     completes a clear: nothing is armed and nothing can run. It is not a
 *     failure, it is not retried, and it restores nothing.
 *   - Only a request that could not be DELIVERED is retried, and an attempt is
 *     abandoned once the player has changed their choice or the hand it was
 *     for has left the felt. A retried arm must never land in a later hand.
 *   - SHOWING what the engine holds is not ARMING it. The restore after an
 *     undelivered clear and the engine's own copy both go on screen through
 *     `preActionHeldByEngineRef`, which this function consumes without
 *     sending anything.
 *   - An answer that belongs to an earlier choice never acts on the current
 *     one (`preActionSendSeqRef`).
 *
 * No React here: the page calls this from its effect with its own refs, and
 * tests/unit/preActionSync.test.ts drives it with the engine's real replies.
 */
import { retryAsync } from '../utils/retryAsync';

export type PreActionChoice = 'fold' | 'check' | 'call' | 'callAny';

/** `code` on a /preaction reply: the engine answered, and refused. */
export const PRE_ACTION_REFUSED = 'PRE_ACTION_REFUSED';
/** `code` on a /preaction reply: the engine is running no game for this table. */
export const PRE_ACTION_TABLE_NOT_RUNNING = 'PRE_ACTION_TABLE_NOT_RUNNING';

/** What GameServerAPI.setPreAction resolves. It never throws. */
export interface PreActionReply {
  success: boolean;
  /** On an answered refusal: the engine's own sentence. */
  error?: string;
  /** PRE_ACTION_REFUSED or PRE_ACTION_TABLE_NOT_RUNNING when the engine answered. */
  code?: string;
  /** `engineCode`: the engine's own code for its refusal, when it sent one. */
  hint?: Record<string, unknown>;
  armedToCall?: number;
}

export type PreActionOutcome =
  /** The engine did what was asked. */
  | 'done'
  /**
   * The engine answered that this player has no live hand at this table (no
   * hand running, not dealt in, hand already over, no game at all). Nothing
   * is armed for them and nothing can run.
   */
  | 'nothing_can_run'
  /** The engine answered with a refusal this client does not recognise. */
  | 'refused'
  /** Nobody answered: network, a 5xx, or the client's own circuit breaker. */
  | 'not_delivered';

/**
 * The engine's sentences for "this player has no live hand here", lower case.
 * ServerTableEngine.setPreAction, LightningSeatProxy and LightningHandHost.
 * The codes are preferred where the engine sends one; the sentences are what
 * the engine build live on 2026-10-04 sends.
 */
const NO_LIVE_HAND_SENTENCES = [
  'no active hand',
  'player not found at this table',
  'you have left this hand',
  'that hand is over',
];
const NO_LIVE_HAND_CODES = ['NO_ACTIVE_HAND', 'NOT_IN_HAND', 'STALE_HAND'];

export function classifyPreActionReply(reply: PreActionReply | null | undefined): PreActionOutcome {
  if (!reply) return 'not_delivered';
  if (reply.success) return 'done';
  if (reply.code === PRE_ACTION_TABLE_NOT_RUNNING) return 'nothing_can_run';
  // No code: the request never produced an answer from the engine.
  if (reply.code !== PRE_ACTION_REFUSED) return 'not_delivered';
  const engineCode = reply.hint?.engineCode;
  if (typeof engineCode === 'string' && NO_LIVE_HAND_CODES.includes(engineCode)) {
    return 'nothing_can_run';
  }
  const sentence = (reply.error ?? '').trim().toLowerCase();
  return NO_LIVE_HAND_SENTENCES.includes(sentence) ? 'nothing_can_run' : 'refused';
}

/** The engine's name for what the bar armed. */
export function serverPreActionFor(choice: PreActionChoice, canCheck: boolean): string {
  return choice === 'fold'
    ? canCheck
      ? 'auto_check_fold'
      : 'auto_fold'
    : choice === 'check'
      ? 'auto_check'
      : choice === 'call'
        ? 'auto_call' // FIX 185: Bible V8 §4.15 - auto_call (current bet only)
        : 'auto_call_any';
}

interface Ref<T> {
  current: T;
}

/** The page's own refs. They outlive every run of the effect. */
export interface PreActionSyncRefs {
  /** A pre-action this page armed, or was shown, may be on the engine. */
  hadPreActionRef: Ref<boolean>;
  /** The last choice that was armed, for the restore after an undelivered clear. */
  lastArmedPreActionRef: Ref<PreActionChoice | null>;
  /** What the bar was offering when the player armed Fold (Check/Fold or Fold). */
  preActionCanCheckRef: Ref<boolean>;
  /** The price on the Call button when it was armed; then the engine's own. */
  preActionCallAmountRef: Ref<number>;
  /**
   * ONE SHOT. A value the ENGINE is already holding that is about to be put
   * on screen: written by whoever is about to call setPreAction with it (the
   * engine's own pre_action frame, the restore below), consumed by the very
   * next run of this function, which then sends nothing.
   */
  preActionHeldByEngineRef: Ref<PreActionChoice | null>;
  /** Bumped by every run. An older run's attempts and answers stand down. */
  preActionSendSeqRef: Ref<number>;
  /** Truthy in a Lightning room. */
  lightningRoomRef: Ref<unknown>;
}

export interface PreActionSyncInput {
  tableId: string | undefined;
  preAction: PreActionChoice | null;
  refs: PreActionSyncRefs;
  /** The hand on the felt, read at the moment it is asked. */
  handNumber: () => number;
  /** Lightning only: the id of the hand an arm must name. Null at a table. */
  lightningArmHandId: () => string | null;
  serverSetPreAction: (
    tableId: string,
    action: string,
    maxCallAmount?: number,
    handId?: string
  ) => Promise<PreActionReply>;
  setPreAction: (next: PreActionChoice | null) => void;
  toastError: (message: string) => void;
  reportError: (err: unknown, context: string) => void;
  /** Local telemetry: an arm is being sent to the engine. */
  onArmSent?: (serverAction: string) => void;
  /** Tests replace the backoff so it needs no real time. */
  retry?: <T>(fn: () => Promise<T>, maxRetries: number, baseDelayMs: number) => Promise<T>;
}

// Bible V8 §4.15: Pre-actions are server-managed - notify server when player sets/clears a pre-action
export function syncPreActionToEngine(input: PreActionSyncInput): void {
  const { tableId, preAction, serverSetPreAction, setPreAction, reportError } = input;
  const {
    hadPreActionRef,
    lastArmedPreActionRef,
    preActionCanCheckRef,
    preActionCallAmountRef,
    preActionHeldByEngineRef,
    preActionSendSeqRef,
    lightningRoomRef,
  } = input.refs;
  const retry = input.retry ?? retryAsync;

  /* EVERY RUN SUPERSEDES THE ONE BEFORE IT. A retry still waiting out its
     backoff, or an answer still in flight, belongs to an earlier choice. It
     used to act anyway: a clear retried after the player had armed something
     else wiped the new arm off the engine while the bar still showed it, and
     a failed arm darkened the bar after the player had armed something that
     succeeded. */
  const sendSeq = ++preActionSendSeqRef.current;
  const superseded = () => preActionSendSeqRef.current !== sendSeq;
  /* Read and cleared on EVERY run, so a marker can never outlive the state
     change it was written for and swallow a later, real arm. */
  const heldByEngine = preActionHeldByEngineRef.current;
  preActionHeldByEngineRef.current = null;

  if (tableId) {
    if (preAction) {
      const serverAction = serverPreActionFor(preAction, preActionCanCheckRef.current);
      // Tell server about pre-action so it can auto-execute on player's turn
      hadPreActionRef.current = true;
      lastArmedPreActionRef.current = preAction;
      /* SHOWING IT IS NOT ARMING IT. The engine already holds this one: it
         told us so itself (its pre_action frame), or a clear for it could not
         be delivered. The bar shows it and the player can cancel it. Sending
         it again would arm it again - in whatever hand is on the felt by the
         time the request lands - and that is how one armed fold folded
         thirteen hands. */
      if (heldByEngine === preAction) return;
      /* RETRIED FOR REAL THIS TIME (Dan 2026-08-28: "pre action buttons
         still have a slight glitch").

         `serverSetPreAction` NEVER throws - it resolves `{success:false}`
         on a non-OK status, on an unreachable engine, and for a full 30s
         whenever GameServerAPI's circuit breaker is open. The previous
         `retryAsync(() => serverSetPreAction(...))` therefore resolved its
         FIRST falsy result and retried nothing: the comment said "three
         bounded attempts" while the code made one. The wrapper below turns
         an UNDELIVERED request into a thrown, retryable error ("network"
         marks it retryable for retryAsync's filter), so the three attempts
         are real; the terminal failure lands in `.catch`, which disarms the
         bar rather than letting it claim something the engine never armed.

         2026-10-04: an ANSWER is not retried. The engine refusing an arm has
         decided, and asking again 400ms later only changes the answer if the
         next hand has started - which arms the player in a hand they never
         armed anything in.

         Dan 2026-08-28 (CRITICAL): `auto_call` now carries the PRICE THE
         PLAYER WAS LOOKING AT when they armed it (snapshotted in
         onPreActionChange, same place the canCheck snapshot lives). The
         engine also records its own price at set time, so this cap is
         belt on top of the server's braces - either alone stops "Call 15"
         from calling a raise to 65. */
      const armCap = serverAction === 'auto_call' ? preActionCallAmountRef.current : undefined;
      const armHand = input.handNumber();
      void retry(
        async () => {
          // Not sent for a choice the player has changed, or into another hand.
          if (superseded() || input.handNumber() !== armHand) return null;
          /* LIGHTNING PHASE 6: in a Lightning room the arm names its hand. */
          const lightningArmHandId = input.lightningArmHandId();
          const res = lightningArmHandId
            ? await serverSetPreAction(tableId, serverAction, armCap, lightningArmHandId)
            : await serverSetPreAction(tableId, serverAction, armCap);
          const outcome = classifyPreActionReply(res);
          if (outcome === 'not_delivered') {
            throw new Error(`network/preaction-arm: ${res?.error || 'engine refused'}`);
          }
          if (outcome !== 'done') return res;
          /* ADOPT THE ENGINE'S OWN NUMBER (2026-08-30). The engine records
             `toCallAtSet` from its authoritative state and now returns it.
             Until this line the panel-suppression rule judged "can the
             engine still honour this?" against a price the BROWSER
             snapshotted at tap time - two snapshots of one number, taken at
             two moments on two machines. They agree almost always, and the
             "almost" is a visible flash on a hand the engine was going to
             act, or no panel on a hand where the arm was already dead.
             There is now one number, and it is the engine's. */
          if (typeof res.armedToCall === 'number' && Number.isFinite(res.armedToCall)) {
            preActionCallAmountRef.current = res.armedToCall;
          }
          return res;
        },
        2,
        400
      )
        .then((res) => {
          if (res?.success || superseded()) return;
          /* Not armed: the attempt was abandoned (`res` is null), or the
             engine answered no. Either way the bar must not claim it. */
          hadPreActionRef.current = false;
          setPreAction(null); // the bar must not claim something the engine has not armed
          /* A hand that is over, or one the player is not in, has nothing to
             play manually: say nothing. Any other refusal is worth a word. */
          if (res && classifyPreActionReply(res) === 'refused') {
            reportError(
              new Error(`preaction-arm refused: ${res.error || 'no reason given'}`),
              'TablePage.PreAction_set_refused'
            );
            input.toastError('Could Not Arm That Pre-Action, Play It Manually.');
          }
        })
        .catch((err: unknown) => {
          reportError(err, 'TablePage.PreAction_set_refused');
          if (superseded()) return;
          hadPreActionRef.current = false;
          setPreAction(null); // the bar must not claim something the engine has not armed
          input.toastError('Could Not Arm That Pre-Action, Play It Manually.');
        });
      input.onArmSent?.(serverAction);
    } else if (hadPreActionRef.current) {
      // Clear pre-action on server (only if one was previously armed -
      // P2-1: avoids a junk clear request on initial mount when null).
      hadPreActionRef.current = false;
      /* THE DIRECTION THAT COSTS A HAND (Dan 2026-08-27: pre-actions
         "sometimes stay engaged on future streets").

         The engine disposes pre-actions only at HAND END, while the client's
         rule is one action and one street - so every street boundary sends a
         clear, and a clear that fails leaves the ENGINE armed while the BAR
         GOES DARK. The player sees nothing engaged, and the engine folds or
         calls for them on a later street. That is precisely the reported
         symptom, and the old code knew it: its own comment said "the engine
         still holds the old pre-action and WILL execute it".

         Two changes. It RETRIES for real (an undelivered request is thrown
         as a retryable error - the bare `retryAsync(() => serverSetPreAction…)`
         shape resolved its first `{success:false}` and retried nothing).
         And when the clear genuinely fails it puts the bar BACK to what the
         engine is actually holding instead of leaving it dark - a visible
         armed control the player can cancel again beats an invisible one
         that acts for them.

         Dan 2026-08-28: `armed` used to be `const armed = preAction` HERE,
         inside the else-branch where `preAction` is null by definition -
         so the restore was dead code and a failed clear left the bar dark
         while the engine stayed armed (the exact "it acts again later"
         glitch). The value now comes from lastArmedPreActionRef, written
         on every successful arm.

         2026-10-04: "genuinely fails" now means what it says. The engine
         ANSWERING that there is no hand, or that this player is not in it,
         is the clear completed: it holds nothing that could run. That answer
         used to be retried twice, then restored and re-armed into the next
         hand (see the head of this file). */
      const armed = lastArmedPreActionRef.current;
      const clearHand = input.handNumber();
      const clearNotConfirmed = (err: unknown) => {
        reportError(err, 'TablePage.PreAction_clear_refused');
        if (superseded()) return;
        /* The engine drops every pre-action when its hand ends. Once the
           hand this clear was for has left the felt there is nothing it could
           still be holding, and nothing to show. */
        if (input.handNumber() !== clearHand) return;
        hadPreActionRef.current = true;
        // Show what the engine is still holding, rather than nothing.
        /* DISPLAY ONLY: marked as the engine's own, so the run this state
           change causes shows it and sends nothing. */
        if (armed && !lightningRoomRef.current) preActionHeldByEngineRef.current = armed;
        /* Never in a Lightning room: by the time a clear has failed the
           next hand may already be on the felt, and an arm restored here
           would belong to it. The engine drops the old one at the hand's
           end on its own. */
        if (lightningRoomRef.current) {
          // Lightning: left disarmed (see above).
        } else if (armed) setPreAction(armed);
        input.toastError('Could Not Cancel Your Pre-Action, It May Still Run This Hand.');
      };
      void retry(
        async () => {
          // A clear the player has since replaced with a new arm is not sent:
          // landing after that arm, it would wipe it.
          if (superseded()) return null;
          const res = await serverSetPreAction(tableId, 'clear');
          if (classifyPreActionReply(res) === 'not_delivered') {
            throw new Error(`network/preaction-clear: ${res?.error || 'engine refused'}`);
          }
          return res;
        },
        2,
        400
      )
        .then((res) => {
          if (!res || res.success) return;
          // No hand, or not in it: the engine holds nothing. The clear is done.
          if (classifyPreActionReply(res) === 'nothing_can_run') return;
          // An answer this client does not recognise: fail towards showing it.
          clearNotConfirmed(
            new Error(`preaction-clear refused: ${res.error || 'no reason given'}`)
          );
        })
        .catch(clearNotConfirmed);
    }
  }
}
