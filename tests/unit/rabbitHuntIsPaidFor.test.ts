/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RABBIT HUNT CARDS ARE NEVER BROADCAST, AND ARE NEVER FREE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "the rabbit hunt should pop up when the action is completed,
 * no matter if its pre flop, on the flop, on the turn, or on the river... these
 * should ONLY APPEAR TO THE PLAYER WHO CLICKED the rabbit hunt. vip members get
 * 100 rabbit hunts a month for free, and they cost 5 diamonds each after that."
 *
 * WHAT WAS ACTUALLY SHIPPED
 *
 * The engine put the five real remaining cards into `rabbit_hunt_available`,
 * which is a ROOM-WIDE broadcast — TableStateHub.emitEvent sends to every
 * subscriber socket and has no per-user filtering of any kind. So the run-out
 * arrived in cleartext at every client at the table, before anyone paid, and
 * every opponent had it too.
 *
 * The paywall was a client-side `if` in RabbitHunt.tsx. It called
 * vipService.useFeature, which routed to fn_purchase_feature relying on a cost
 * that defaults to 0. So the honest path charged nothing, and the dishonest
 * path was "open devtools".
 *
 * THE SHAPE THIS PINS
 *
 * Three things, each of which independently restores the hole:
 *   1. cards in the broadcast          → everyone gets them free
 *   2. billing decided on the client   → anyone can decline to bill
 *   3. the RPC callable by a player    → anyone can mint free hunts
 *
 * These are source-text guards, in the house style, for the same reason
 * afkSitOutGuard.test.ts is: what regressed is the SHAPE, and a behavioural
 * test of a paywall that is enforced in Postgres would have to mock the very
 * boundary it exists to check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceBlockAfter, sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SETTLEMENT = strip(read('server/src/engine/ServerTableEngineSettlement.ts'));
const ROUTER = strip(read('server/src/router.ts'));
const HANDLER = strip(read('server/src/handlers/rabbithunt.ts'));
const MIGRATION = read('supabase/migrations/20260825_fn_consume_rabbit_hunt.sql');
const COMPONENT = strip(read('src/components/table/RabbitHunt.tsx'));
/**
 * P5 2026-09-05: the reveal itself moved into `useRabbitHuntReveal`, because
 * the hand replayer buys the same thing and two implementations of a paid
 * action drift. The tile still owns the artwork, the price badge and the
 * counts; the money lives in the hook. Pins that describe the PURCHASE follow
 * it there (CLAUDE.md 10.6: move the pin to the new mechanism, same commit).
 */
const REVEAL_HOOK = read('src/components/table/useRabbitHuntReveal.ts');
/** The whole reveal path, wherever its parts happen to live. */
const REVEAL_PATH = COMPONENT + '\n' + REVEAL_HOOK;
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));

/**
 * WHERE PRETTIER WRAPS A LONG JSX EXPRESSION IS NOT BEHAVIOUR.
 *
 * `squash` removes every space, so a pin matches the same code whether the
 * formatter put it on one line or four. One of these pins went RED ON CI
 * while passing locally for exactly this reason: the pre-commit hook
 * reformats the file after the local run, so what CI reads is not what the
 * local run read. A pin that breaks on reformatting cries wolf.
 */
const squash = (t: string) => t.replace(/\s+/g, '');
const SQUASHED_TABLE_PAGE = squash(TABLE_PAGE);

const API = strip(read('src/services/GameServerAPI.ts'));

