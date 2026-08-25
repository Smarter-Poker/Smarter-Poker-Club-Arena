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

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SETTLEMENT = strip(read('server/src/engine/ServerTableEngineSettlement.ts'));
const ROUTER = strip(read('server/src/router.ts'));
const HANDLER = strip(read('server/src/handlers/rabbithunt.ts'));
const MIGRATION = read('supabase/migrations/20260825_fn_consume_rabbit_hunt.sql');
const COMPONENT = strip(read('src/components/table/RabbitHunt.tsx'));
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
const API = strip(read('src/services/GameServerAPI.ts'));

describe('the cards never go out in a broadcast', () => {
  it('rabbit_hunt_available carries no cards', () => {
    const at = SETTLEMENT.indexOf("type: 'rabbit_hunt_available'");
    expect(at, 'the availability event was not found').toBeGreaterThan(-1);
    const event = SETTLEMENT.slice(at, at + 500);
    // The exact field that leaked. Its absence is the whole fix.
    expect(event).not.toMatch(/rabbit_cards/);
    expect(event).toMatch(/cards_available/);
  });

  it('the client cannot read cards off the event even if one reappears', () => {
    const at = TABLE_PAGE.indexOf("eventType === 'rabbit_hunt_available'");
    expect(at, 'the client handler was not found').toBeGreaterThan(-1);
    const handler = TABLE_PAGE.slice(at, at + 700);
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
    const body = SETTLEMENT.slice(at, at + 4000);
    const charge = body.indexOf('fn_consume_rabbit_hunt');
    const answer = body.indexOf('offer.revealed.add');
    expect(charge, 'the reveal does not call the billing RPC').toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(charge);
  });

  it('a failed charge reveals nothing', () => {
    const at = SETTLEMENT.indexOf('revealRabbitHunt');
    const body = SETTLEMENT.slice(at, at + 4000);
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
    const body = SETTLEMENT.slice(at, at + 4000);
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
    const handler = TABLE_PAGE.slice(at, at + 700);
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
    const at = SETTLEMENT.indexOf('rabbitHuntOffers.set');
    const block = SETTLEMENT.slice(at, at + 1200);
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

  it('a VIP is told how many free hunts are left', () => {
    // vip_remaining is counted by the server on every reveal and was returned
    // all the way to TablePage, then dropped one line from the UI — so the
    // button said FREE on the 101st hunt and silently took five diamonds.
    expect(TABLE_PAGE).toMatch(/vipRemaining: result\.vip_remaining/);
    expect(COMPONENT).toMatch(/vipRemaining/);
    // And the label must stop claiming FREE once the pool is spent.
    expect(COMPONENT).toMatch(/vipRemaining === 0/);
  });

  it('the reveal cannot be torn down mid-animation', () => {
    // Awaiting 500ms PER CARD before the first appeared meant a pre-flop fold
    // took 2.5s to finish drawing; the next hand starting inside that window
    // unmounted the panel and the player had paid for cards they never saw.
    // All cards are set at once and CSS staggers them.
    expect(COMPONENT).toMatch(/setRevealedCards\(result\.cards\)/);
    expect(COMPONENT).not.toMatch(/setTimeout\(resolve, 500\)/);
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
    // the result away: it spent the reveal, and now the diamonds, showing nothing.
    expect((TABLE_PAGE.match(/onClick=\{handleRabbitReveal\}/g) || []).length).toBe(0);
    expect(TABLE_PAGE).toMatch(/onRabbitReveal=\{handleRabbitReveal\}/);
  });
});
