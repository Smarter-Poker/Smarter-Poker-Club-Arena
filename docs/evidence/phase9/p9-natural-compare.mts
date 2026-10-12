/**
 * Phase 9 natural evidence (S1): independently re-settle EVERY natural Omaha
 * multi-board bomb and run-it-N hand of the declared population with the
 * offline OmahaReference, and compare with the recorded settlement.
 * Generalized from p92-natural-compare.mts (the 10-hand sample) with the same
 * contribution replay and money rules; classification per declaration.txt.
 * Read-only. Input: NDJSON files written by p9-export.sql (SELECT only).
 * Usage: tsx p9-natural-compare.mts <repo> <per-hand-out.ndjson> <files...>
 * Prints the aggregate JSON (no ids, no cards) on stdout.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

const [, , repo, perHandOut, ...files] = process.argv;
const ref = await import(repo + '/server/src/benchmark/OmahaReference.ts');
const { settleOmahaReference, referenceDeck, OMAHA_RULES, OMAHA_REFERENCE_VERSION } = ref;

type Card = { rank: string; suit: string };
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
class Excluded extends Error {
  constructor(public reason: string, public detail = '') {
    super(reason);
  }
}
function card(s: string): Card {
  const suit = SUITS.find((x) => typeof s === 'string' && s.endsWith(x));
  const rank = suit ? s.slice(0, s.length - suit.length) : '';
  if (!suit || !/^[2-9TJQKA]$/.test(rank)) throw new Excluded('board_card_unparsed');
  return { rank, suit };
}
const key = (c: Card) => c.rank + ':' + c.suit;
const cents = (n: number) => Math.round(n * 100);
const hashId = (id: string) => createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
const isNum = (x: unknown) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));

function settle(h: any) {
  const notes: string[] = [];
  const unknown: string[] = [];
  if (!(h.variant in OMAHA_RULES)) throw new Excluded('variant_not_in_reference');
  const extra = Array.isArray(h.rit) ? h.rit.length : 0;
  const hasCc2 = Array.isArray(h.cc2) && h.cc2.length > 0;
  if (extra > 0 && hasCc2) throw new Excluded('bomb_and_rit_together');
  const boardsRaw: any[] = extra > 0 ? [h.cc, ...h.rit] : [h.cc, h.cc2, h.cc3].filter((b) => Array.isArray(b) && b.length > 0);
  if (boardsRaw.some((b) => !Array.isArray(b) || b.length > 5)) throw new Excluded('board_malformed');
  const boards: Card[][] = boardsRaw.map((b: string[]) => b.map(card));
  const incompleteBoards = boards.some((b) => b.length !== 5);
  if (extra === 0 && h.bomb && isNum(h.bomb.board_count) && Number(h.bomb.board_count) !== boards.length)
    throw new Excluded('board_count_disagrees');
  let prefix = 0;
  if (extra > 0) while (prefix < 5 && boards.every((b) => key(b[prefix]) === key(boards[0][prefix]))) prefix++;
  if (!isNum(h.pot)) throw new Excluded('pot_size_not_recorded');
  if (!isNum(h.rake) || !isNum(h.bbj)) throw new Excluded('deduction_amounts_not_recorded');
  if (!Array.isArray(h.pots) || h.pots.length === 0) throw new Excluded('pots_not_recorded');
  if (!Array.isArray(h.winners) || h.winners.length === 0) throw new Excluded('winners_not_recorded');
  if (!isNum(h.button)) throw new Excluded('button_not_recorded');
  if (!Array.isArray(h.players) || !Array.isArray(h.actions)) throw new Excluded('players_or_actions_not_recorded');
  const chipUnit = h.pn?.chipUnit === 1 ? 1 : 0.01;
  if (chipUnit !== 0.01) throw new Excluded('chip_unit_not_cents');

  // Contribution replay, exactly as p92-natural-compare.mts.
  const seatOf = new Map<string, number>(h.players.map((p: any) => [p.u, p.s]));
  const contrib = new Map<string, number>();
  const street = new Map<string, number>();
  const folded = new Set<string>();
  const raiseModes: string[] = [];
  const deadAntePosters = h.actions.filter((a: any) => a.a === 'ante' && a.d === true).length;
  // Production's pot rule (PokerEngine.calculatePots): individual antes are
  // matched; a shared big blind ante and a dead blind post are pooled dead
  // money. The ante type is read from the hand's own captured node when
  // present, else from the poster count (the 10-hand sample's rule).
  const anteType = h.pn?.anteType;
  const anteBasis = anteType === 'big_blind' || anteType === 'per_player' ? 'captured_ante_type' : 'poster_count';
  const sharedAnte = anteType === 'big_blind' ? true : anteType === 'per_player' ? false : deadAntePosters === 1;
  const pooled = new Map<string, number>();
  const deferred: { u: string; streetBefore: number }[] = [];
  let stage: string | null = null;
  const acts = h.actions.filter((a: any) => a.u && a.u !== 'system');
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (!seatOf.has(a.u)) throw new Excluded('actor_not_in_players');
    if (a.st !== stage) {
      stage = a.st;
      street.clear();
    }
    const m = cents(Number(a.m ?? 0));
    const add = (u: string, c: number, live: boolean) => {
      contrib.set(u, (contrib.get(u) ?? 0) + c);
      if (live) street.set(u, (street.get(u) ?? 0) + c);
    };
    switch (a.a) {
      case 'ante':
      case 'bomb_ante':
        add(a.u, m, a.d === false);
        if (a.a === 'ante' && a.d === true && sharedAnte) pooled.set(a.u, (pooled.get(a.u) ?? 0) + m);
        break;
      case 'post':
        add(a.u, m, a.d !== true);
        if (a.d === true) {
          pooled.set(a.u, (pooled.get(a.u) ?? 0) + m);
          notes.push('pooled_dead_blind_post');
        }
        break;
      case 'kill_blind':
      case 'sb':
      case 'bb':
      case 'straddle':
      case 'call':
      case 'bet':
        add(a.u, m, true);
        break;
      case 'all_in':
      case 'raise': {
        const next = acts.slice(i + 1).find((x: any) => x.pn_total)?.pn_total;
        const seat = String(seatOf.get(a.u));
        const before = contrib.get(a.u) ?? 0;
        const asAdd = before + m;
        const asTo = before + m - (street.get(a.u) ?? 0);
        if (next && next[seat] !== undefined && cents(Number(next[seat])) === asAdd) {
          add(a.u, m, true);
          raiseModes.push(a.a + '_additional');
        } else if (next && next[seat] !== undefined && cents(Number(next[seat])) === asTo) {
          add(a.u, m - (street.get(a.u) ?? 0), true);
          raiseModes.push(a.a + '_street_total');
        } else if ((street.get(a.u) ?? 0) === 0) {
          add(a.u, m, true);
          raiseModes.push(a.a + '_unambiguous');
        } else {
          deferred.push({ u: a.u, streetBefore: street.get(a.u) ?? 0 });
          add(a.u, m, true);
        }
        break;
      }
      case 'return':
        add(a.u, -m, false);
        break;
      case 'fold':
        folded.add(a.u);
        break;
      case 'check':
        break;
      default:
        throw new Excluded('unhandled_action', String(a.a));
    }
    const next = acts[i + 1]?.pn_total;
    if (next)
      for (const [u, s] of seatOf) {
        if (next[String(s)] === undefined) continue;
        if (cents(Number(next[String(s)])) !== (contrib.get(u) ?? 0))
          throw new Excluded('replay_disagrees_with_capture');
      }
  }
  let total = [...contrib.values()].reduce((s, n) => s + n, 0);
  if (deferred.length === 1 && total - cents(Number(h.pot)) === deferred[0].streetBefore) {
    const u = deferred[0].u;
    contrib.set(u, (contrib.get(u) ?? 0) - deferred[0].streetBefore);
    total -= deferred[0].streetBefore;
    raiseModes.push('last_street_total_by_pot_size');
  } else if (deferred.length) {
    throw new Excluded('unresolved_raise_amount');
  }
  if (total !== cents(Number(h.pot))) throw new Excluded('replay_pot_size_disagrees');

  const holes = OMAHA_RULES[h.variant].holes;
  const hole = h.hole && typeof h.hole === 'object' ? h.hole : {};
  const holeCards = (u: string): Card[] | undefined =>
    Array.isArray(hole[u]) ? hole[u].map((c: any) => ({ rank: String(c.rank), suit: String(c.suit) })) : undefined;
  const live = [...contrib].filter(([u, c]) => c > 0 && !folded.has(u)).map(([u]) => u);
  const contested = live.length > 1;
  if (incompleteBoards) {
    if (contested) throw new Excluded('board_incomplete_contested');
    notes.push('uncontested_board_completed_by_standin');
  }
  const used = new Set<string>([
    ...boards.flatMap((b) => b.map(key)),
    ...Object.keys(hole).flatMap((u) => (holeCards(u) ?? []).map(key)),
  ]);
  const spare = referenceDeck().filter((c: Card) => !used.has(key(c)));
  // An uncontested hand scores no hand, so missing board cards only satisfy
  // the reference's five-card precondition (no award depends on them).
  for (const b of boards) while (b.length < 5) b.push(spare.shift()!);
  const players: any[] = [];
  for (const [u, c] of contrib) {
    if (c < 0) throw new Excluded('negative_contribution');
    if (c === 0) continue;
    const isFolded = folded.has(u);
    let cards = holeCards(u);
    if (cards && cards.some((x) => !/^[2-9TJQKA]$/.test(x.rank) || !SUITS.includes(x.suit)))
      throw new Excluded('hole_card_unparsed');
    if (!cards) {
      if (!isFolded && contested) throw new Excluded('live_eligible_cards_not_recorded');
      cards = spare.splice(0, holes);
    } else if (isFolded) {
      notes.push('folded_seat_has_recorded_cards');
    }
    if (cards.length !== holes) throw new Excluded('hole_card_count_disagrees');
    players.push({ id: u, seat: seatOf.get(u), cards, contributed: c / 100, folded: isFolded });
  }
  const deadTotal = [...pooled.values()].reduce((s, n) => s + n, 0);
  if (deadTotal > 0) {
    for (const p of players) {
      const own = pooled.get(p.id) ?? 0;
      if (own) p.contributed = Math.round(p.contributed * 100 - own) / 100;
    }
    const usedSeats = new Set(players.map((p) => p.seat));
    const freeSeat = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((n) => !usedSeats.has(n));
    if (players.some((p) => !p.folded && cents(p.contributed) < deadTotal))
      throw new Excluded('pooled_dead_money_encoding_does_not_hold');
    players.push({ id: 'pooled-dead-money', seat: freeSeat, cards: spare.splice(0, holes), contributed: deadTotal / 100, folded: true });
    notes.push(sharedAnte && deadAntePosters ? 'pooled_shared_bb_ante' : 'pooled_dead_money');
  }
  let expected: any;
  try {
    expected = settleOmahaReference({ variant: h.variant, players, boards, sharedPrefixLength: prefix, chipUnit, dealerSeat: Number(h.button) });
  } catch (e: any) {
    throw new Excluded('reference_threw', String(e?.message ?? e).slice(0, 80));
  }
  const short = (u: string) => (u === 'pooled-dead-money' ? 'dead' : `s${seatOf.get(u) ?? '?'}`);
  const fails: string[] = [];

  // (a) pots
  const refPots = expected.pots.map((p: any) => `${cents(p.amount)}[${p.eligible.map(short).sort().join(',')}]`);
  const recPots = h.pots.map((p: any) => `${cents(Number(p.amount))}[${(p.eligible ?? []).map(short).sort().join(',')}]`);
  const potsOk = JSON.stringify(refPots) === JSON.stringify(recPots);
  if (!potsOk) fails.push(`pots reference ${refPots.join(' ')} recorded ${recPots.join(' ')}`);
  if (Object.keys(expected.refunds).length) notes.push('reference_refund_present');

  // (b) conservation and (c) per player
  const gross = cents(Number(h.pot));
  const net = gross - cents(Number(h.rake)) - cents(Number(h.bbj));
  const recWin = new Map<string, number>();
  for (const w of h.winners) {
    if (!w.u || !isNum(w.a)) throw new Excluded('winner_entry_malformed');
    recWin.set(w.u, (recWin.get(w.u) ?? 0) + cents(Number(w.a)));
  }
  const recSum = [...recWin.values()].reduce((s, n) => s + n, 0);
  const consOk = recSum === net;
  if (!consOk) fails.push(`conservation recorded payouts ${recSum} vs net ${net} (gross ${gross} rake ${cents(Number(h.rake))} bbj ${cents(Number(h.bbj))}) cents`);
  let payOk = true;
  let maxDev = 0;
  const ids = new Set([...Object.keys(expected.totals).filter((u) => expected.totals[u] > 0), ...recWin.keys()]);
  for (const u of ids) {
    const pre = cents(expected.totals[u] ?? 0);
    const exact = gross > 0 ? (pre * net) / gross : 0;
    const rec = recWin.get(u) ?? 0;
    const dev = Math.abs(rec - exact);
    maxDev = Math.max(maxDev, dev);
    if (!(dev < 1)) {
      payOk = false;
      fails.push(`payout ${short(u)} reference pre ${pre} exact ${(exact).toFixed(4)} recorded ${rec} cents`);
    }
  }

  // (d) per board and half
  let boardStatus: 'match' | 'mismatch' | 'not_recorded' = 'match';
  if (!Array.isArray(h.wbb) || h.wbb.length === 0) {
    boardStatus = 'not_recorded';
  } else {
    const k = (b: number, u: string, half: string) => (contested ? `b${b} ${short(u)} ${half}` : `b${b} ${short(u)}`);
    const refBB = new Map<string, number>();
    for (const a of expected.awards) {
      const kk = k(a.boardIndex + 1, a.playerId, a.half);
      refBB.set(kk, (refBB.get(kk) ?? 0) + cents(a.amount));
    }
    const recBB = new Map<string, number>();
    for (const w of h.wbb) {
      if (!isNum(w.board) || !w.userId || !isNum(w.amount)) throw new Excluded('winners_by_board_entry_malformed');
      const kk = k(Number(w.board), w.userId, w.low ? 'low' : 'high');
      recBB.set(kk, (recBB.get(kk) ?? 0) + cents(Number(w.amount)));
    }
    for (const kk of new Set([...refBB.keys(), ...recBB.keys()])) {
      const pre = refBB.get(kk) ?? 0;
      const exact = gross > 0 ? (pre * net) / gross : 0;
      const rec = recBB.get(kk);
      const ok = rec !== undefined ? Math.abs(rec - exact) < 1 : pre === 0;
      if (!ok) {
        boardStatus = 'mismatch';
        fails.push(`board ${kk} reference ${pre} exact ${exact.toFixed(4)} recorded ${rec === undefined ? 'absent' : rec} cents`);
      }
    }
  }

  // Descriptive only (not a declared rule): why a board check failed.
  let boardFailureKind: string | null = null;
  if (boardStatus === 'mismatch' && potsOk && consOk && payOk) {
    const recByUser = new Map<string, { sum: number; n: number }>();
    for (const w of h.wbb) {
      const e = recByUser.get(w.userId) ?? { sum: 0, n: 0 };
      e.sum += cents(Number(w.amount));
      e.n++;
      recByUser.set(w.userId, e);
    }
    const preRake = h.wbb.every((w: any) => {
      const pre = expected.awards
        .filter((a: any) => a.boardIndex + 1 === Number(w.board) && a.playerId === w.userId && (a.half === 'low') === (w.low === true))
        .reduce((s: number, a: any) => s + cents(a.amount), 0);
      return pre === cents(Number(w.amount));
    });
    const sumsEqualPayout = [...recByUser].every(([u, e]) => e.sum === (recWin.get(u) ?? 0));
    const refEntries = new Map<string, number>();
    for (const a of expected.awards) refEntries.set(a.playerId, (refEntries.get(a.playerId) ?? 0) + 1);
    const withinEntryCount = h.wbb.every((w: any) => {
      const pre = expected.awards
        .filter((a: any) => a.boardIndex + 1 === Number(w.board) && a.playerId === w.userId && (a.half === 'low') === (w.low === true))
        .reduce((s: number, a: any) => s + cents(a.amount), 0);
      const exact = (pre * net) / gross;
      return Math.abs(cents(Number(w.amount)) - exact) < (recByUser.get(w.userId)?.n ?? 1);
    });
    boardFailureKind = preRake && gross !== net
      ? 'board_entries_equal_pre_deduction_shares'
      : sumsEqualPayout && withinEntryCount
        ? 'per_player_sum_exact_entry_off_by_rounding_repair'
        : 'board_breakdown_unexplained';
  }

  // (e) deductions, separately
  let deduction: string;
  const d = h.pn?.deductions;
  if (!d || d.status !== 'captured' || !d.rake) {
    deduction = d && d.status ? `unknown_${d.status}_${d.reason ?? ''}` : 'unknown_not_captured';
  } else {
    const dealt = h.players.length;
    const caps = Array.isArray(d.rake.playerCountCaps) ? d.rake.playerCountCaps : [];
    const tier = [...caps].sort((a: number[], b: number[]) => b[0] - a[0]).find((t: number[]) => dealt >= t[0]);
    const cap = cents(tier ? tier[1] : d.rake.cap);
    const pct = dealt <= 2 ? Math.min(d.rake.percent, 5) : d.rake.percent;
    const rakeC = Math.min(Math.round(Number(h.pot) * pct), cap);
    const bbjC = d.bbj && d.bbj.enabled && dealt >= d.bbj.minPlayersDealt ? Math.round(Number(h.bb) * d.bbj.feeBB * 100) : 0;
    const rakeOk = rakeC === cents(Number(h.rake));
    const bbjOk = bbjC === cents(Number(h.bbj));
    deduction = rakeOk && bbjOk ? 'match' : 'mismatch';
    if (!(rakeOk && bbjOk))
      notes.push(`deduction expected rake ${rakeC} bbj ${bbjC} recorded rake ${cents(Number(h.rake))} bbj ${cents(Number(h.bbj))} cents, dealt ${dealt}`);
  }

  const moneyOk = potsOk && consOk && payOk && boardStatus !== 'mismatch';
  const verdict = !moneyOk ? 'MISMATCH' : boardStatus === 'not_recorded' ? 'MATCH_PARTIAL' : 'MATCH';
  notes.push(anteBasis);
  return { verdict, contested, deduction, fails, notes, boardFailureKind, raiseModes: [...new Set(raiseModes)], maxDevCents: maxDev, prefix, boards: boards.length };
}

const agg: any = { total: 0, verdicts: {}, excluded: {}, deduction: {}, cells: {}, notes: {}, raiseModes: {}, mismatches: [], maxPayoutDeviationCents: 0, contested: { contested: 0, uncontested: 0 } };
const inc = (o: any, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);
const perHand: string[] = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const h = JSON.parse(line);
    agg.total++;
    const extra = Array.isArray(h.rit) ? h.rit.length : 0;
    const feature = extra > 0 ? `rit_${1 + extra}` : `bomb_${[h.cc, h.cc2, h.cc3].filter((b) => Array.isArray(b) && b.length > 0).length}`;
    const mode = h.pn?.mode ? `${h.pn.mode}_${h.pn.asset}` : h.tour ? 'tournament_unknown_asset' : 'cash_asset_not_captured';
    const cellKey = `${h.variant}|${mode}|${feature}|${h.has_human ? 'human' : 'horse_only'}`;
    const cell = (agg.cells[cellKey] ??= { total: 0 });
    cell.total++;
    let r: any;
    try {
      r = settle(h);
    } catch (e: any) {
      if (!(e instanceof Excluded)) throw e;
      const reason = e.reason + (e.reason === 'unhandled_action' ? `:${e.detail}` : '');
      inc(agg.excluded, reason);
      inc(cell, 'excluded:' + reason);
      perHand.push(JSON.stringify({ id: h.id, table: h.table, hn: h.hn, verdict: 'EXCLUDED', reason, detail: e.detail, feature, variant: h.variant }));
      continue;
    }
    inc(agg.verdicts, r.verdict);
    inc(cell, r.verdict);
    inc(agg.deduction, r.deduction);
    inc(cell, 'deduction:' + r.deduction);
    inc(agg.contested, r.contested ? 'contested' : 'uncontested');
    for (const n of r.notes) inc(agg.notes, n.startsWith('deduction expected') ? 'deduction_mismatch_detail' : n);
    for (const m of r.raiseModes) inc(agg.raiseModes, m);
    agg.maxPayoutDeviationCents = Math.max(agg.maxPayoutDeviationCents, r.maxDevCents);
    if (r.verdict === 'MISMATCH') {
      const failed = [...new Set(r.fails.map((f: string) => f.split(' ')[0]))].sort().join('+');
      inc((agg.mismatchByCheck ??= {}), failed);
      if (r.boardFailureKind) inc((agg.boardOnlyMismatchDescription ??= {}), r.boardFailureKind);
      agg.mismatches.push({ hand: hashId(h.id), createdAt: h.created_at, cell: cellKey, contested: r.contested, failedChecks: failed, description: r.boardFailureKind, fails: r.fails });
    }
    if (r.deduction === 'mismatch') (agg.deductionMismatches ??= []).push({ hand: hashId(h.id), createdAt: h.created_at, cell: cellKey, detail: r.notes.filter((n: string) => n.startsWith('deduction expected')) });
    perHand.push(JSON.stringify({ id: h.id, table: h.table, hn: h.hn, verdict: r.verdict, deduction: r.deduction, feature, variant: h.variant, boards: r.boards, failedChecks: r.verdict === 'MISMATCH' ? [...new Set(r.fails.map((f: string) => f.split(' ')[0]))].sort().join('+') : null }));
  }
}
agg.reference = OMAHA_REFERENCE_VERSION;
agg.maxPayoutDeviationCents = Number(agg.maxPayoutDeviationCents.toFixed(4));
writeFileSync(perHandOut, perHand.join('\n') + '\n');
console.log(JSON.stringify(agg, null, 1));