describe('the cards never go out in a broadcast', () => {
  it('rabbit_hunt_available carries no cards', () => {
    const at = SETTLEMENT.indexOf("type: 'rabbit_hunt_available'");
    expect(at, 'the availability event was not found').toBeGreaterThan(-1);
    const event = sliceEnclosingBlock(SETTLEMENT, "type: 'rabbit_hunt_available'");
    // The exact field that leaked. Its absence is the whole fix.
    expect(event).not.toMatch(/rabbit_cards/);
    expect(event).toMatch(/cards_available/);
  });

  it('the client cannot read cards off the event even if one reappears', () => {
    const at = TABLE_PAGE.indexOf("eventType === 'rabbit_hunt_available'");
    expect(at, 'the client handler was not found').toBeGreaterThan(-1);
    const handler = sliceBlockAfter(TABLE_PAGE, "eventType === 'rabbit_hunt_available'");
    expect(handler).not.toMatch(/rabbit_cards/);
  });

  it('the cards are held per hand so a late click cannot serve the NEXT hand', () => {
    expect(SETTLEMENT).toMatch(/rabbitHuntOffers\.set\(this\.handCount/);
  });
});

describe('the cards are sold, not given', () => {
  it('the reveal charges before it answers', () => {
    const at = SETTLEMENT.indexOf('revealRabbitHunt');
    expect(at, 'revealRabbitHunt was not found').toBeGreaterThan(-1);
    const body = sliceMethod(SETTLEMENT, 'public async revealRabbitHunt(');
    const charge = body.indexOf('fn_consume_rabbit_hunt');
    const answer = body.indexOf('offer.revealed.add');
    expect(charge, 'the reveal does not call the billing RPC').toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(charge);
  });

  it('the production reveal ledger records metadata only, never unseen cards', () => {
    const body = sliceMethod(SETTLEMENT, 'public async revealRabbitHunt(');
    expect(body).toMatch(/from\('rabbit_hunt_reveals'\)/);
    expect(body).not.toMatch(/from\('rabbit_hunt_offers'\)/);
    const insertWindow = sliceEnclosingBlock(body, "from('rabbit_hunt_reveals')");
    expect(insertWindow).toMatch(/user_id/);
    expect(insertWindow).toMatch(/table_id/);
    expect(insertWindow).toMatch(/hand_number/);
    expect(insertWindow).toMatch(/charged/);
    expect(insertWindow).not.toMatch(/cards/);
  });

  it('a failed charge reveals nothing', () => {
    const at = SETTLEMENT.indexOf('revealRabbitHunt');
    const body = sliceMethod(SETTLEMENT, 'public async revealRabbitHunt(');
    // The refusal branch must return before any `cards` are attached.
    expect(body).toMatch(/charge\.success !== true/);
    // Bound the window at the START of the success path rather than by a
    // character count, or the slice runs past the refusal and reads the very
    // `cards` the refusal is supposed not to contain.
    const refusal = body.indexOf('charge.success !== true');
    const successPath = body.indexOf('offer.revealed.add');
    expect(successPath).toBeGreaterThan(refusal);
    const refusalBlock = body.slice(refusal, successPath);
    expect(refusalBlock).toMatch(/success: false/);
    expect(refusalBlock).not.toMatch(/cards/);
  });

  it('the client does not bill — it asks, and renders what it is given', () => {
    // vipService.useFeature was the old client-side charge. Its absence here is
    // what makes the paywall unskippable.
    expect(COMPONENT).not.toMatch(/useFeature/);
    expect(COMPONENT).not.toMatch(/purchaseFeature/);
  });

  it('the only route the cards travel is the authenticated endpoint', () => {
    expect(ROUTER).toMatch(/url === '\/rabbit-hunt'/);
    expect(HANDLER).toMatch(/authenticateRequest\(req\)/);
    expect(HANDLER).toMatch(/401/);
    expect(API).toMatch(/\/rabbit-hunt/);
  });
});

describe('the price is what Dan said it is', () => {
  it('VIP gets 100 a month, then diamonds', () => {
    expect(MIGRATION).toMatch(/v_vip_monthly_cap\s+CONSTANT\s+int\s*:=\s*100/);
    expect(MIGRATION).toMatch(/v_default_cost\s+CONSTANT\s+int\s*:=\s*5/);
    expect(MIGRATION).toMatch(/feature = 'rabbit_hunt'/);
  });

  it('the monthly pool is spent before diamonds are', () => {
    const vip = MIGRATION.indexOf('vip_feature_usage_monthly');
    const diamonds = MIGRATION.indexOf('deduct_diamonds');
    expect(vip).toBeGreaterThan(-1);
    expect(diamonds).toBeGreaterThan(vip);
  });

  it('a player cannot execute the billing RPC themselves', () => {
    // Without this, the "charge" is advisory: a client could call the RPC with
    // its own JWT, or simply never call it at all.
    expect(MIGRATION).toMatch(/is engine-only/);
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_consume_rabbit_hunt\(uuid\) FROM authenticated/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_consume_rabbit_hunt\(uuid\) TO service_role/
    );
  });

  it('two simultaneous reveals cannot both take the last free hunt', () => {
    expect(MIGRATION).toMatch(/pg_advisory_xact_lock/);
  });

  it('a double tap does not bill twice', () => {
    const at = SETTLEMENT.indexOf('revealRabbitHunt');
    const body = sliceMethod(SETTLEMENT, 'public async revealRabbitHunt(');
    const already = body.indexOf('offer.revealed.has(userId)');
    const charge = body.indexOf('fn_consume_rabbit_hunt');
    expect(already, 'no repeat-reveal short circuit').toBeGreaterThan(-1);
    expect(already).toBeLessThan(charge);
  });
});

describe('who is offered a hunt, and for how many cards', () => {
  it('the offer goes to everyone dealt in, not only players who folded', () => {
    // Gating on heroFolded excluded the player who WON when everyone else
    // folded - the one person most likely to want to see the run-out.
    const at = TABLE_PAGE.indexOf("eventType === 'rabbit_hunt_available'");
    const handler = sliceBlockAfter(TABLE_PAGE, "eventType === 'rabbit_hunt_available'");
    expect(handler).not.toMatch(/heroFoldedInCurrentHandRef/);
  });

  it('a spectator cannot buy a look at a hand they were not in', () => {
    expect(SETTLEMENT).toMatch(/offer\.eligible\.has\(userId\)/);
  });

  it('the card count comes from the server, not from an empty client board', () => {
    // `currentBoard` was only ever set to [], so every reveal claimed five
    // cards and a turn-fold rendered four empty placeholders beside one card.
    expect(COMPONENT).toMatch(/cardsAvailable/);
    expect(COMPONENT).not.toMatch(/currentBoard/);
  });

  it('a RUN IT TWICE hand is never offered one', () => {
    // On a RIT hand communityCards holds only the shared pre-all-in prefix, so
    // the board-length gate read 0, decided the hand ended pre-flop, and sold
    // five cards. RIT had already burned two or three run-outs off that deck —
    // what remained was noise, charged at five diamonds.
    expect(SETTLEMENT).toMatch(/currentHandRitBoards \?\? 0\) >= 2/);
    const guard = SETTLEMENT.indexOf('ranItTwice');
    const capture = SETTLEMENT.indexOf('rabbitHuntOffers.set');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(capture);
  });

  it('a capture failure is reported, never swallowed', () => {
    // A bare catch here meant no offer, no event, and a rabbit hunt that had
    // quietly stopped working on that table with nothing to say why — the exact
    // blind spot that would have hidden the RIT bug above.
    const block = sliceMethod(SETTLEMENT, 'private async settleCompletedHand(');
    expect(block).toMatch(/reportError\(err, 'ServerTableEngine\.rabbit_hunt_capture_error'\)/);
  });

  it('the offer history is trimmed by insertion order, not by hand number', () => {
    // Hand numbers come from allocateGlobalHandNumber and are global to the
    // server, so they jump by arbitrary amounts: `handNumber < handCount - 1`
    // was almost never the previous hand at this table, and silently kept one
    // offer instead of two, halving the window for a late click.
    expect(SETTLEMENT).toMatch(/rabbitHuntOffers\.size > 2/);
    expect(SETTLEMENT).not.toMatch(/handNumber < this\.handCount - 1/);
  });

  it('a hand that ran to the river is never offered one', () => {
    expect(SETTLEMENT).toMatch(/handReachedRiver/);
    // Read from the CAPTURED board length: the live controller is nulled by
    // this point and an optional chain onto it yields [], i.e. "length 0",
    // which would offer a rabbit hunt on a completed board.
    expect(SETTLEMENT).toMatch(/offer\?\.boardLength \?\? 5/);
  });

  it('the price shown is the LIVE price, not a client constant', () => {
    // The migration promises the price "can be repriced without a deploy", and
    // the client broke that promise: it rendered a hardcoded 5 from
    // FEATURE_PRICING while the charge came from the feature_pricing row.
    expect(SETTLEMENT).toMatch(/getRabbitHuntCost/);
    expect(SETTLEMENT).toMatch(/diamond_cost: diamondCost/);
    expect(TABLE_PAGE).toMatch(/setRabbitDiamondCost/);
    expect(COMPONENT).toMatch(/rabbitDiamondCost/);
  });

  it('only players who were dealt in are offered the button', () => {
    // The event is a room-wide broadcast, so it has to name who may act on it.
    // Without that a spectator saw a live button whose only outcome was refusal.
    expect(SETTLEMENT).toMatch(/eligible_user_ids: Array\.from\(offer\.eligible\)/);
    expect(TABLE_PAGE).toMatch(/eligible_user_ids/);
    expect(TABLE_PAGE).toMatch(/heroMayHunt/);
  });

  it('an offer goes stale instead of staying buyable forever', () => {
    // "The map holds the last two hands" stops bounding anything the moment a
    // table stops dealing, leaving an hours-old hand purchasable.
    expect(SETTLEMENT).toMatch(/RABBIT_HUNT_OFFER_TTL_MS/);
    expect(SETTLEMENT).toMatch(/offer\.offeredAt > RABBIT_HUNT_OFFER_TTL_MS/);
  });

  it('two taps racing the RPC cannot both be billed', () => {
    // `revealed` is written only AFTER the charge returns, so both taps pass it.
    expect(SETTLEMENT).toMatch(/rabbitHuntInFlight/);
    const at = SETTLEMENT.indexOf('rabbitHuntInFlight.add');
    const charge = SETTLEMENT.indexOf('fn_consume_rabbit_hunt');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(charge);
    // Released on every path, or the player is locked out for the engine's life.
    expect(SETTLEMENT).toMatch(/finally \{[\s\S]{0,220}rabbitHuntInFlight\.delete\(userId\)/);
  });

  it('a purchased-pack reveal is acknowledged, not silent', () => {
    // It spends neither diamonds nor a VIP use, so it fell through both toast
    // branches and the player burned a pack use with no feedback at all.
    expect(SETTLEMENT).toMatch(/uses_remaining/);
    expect(TABLE_PAGE).toMatch(/usesRemaining: result\.uses_remaining/);
    // The acknowledgement is the tile numeral now, not a toast - see below.
    expect(REVEAL_PATH).toMatch(/setPackRemaining\(result\.usesRemaining\)/);
    // And it has somewhere to land: the corner count falls back to the pack
    // when there is no VIP pool, or the number would be set and never drawn.
    expect(COMPONENT).toMatch(/visibleVipRemaining \?\? packRemaining/);
  });

  it('never pops up a running count of hunts left', () => {
    // Dan 2026-08-30: "YOU DO NOT NEED A POP UP IN THE BOTTOM RIGHT CORNER
    // 'ALERTING YOU' HOW MANY RABBIT HUNTS YOU HAVE LEFT."
    //
    // The count is not deleted, it MOVED - onto the tile, where it reads
    // BEFORE the press instead of being announced after the money has gone. A
    // toast repeating it is one more thing covering the felt at hand's end.
    expect(REVEAL_PATH).not.toMatch(/Left This Month/);
    expect(REVEAL_PATH).not.toMatch(/Left In Your Pack/);
    expect(REVEAL_PATH).not.toMatch(/Last Free Rabbit Hunt/);
    // What must NOT be swept away with it: a CHARGE is not a stock level, and
    // spending diamonds in silence is the bug this whole file exists for.
    expect(REVEAL_PATH).toMatch(/Diamonds Charged/);
    // The numeral stays on the button.
    expect(COMPONENT).toMatch(/rabbit-hunt__remaining/);
  });

  it('the reveal flip does not flicker through its delay', () => {
    // POKERBROS PARITY 2026-08-26: the reveal moved onto the CommunityCards
    // board — backs appear in a hard cut, hold ~120ms, then ALL cards flip
    // together (ccRabbitFlip). The fill mode is the anti-flicker guarantee:
    // without `both`, each card paints in its RESTING state (face up) during
    // the 120ms delay, so the faces flash, blink out, and re-animate — the
    // same bug the old cardReveal/`backwards` pin in RabbitHunt.css guarded.
    const css = read('src/components/table/CommunityCards.css');
    expect(css).toMatch(/animation: ccRabbitFlip [^;]*both/);
    // And the flip must be SIMULTANEOUS — the reference turns the whole board
    // over in one video frame. A per-index delay would reintroduce a stagger.
    const flipAt = css.indexOf('.community-cards__rabbit-flip {');
    expect(flipAt).toBeGreaterThan(-1);
    expect(css.slice(flipAt, css.indexOf('}', flipAt))).not.toMatch(/--card-index/);
  });

  it('rabbit cards render even when the hand ended preflop', () => {
    // The board derives its visible count from the STAGE, and a preflop fold
    // leaves stage 'preflop' (count 0) — which is exactly when Rabbit Hunt
    // exists. The reveal used to be APPENDED into `cards`, so it was invisible
    // there: the player paid and saw nothing. It travels as its own prop now
    // (an inference from trailing cards would misfire on the bomb pot's
    // hold-flop gate, which passes dealt cards with stage forced to preflop),
    // and rabbit slots bypass the preflop placeholder suppression.
    const board = read('src/components/table/CommunityCards.tsx');
    expect(board).toMatch(/rabbitCards/);
    expect(board).toMatch(/community-cards__card--rabbit/);
    // P1 2026-09-05: the live path still paints rabbitRevealedCards (through
    // liveRabbitCards, which borrows the retained copy's for one render at
    // the hand boundary); the retained path paints the copy. Both are the
    // reveal as its own prop, never appended into `cards`.
    expect(SQUASHED_TABLE_PAGE).toContain(
      squash('rabbitCards={showRetainedRabbitBoard ? retainedRabbitCards : liveRabbitCards}')
    );
    expect(TABLE_PAGE).toMatch(/: rabbitRevealedCards;/);
    // The old shape must not come back: appending the reveal into `cards`
    // hides it behind the stage-derived count.
    expect(TABLE_PAGE).not.toMatch(/\.\.\.rabbitRevealedCards/);
  });

  it('the button lives in a positioned slot rather than falling out of the layout', () => {
    // ORIGINALLY: it rendered into a `position: fixed; height: 100dvh;
    // overflow: hidden` flex column as an unpositioned flex item, so it could
    // sit out of view entirely - the player pays and sees nothing. The fix was
    // to give `.rabbit-hunt` its own `position: fixed; left; bottom: 22vh`.
    //
    // UPDATED 2026-08-26. Dan: "THAT ALSO THE EXACT POSITION THAT THE RABBIT
    // HUNT BUTTON SHOULD APPEAR WHEN THE HAND IS OVER" - the position being the
    // bottom-left HUD slot the time bank tile uses while the hero is on the
    // clock. So it is no longer self-positioned; it renders inside
    // `.hud-ul-column--stack`, which sits in `.table-hud` (itself
    // `position: fixed; inset: 0`). The original failure - an unpositioned item
    // in a clipped column - is still impossible, by a different route.
    const css = read('src/components/table/RabbitHunt.css');
    const at = css.indexOf('.rabbit-hunt {');
    expect(at).toBeGreaterThan(-1);
    const rootRule = css.slice(at, css.indexOf('}', at));

    // It must NOT re-acquire its own coordinate system.
    expect(rootRule).not.toMatch(/position:\s*fixed/);
    // And it must opt back into pointer events, because .table-hud sets
    // pointer-events: none and an unclickable button is the same bug wearing a
    // different hat.
    expect(rootRule).toMatch(/pointer-events:\s*auto/);

    // It renders in the HUD stack, next to the time bank tile.
    const at2 = TABLE_PAGE.indexOf('<TimebankCounter');
    const rabbitAt = TABLE_PAGE.indexOf('<RabbitHunt', at2);
    expect(rabbitAt).toBeGreaterThan(-1);
    expect(rabbitAt).toBeLessThan(TABLE_PAGE.indexOf('<PreviousHandCard', at2));
  });

  it('a VIP is told how many free hunts are left', () => {
    // vip_remaining is counted by the server on every reveal and was returned
    // all the way to TablePage, then dropped one line from the UI — so the
    // button said FREE on the 101st hunt and silently took five diamonds.
    expect(TABLE_PAGE).toMatch(/vipRemaining: result\.vip_remaining/);
    expect(COMPONENT).toMatch(/vipRemaining/);
    // And the label must stop claiming FREE once the pool is spent.
    expect(COMPONENT).toMatch(/visibleVipRemaining === 0/);
    // That only works if the count is known BEFORE the press. The first attempt
    // set it from the reveal response — which arrives after the press, and the
    // button is unmounted the moment it has been pressed — so the state was
    // never non-null while the label was on screen and the 101st hunt still
    // read FREE. checkVIPStatus already returns monthlyLimits; read it there.
    expect(COMPONENT).toMatch(/monthlyLimits\?\.rabbitHunts/);
    // Dan 2026-08-26: the count renders on the button itself, in the icon's
    // empty lower band — not only inside a toast after the money is spent.
    expect(COMPONENT).toMatch(/rabbit-hunt__remaining/);
  });

  it('the reveal cannot be torn down mid-animation', () => {
    // Awaiting 500ms PER CARD before the first appeared meant a pre-flop fold
    // took 2.5s to finish drawing; the next hand starting inside that window
    // unmounted the panel and the player had paid for cards they never saw.
    // All cards are set at once and CSS staggers them.
    // The hook sets the cards in one go; the tile renders them.
    expect(REVEAL_PATH).toMatch(/setCards\(result\.cards\)/);
    expect(REVEAL_PATH).not.toMatch(/setTimeout\(resolve, 500\)/);
  });

  it('the VIP lookup can never disable the button', () => {
    // isCheckingVIP started true and was only cleared inside the async lookup,
    // so a HUNG (not rejected) VIP query disabled Rabbit Hunt forever with
    // nothing on screen to explain it. The lookup is label-only.
    expect(COMPONENT).toMatch(/disabled=\{isRevealing\}/);
    expect(COMPONENT).not.toMatch(/isCheckingVIP/);
  });

  it('there is exactly one rabbit hunt button', () => {
    // A second button in the control strip called the reveal directly and threw
    // the result away: it spent the reveal, and now the diamonds, showing
    // nothing. That must stay impossible.
    expect((TABLE_PAGE.match(/onClick=\{handleRabbitReveal\}/g) || []).length).toBe(0);

    // UPDATED 2026-08-26: the component moved out of TableModalsLayer and into
    // the HUD stack, so the reveal handler is passed on RabbitHunt's own
    // `onReveal` prop rather than forwarded through the layer as
    // `onRabbitReveal`. Still exactly one wiring of it.
    expect((TABLE_PAGE.match(/onReveal=\{handleRabbitReveal\}/g) || []).length).toBe(1);
    expect(TABLE_PAGE).not.toMatch(/onRabbitReveal=/);
    // And the layer no longer renders one at all.
    expect(read('src/components/table/TableModalsLayer.tsx')).not.toMatch(/<RabbitHunt/);
  });
});
