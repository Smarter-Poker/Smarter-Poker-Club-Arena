"""Horse Brain Phase 11 P11.1 natural evidence for PLO5, PLO6 and PLO8, read-only, on the engine host.

Implements docs/evidence/phase11/declaration-p11-1.txt (declared 2026-10-04T19:33:30Z,
sha256 b153ead56266359208c827b123a8e815a49e7b413bc48ac1882b6089cfe958ad). Adapted from the
committed docs/evidence/phase10/p10-blindseats-journal-observe.py (sha256
c96082324d881dcfffdd861df6350e7303dbb6b9eed83787492f51a52db2e195): the record schema, digest,
canonical JSON, segment discovery and the B3 position logic are kept unchanged in meaning; the
checks are D1-D8 of the declaration. The mapping from each declared check to the real journal
fields is in FIELD_MAP below and is copied into the output artifact; every adaptation is listed
in EXTENSIONS.

Reads segment files only (never opens the journal or its catalog, for writing or otherwise); run
under nice 19 / ionice idle, detached. Every check is recomputed here, independently of the engine
code: the record schema, the record digest, the canonical JSON, the census, the pot-limit
geometry, the depth and the witness input hash (sorted-key canonical JSON of
decision.omahaVariantPolicy.inputs, SHA-256, with each number kept as the exact literal the
journal wrote).

argv: <window-start-iso> <window-end-iso> <serving-release-sha> <out.json>
"""
import os, sys, gzip, json, time, hashlib, re, calendar
from collections import Counter, defaultdict

DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
VARIANTS = ('plo5', 'plo6', 'plo8')
PACK_VERSION = {'plo5': 'plo5-high-round1-v2', 'plo6': 'plo6-high-round1-v2', 'plo8': 'plo8-split-round1-v2'}
PACK_HOLES = {'plo5': 5, 'plo6': 6, 'plo8': 4}
PACK_SPLIT = {'plo5': False, 'plo6': False, 'plo8': True}
# omahaVariantSeatCap at d770a32718: cash = maxSeatsForVariant, tournament = min(10, maxSeatsFor(deck)).
SEAT_CAP = {('plo5', 'cash'): 7, ('plo6', 'cash'): 6, ('plo8', 'cash'): 8,
            ('plo5', 'tournament'): 9, ('plo6', 'tournament'): 7, ('plo8', 'tournament'): 10}
BINDING_VERSION = 'omaha-variant-input-binding-v1'
WITNESS_VERSION = 'horse-phase11-input-binding-v1'
MAX_DEPTH_BB = 250
SEG_LOWER_MARGIN_S = 120   # a segment closed before the window cannot hold a record decided in it
DEFECT_SAMPLE = 25
D_DEFECT_IDS = 500

FIELD_MAP = {
    'population': 'journal records with kind == "decision"; decision time = body.snapshot.decisionTimeMs (the decision '
                  'instant, not the journal atMs); variant = body.snapshot.gameState.gameVariant in (plo5, plo6, plo8) '
                  'and single board = gameState.boardCount in (absent, null, 1) with no communityCards2/3; '
                  'cash/tournament = gameState.gameMode; release = record.sourceRelease',
    'variant_policy_step': 'body.decision.policyGraph.transitions[].node == "variant_policy"',
    'D1': 'body.decision.omahaVariantPolicy present; inputs field present; eligible is boolean; eligible == (inputs is '
          'an object); a refused receipt (eligible false) carries inputs null and reason matching '
          '^[a-z][a-z0-9_]{0,127}$; an eligible binding has inputs.version == omaha-variant-input-binding-v1 and '
          'inputs.variant == the record variant. A decision whose receipt the client dropped '
          '(phase11_shadow_receipt_binding_dropped) has a variant_policy step and no omahaVariantPolicy, so it fails '
          'D1 as omahaVariantPolicy_missing and is listed by identifier, never dropped',
    'D2': 'receipt.version and inputs.pack.version == the variant pack version (plo5-high-round1-v2, '
          'plo6-high-round1-v2, plo8-split-round1-v2), and decision.policyOwnership.packVersion when present; '
          'inputs.pack.calibratedConfidence null; inputs.pack.holes / splitPot equal the variant; '
          'inputs.approximation.solverInput false; inputs.approximation.handShape {kind heuristic_entry_score, '
          'probability false}; inputs.range.provenance (when non-null) {calibration uncalibrated, solverInput false, '
          'reads public_action_line_only}; and no other calibration or true solverInput anywhere in the binding',
    'D3': 'inputs.census: contestingOpponentSeats subset of dealtSeats, disjoint from foldedSeats and awaySeats; '
          'heroSeat in dealtSeats and not in foldedSeats; 2 <= len(dealtSeats) <= SEAT_CAP[variant, gameMode]; '
          'inputs.pack.seats == [2, SEAT_CAP] and pack.seatCapOwner == cash_table_seating (cash) or '
          'tournament_deck_capacity (tournament)',
    'D4': 'when inputs.range.provenance is non-null: the set of (userId, seat) in provenance.opponents equals the '
          'contesting seats with their user ids from body.snapshot.gameState.players; prior.seatDraws == '
          'work.completedSamples * deck.dealtOpponents; deck.dealtOpponents == len(census.dealtSeats) - 1',
    'D5': 'from the recorded snapshot (gameState.pot, currentBet, bigBlind, maxRaiseTo; player.stack, bet; the contesting '
          'players stack+bet): geometry scalars equal the snapshot; callCost == min(heroStack, max(0, currentBet - '
          'heroBet)); potLimitRaiseTo == currentBet + pot + callCost; stackRaiseTo == heroBet + heroStack; wagerCap == '
          'min(maxRaiseTo, stackRaiseTo, potLimitRaiseTo), null iff maxRaiseTo null; effective depth = min(hero '
          'stack+bet, deepest contesting stack+bet) / BB == inputs.depth.effectiveBB and <= 250 on every eligible '
          'proposal; every refused decision with recomputed depth > 250 is named depth_or_ante_outside_pack unless its '
          'refusal is one the policy takes before the depth check (REFUSED_BEFORE_DEPTH)',
    'D6': 'the execution record joined on (producerId, turnKey): phase11Inputs {version horse-phase11-input-binding-v1, '
          'variant == inputs.variant, inputSha256 == recomputed sha256 of canonical inputs, rangeStatus == '
          'inputs.range.status} on an eligible decision; phase11Inputs null on a refused decision (absent counts as '
          'a failure, witness_binding_field_absent)',
    'D7': 'the Phase 10 B3 logic, unchanged, applied to every eligible binding: census.blindSeats equals '
          'snapshot.gameState.blindSeats exactly and census.dealerSeat == gameState.dealerSeat; recomputed from '
          'census.dealerSeat and census.dealtSeats alone: cw = dealt seats clockwise starting after the dealer seat; '
          'posted blinds are the first seats of cw excluding an occupied button (smallBlind then bigBlind, or bigBlind '
          'alone when smallBlind is null, only at a tournament table of 3 or more), heads-up smallBlind is the button; '
          'heroOffset == (index of hero in cw + 1) mod n; expected labels: button for the last seat of cw, big_blind / '
          'small_blind for the posted seats, then for the seats strictly between the big blind and the last seat: '
          'cutoff for the last, early for the first, middle otherwise; hero and aggressor labels must equal them; an '
          'empty dealer seat only at a tournament table of 3 or more',
    'D8': 'every population record that carries omahaVariantPolicy: mode == shadow and applied == false',
    'reported': 'counts by variant, gameMode, street, hero position, depth band, range status, refusal name and '
                'reason; sampler work from inputs.range.provenance.work (requested, completed, budgetExhausted) and '
                'prior.uniformEscapes / seatDraws by variant and street; reason work_budget by street and eligibility; '
                'dead-button (gameState.dealerSeat not dealt) and dead-small-blind (gameState.blindSeats.smallBlind '
                'null) decisions by mode, street and outcome; accepted action from the joined execution witness and '
                'whether it equals the baseline',
    'exclusions': 'each decision record takes the first matching name, in this order: unreadable_record, outside_window, '
                  'release_other, not_phase11_variant (other variant, or multi-board plo5/plo6/plo8 under '
                  'phase11_multiboard), no_variant_policy_step. unreadable_record counts every line or segment in the '
                  'scanned set that failed to decode or failed the journal schema, whatever its kind or time',
}
EXTENSIONS = [
    'population variants plo5/plo6/plo8 (was plo4); receipt read from decision.omahaVariantPolicy (was plo4Policy)',
    'execution witness kept when identity.variant is plo5/plo6/plo8, with phase11Inputs (no read frame: the variant sampler reads the public action line only)',
    'pack versions, holes, split flag and seat ceilings per variant and mode (SEAT_CAP, read from source at d770a32718)',
    'D4 adds the provenance draw/deck arithmetic; D5 uses the Phase 11 pot-limit rule currentBet + pot + callCost',
    'REFUSED_BEFORE_DEPTH follows the evaluateOmahaVariantPolicy order at d770a32718',
    'D7 is the b3_failures function of the Phase 10 scanner, copied without change',
    'reported: sampler work and uniform escapes, work_budget by street, river completion',
    'the shared part (iso parsing, canonical JSON, schema_error, segment discovery) is copied verbatim',
]

ws_iso, we_iso, release, out_path = sys.argv[1:5]

def iso_epoch(s):
    return calendar.timegm(time.strptime(s.replace('Z', '').split('.')[0], '%Y-%m-%dT%H:%M:%S'))
def iso_ms_ceil(s):
    """The exact instant in ms, rounded up: an integer decisionTimeMs dt satisfies dt >= instant iff dt >= ceil."""
    from decimal import Decimal, ROUND_CEILING
    frac = s.replace('Z', '').split('.')[1] if '.' in s else '0'
    return int((Decimal(iso_epoch(s)) * 1000 + Decimal('0.' + frac) * 1000).to_integral_value(rounding=ROUND_CEILING))
WS, WE = iso_epoch(ws_iso), iso_epoch(we_iso)
WS_MS, WE_MS = iso_ms_ceil(ws_iso), iso_ms_ceil(we_iso)
iso = lambda e: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(e))

# ---- canonical JSON, independent of the engine --------------------------------------
class Num(str):
    """A JSON number kept as the exact literal the journal (JS JSON.stringify) wrote."""
def parse_raw(text):
    return json.loads(text, parse_float=Num, parse_int=Num, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
def canon(v):
    if isinstance(v, Num): return str(v)
    if v is None: return 'null'
    if v is True: return 'true'
    if v is False: return 'false'
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list): return '[' + ','.join(canon(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canon(v[k]) for k in sorted(v)) + '}'
    raise ValueError('not JSON')
sha = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
SHA = re.compile(r'^[0-9a-f]{64}$')
REL = re.compile(r'^[0-9a-f]{40}$')
KINDS = {'decision', 'execution', 'accepted_hand', 'discard_decision', 'discard_execution', 'request_lifecycle'}
RECORD_KEYS = {'version', 'producerId', 'sequence', 'eventId', 'atMs', 'sourceRelease', 'kind', 'handKey', 'turnKey', 'body', 'sha256', 'bytes'}
def isint(x): return isinstance(x, int) and not isinstance(x, bool) and abs(x) <= 2**53 - 1
def schema_error(r, line):
    """The journal's own validateHorseJournalRecord, reimplemented; returns a name or None."""
    if not isinstance(r, dict) or set(r) != RECORD_KEYS: return 'shape'
    if r.get('version') != 1 or not isinstance(r.get('producerId'), str) or not UUID.match(r['producerId']): return 'identity'
    if not isint(r.get('sequence')) or r['sequence'] < 1 or not isint(r.get('atMs')) or r['atMs'] < 0: return 'sequence_or_time'
    sr = r.get('sourceRelease')
    if sr is not None and (not isinstance(sr, str) or not REL.match(sr)): return 'source_release'
    if r.get('kind') not in KINDS: return 'kind'
    if not isinstance(r.get('handKey'), str) or not SHA.match(r['handKey']) or not isinstance(r.get('turnKey'), str) or not SHA.match(r['turnKey']): return 'keys'
    b = r.get('body')
    if not isinstance(b, str) or not isint(r.get('bytes')) or r['bytes'] < 1 or r['bytes'] > 524288 or len(b.encode('utf-8')) != r['bytes']: return 'body_bytes'
    if not isinstance(r.get('sha256'), str) or not SHA.match(r['sha256']): return 'digest_shape'
    dig = sha(json.dumps([r['version'], r['producerId'], r['sequence'], r['eventId'], r['atMs'], r['sourceRelease'], r['kind'],
                          r['handKey'], r['turnKey'], r['bytes'], b], ensure_ascii=False, separators=(',', ':')))
    if dig != r['sha256']: return 'record_digest'
    if r.get('eventId') != sha(json.dumps(['horse-journal-event-v1', r['producerId'], r['sequence']], separators=(',', ':'))): return 'event_id'
    try:
        if canon(parse_raw(b)) != b: return 'body_not_canonical'
        if canon(parse_raw(line)) != line: return 'line_not_canonical'
    except Exception:
        return 'body_json'
    return None

# ---- segment discovery -------------------------------------------------------------------
t0 = time.time()
coverage = {}
cand = []
for d in DIRS:
    info = {'segments': 0, 'oldestMtime': None, 'newestMtime': None, 'scannedSegments': 0}
    oldest, newest = 1e20, 0
    with os.scandir(d) as it:
        for e in it:
            if not e.name.endswith('.ndjson.gz'): continue
            try: m = e.stat().st_mtime
            except FileNotFoundError: continue
            info['segments'] += 1
            oldest = min(oldest, m); newest = max(newest, m)
            if m >= WS - SEG_LOWER_MARGIN_S: cand.append((m, e.path, d))
    info['oldestMtime'] = iso(oldest) if info['segments'] else None
    info['newestMtime'] = iso(newest) if info['segments'] else None
    info['oldestBeforeWindowStart'] = bool(info['segments']) and oldest < WS
    coverage[d] = info
cand.sort()

# ---- read ---------------------------------------------------------------------------------
unreadable = Counter()
unreadable_ids = []
kinds_in_window = Counter()
decisions_read = 0
executions = defaultdict(list)
excl = Counter()
excl_detail = {'release_other': Counter(), 'not_phase11_variant': Counter()}
pop = []
late_seg = 0
min_dt, max_dt = None, None
seg_rejected = Counter()
for m, path, d in cand:
    coverage[d]['scannedSegments'] += 1
    seg = os.path.basename(path)[:-len('.ndjson.gz')]
    try:
        with open(path, 'rb') as f: comp = f.read()
        raw = gzip.decompress(comp)
        if hashlib.sha256(raw).hexdigest() != seg or not raw.endswith(b'\n'): raise ValueError('segment_digest')
        lines = raw.decode('utf-8').rstrip('\n').split('\n')
        if not 1 <= len(lines) <= 16: raise ValueError('segment_lines')
    except FileNotFoundError:
        seg_rejected['retired_during_scan'] += 1; continue
    except Exception as ex:
        unreadable['segment_unreadable'] += 1
        unreadable_ids.append({'segment': seg, 'reason': 'segment_unreadable:' + str(ex)[:60]}); continue
    for line in lines:
        try: r = json.loads(line)
        except Exception:
            unreadable['record_json'] += 1; unreadable_ids.append({'segment': seg, 'reason': 'record_json'}); continue
        err = schema_error(r, line)
        if err:
            unreadable['schema_' + err] += 1
            unreadable_ids.append({'segment': seg, 'reason': 'schema_' + err, 'producerId': r.get('producerId') if isinstance(r, dict) else None,
                                   'sequence': r.get('sequence') if isinstance(r, dict) else None}); continue
        if r['kind'] == 'execution':
            try:
                wb = json.loads(r['body'])
                if (wb.get('identity') or {}).get('variant') not in VARIANTS: continue
                aa = wb.get('acceptedActions') or []
                executions[(r['producerId'], r['turnKey'])].append({
                    'segment': seg, 'eventId': r['eventId'],
                    'phase11Inputs': wb.get('phase11Inputs', 'absent'),
                    'executionStatus': wb.get('executionStatus'),
                    'acceptedCount': len(aa),
                    'accepted': (aa[0].get('record') if len(aa) == 1 and isinstance(aa[0], dict) else None)})
            except Exception:
                unreadable['execution_body'] += 1
                unreadable_ids.append({'segment': seg, 'reason': 'execution_body', 'producerId': r['producerId'], 'sequence': r['sequence']})
            continue
        if r['kind'] != 'decision':
            if WS_MS <= r['atMs'] < WE_MS: kinds_in_window[r['kind']] += 1
            continue
        try:
            body = json.loads(r['body'])
            dt = body['snapshot']['decisionTimeMs']
            if not isint(dt): raise ValueError()
        except Exception:
            unreadable['decision_body'] += 1
            unreadable_ids.append({'segment': seg, 'reason': 'decision_body', 'producerId': r['producerId'], 'sequence': r['sequence']}); continue
        decisions_read += 1
        min_dt = dt if min_dt is None else min(min_dt, dt); max_dt = dt if max_dt is None else max(max_dt, dt)
        s_ = body['snapshot']; gs_ = s_.get('gameState') or {}
        if not (WS_MS <= dt < WE_MS): excl['outside_window'] += 1; continue
        kinds_in_window['decision'] += 1
        if r['sourceRelease'] != release:
            excl['release_other'] += 1; excl_detail['release_other'][str(r['sourceRelease'])] += 1; continue
        if gs_.get('gameVariant') not in VARIANTS:
            excl['not_phase11_variant'] += 1; excl_detail['not_phase11_variant']['variant:' + str(gs_.get('gameVariant'))] += 1; continue
        if gs_.get('boardCount', 1) not in (1, None) or gs_.get('communityCards2') or gs_.get('communityCards3'):
            excl['not_phase11_variant'] += 1; excl_detail['not_phase11_variant']['phase11_multiboard:' + gs_['gameVariant']] += 1; continue
        tr = ((body.get('decision') or {}).get('policyGraph') or {}).get('transitions') or []
        if not any(isinstance(t, dict) and t.get('node') == 'variant_policy' for t in tr):
            excl['no_variant_policy_step'] += 1; continue
        if m > WE + 1800: late_seg += 1
        pop.append((r, seg))
        del body
    if coverage[d]['scannedSegments'] % 10000 == 0:
        print(iso(time.time()), 'segments', sum(v['scannedSegments'] for v in coverage.values()), 'of', len(cand),
              'population', len(pop), file=sys.stderr, flush=True)

for name in ['release_other', 'not_phase11_variant', 'outside_window', 'unreadable_record', 'no_variant_policy_step']:
    excl.setdefault(name, 0)
excl['unreadable_record'] = sum(unreadable.values())

# ---- checks ---------------------------------------------------------------------------------
REASON = re.compile(r'^[a-z][a-z0-9_]{0,127}$')
# Refusals evaluateOmahaVariantPolicy takes before it reaches the depth check (order at d770a32718).
REFUSED_BEFORE_DEPTH = {'off', 'invalid_mode', 'variant_outside_pack', 'multiboard_owned_by_phase13', 'canonical_state_unavailable',
                        'seat_count_outside_pack', 'blind_seats_unavailable', 'private_state_rejected', 'invalid_geometry',
                        'invalid_wager_geometry'}
checks = {c: {'evaluated': 0, 'passed': 0, 'failed': 0, 'failures': Counter(), 'failureIds': []}
          for c in ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']}
notes = {'D3_awayAllInContesting': 0, 'D3_censusVsSnapshotMismatch': 0, 'D5_proposalAboveWagerCap': 0,
         'D5_depthAboveMaxByReason': Counter(), 'D6_executionMissing': 0, 'D6_executionDuplicate': 0,
         'D7_eligibleWithoutCensusBlindSeats': 0, 'D4_completedDiffersFromRangeSamples': 0,
         'D5_refusedDeepRecomputable': 0}
def ident(r, seg):
    return {'eventId': r['eventId'], 'producerId': r['producerId'], 'sequence': r['sequence'], 'handKey': r['handKey'],
            'turnKey': r['turnKey'], 'segment': seg}
def result(c, r, seg, fails, extra=None):
    ch = checks[c]; ch['evaluated'] += 1
    if fails:
        ch['failed'] += 1
        for f in fails: ch['failures'][f] += 1
        if len(ch['failureIds']) < D_DEFECT_IDS:
            x = ident(r, seg); x['failures'] = fails
            if extra: x.update(extra)
            ch['failureIds'].append(x)
    else: ch['passed'] += 1
def eq(a, b): return a is not None and not isinstance(a, bool) and not isinstance(b, bool) and a == b
def num(x): return isinstance(x, (int, float)) and not isinstance(x, bool)
def close(a, b): return num(a) and num(b) and abs(a - b) <= 1e-6 * max(1, abs(b))
def band(dep):
    if not num(dep): return 'unavailable'
    return '<=40' if dep <= 40 else '40-100' if dep <= 100 else '100-250' if dep <= 250 else '>250'
def has_true_solver_or_calibration(v):
    if isinstance(v, dict):
        for k, x in v.items():
            if k == 'solverInput' and x is not False: return True
            if k == 'calibration' and x != 'uncalibrated': return True
            if k == 'calibratedConfidence' and x is not None: return True
            if has_true_solver_or_calibration(x): return True
    elif isinstance(v, list): return any(has_true_solver_or_calibration(x) for x in v)
    return False
def b3_failures(c, pos, gs):
    """Phase 10 B3, copied without change, recomputed from the binding's own census and the engine's posted blind seats."""
    f = []
    bs = c.get('blindSeats')
    if bs != gs.get('blindSeats', 'absent'): f.append('census_blind_seats_differ_from_engine_posted')
    if c.get('dealerSeat') != gs.get('dealerSeat'): f.append('census_dealer_differs_from_snapshot')
    try:
        dealer = c['dealerSeat']; dealt = sorted(c['dealtSeats']); n = len(dealt)
        if not isinstance(bs, dict) or set(bs) != {'smallBlind', 'bigBlind'}: raise ValueError('blind_seats_shape')
        sb, bb = bs['smallBlind'], bs['bigBlind']
        cw = [x for x in dealt if x > dealer] + [x for x in dealt if x <= dealer]
        last = cw[-1]
        if n == 2:
            ok = sb == dealer and bb in dealt and bb != dealer
        else:
            order = [x for x in cw if x != dealer]
            ok = ((sb is None and bb == order[0] and gs.get('gameMode') == 'tournament') or
                  (sb is not None and sb == order[0] and bb == order[1]))
        if not ok: f.append('posted_blinds_not_clockwise_from_button')
        if dealer not in dealt and not (gs.get('gameMode') == 'tournament' and n >= 3): f.append('empty_button_outside_tournament_3plus')
        expected = {last: 'button'}
        for seat, lab in ((bb, 'big_blind'), (sb, 'small_blind')):
            if seat is not None and seat not in expected: expected[seat] = lab
        between = cw[cw.index(bb) + 1:-1]
        for k, seat in enumerate(between):
            expected.setdefault(seat, 'cutoff' if k == len(between) - 1 else 'early' if k == 0 else 'middle')
        hero = c['heroSeat']
        if pos.get('heroOffset') != (cw.index(hero) + 1) % n: f.append('hero_offset_not_clockwise')
        labelled = [('hero', hero, pos.get('hero'))]
        if pos.get('aggressorSeat') is not None: labelled.append(('aggressor', pos['aggressorSeat'], pos.get('aggressor')))
        for who, seat, lab in labelled:
            if lab == 'small_blind' and seat != sb: f.append(who + '_labelled_small_blind_not_posting_seat')
            if lab == 'big_blind' and seat != bb: f.append(who + '_labelled_big_blind_not_posting_seat')
            if expected.get(seat) != lab: f.append(who + '_position_not_clockwise_from_button')
    except Exception as e:
        f.append('b3_not_recomputable:' + type(e).__name__)
    return f

bd = {k: Counter() for k in ['variant', 'gameMode', 'street', 'variantModeStreet', 'position', 'depthBand', 'rangeStatus',
                              'rangeStatusByVariantStreet', 'acceptedAction', 'acceptedEqualsBaseline', 'refusalReason',
                              'refusalReasonByVariant', 'eligibleReason', 'executionStatus', 'lane', 'deadButton',
                              'deadSmallBlind', 'blindSeatsPresence', 'censusBlindSeats', 'workBudgetByStreet',
                              'samplerBudgetExhaustedByVariantStreet', 'samplerCompletedByStreet', 'outcomeByVariantMode']}
sampler = defaultdict(lambda: {'n': 0, 'requested': 0, 'completed': 0, 'budgetExhausted': 0, 'fullyCompleted': 0,
                               'seatDraws': 0, 'uniformEscapes': 0, 'completedMin': None, 'completedMax': None})
eligible_n = refused_n = 0
for r, seg in pop:
    body = json.loads(r['body'])
    s = body['snapshot']; gs = s['gameState']; hero = s.get('player') or {}
    dec = body['decision']; p = dec.get('omahaVariantPolicy')
    var = gs.get('gameVariant'); mode_ = str(gs.get('gameMode')); street_ = str(gs.get('stage'))
    players = gs.get('players') or []
    by_seat = {pl.get('seat'): pl for pl in players if isinstance(pl, dict)}
    bd['variant'][var] += 1; bd['gameMode'][mode_] += 1; bd['street'][street_] += 1
    bd['variantModeStreet'][f'{var}/{mode_}/{street_}'] += 1
    bd['lane'][s.get('type')] += 1
    dealt_snap = gs.get('dealtSeatIds') if isinstance(gs.get('dealtSeatIds'), list) else [pl.get('seat') for pl in players]
    dealer = gs.get('dealerSeat')
    gbs = gs.get('blindSeats', 'absent')
    bd['blindSeatsPresence']['absent' if gbs == 'absent' else 'null' if gbs is None else 'object' if isinstance(gbs, dict) else 'other'] += 1
    outcome = ('no_receipt' if not isinstance(p, dict) else
               'eligible' if (p.get('eligible') is True and isinstance(p.get('inputs'), dict)) else 'refused:' + str(p.get('reason')))
    bd['outcomeByVariantMode'][f'{var}/{mode_}/{outcome}'] += 1
    if dealer not in dealt_snap: bd['deadButton'][f'{mode_}/{street_}/{outcome}'] += 1
    if isinstance(gbs, dict) and 'smallBlind' in gbs and gbs['smallBlind'] is None: bd['deadSmallBlind'][f'{mode_}/{street_}/{outcome}'] += 1
    # D1 presence
    f = []
    if not isinstance(p, dict): f.append('omahaVariantPolicy_missing')
    else:
        inp = p.get('inputs', 'absent')
        if inp == 'absent': f.append('inputs_field_absent')
        elif p.get('eligible') not in (True, False): f.append('eligible_not_boolean')
        elif p.get('eligible') is True and not isinstance(inp, dict): f.append('eligible_without_inputs')
        elif p.get('eligible') is False and inp is not None: f.append('refused_with_inputs')
        if isinstance(inp, dict) and p.get('eligible') is True:
            if inp.get('version') != BINDING_VERSION: f.append('binding_version')
            if inp.get('variant') != var or p.get('variant') != var: f.append('binding_variant')
        if p.get('eligible') is False and not (isinstance(p.get('reason'), str) and REASON.match(p['reason'])): f.append('refusal_unnamed')
    result('D1', r, seg, f, {'variant': var, 'gameMode': mode_, 'street': street_, 'lane': s.get('type')} if f else None)
    if not isinstance(p, dict):
        continue
    inp = p.get('inputs') if isinstance(p.get('inputs'), dict) else None
    elig = p.get('eligible') is True and inp is not None
    if p.get('reason') == 'work_budget': bd['workBudgetByStreet'][f"{var}/{street_}/{'eligible' if elig else 'refused'}"] += 1
    # execution witness join
    ex = executions.get((r['producerId'], r['turnKey'])) or []
    w = None
    if len(ex) == 1: w = ex[0]
    elif len(ex) > 1: notes['D6_executionDuplicate'] += 1
    else: notes['D6_executionMissing'] += 1
    acc = w.get('accepted') if w is not None else None
    bd['executionStatus'][str(w.get('executionStatus')) if w is not None else 'no_execution_record'] += 1
    bd['acceptedAction'][acc['action'] if acc else ('none' if w is not None else 'no_execution_record')] += 1
    if acc: bd['acceptedEqualsBaseline'][str(acc.get('action') == p.get('baselineAction'))] += 1
    if elig:
        eligible_n += 1
        bd['eligibleReason'][str(p.get('reason'))] += 1
        bd['position'][str((inp.get('positions') or {}).get('hero'))] += 1
        bd['depthBand'][band((inp.get('depth') or {}).get('effectiveBB'))] += 1
        rs = str((inp.get('range') or {}).get('status'))
        bd['rangeStatus'][rs] += 1
        bd['rangeStatusByVariantStreet'][f'{var}/{street_}/{rs}'] += 1
    else:
        refused_n += 1
        bd['refusalReason'][str(p.get('reason'))] += 1
        bd['refusalReasonByVariant'][f"{var}/{mode_}/{p.get('reason')}"] += 1
    # D2 labels
    f = []
    pv = PACK_VERSION.get(var)
    if p.get('version') != pv: f.append('receipt_version')
    po = dec.get('policyOwnership')
    if isinstance(po, dict) and 'packVersion' in po and po.get('packVersion') != pv: f.append('ownership_pack_version')
    if inp is not None:
        pk = inp.get('pack') or {}
        if pk.get('version') != pv: f.append('binding_pack_version')
        if pk.get('calibratedConfidence', 'x') is not None: f.append('pack_calibrated_confidence')
        if pk.get('holes') != PACK_HOLES.get(var) or pk.get('splitPot') is not PACK_SPLIT.get(var): f.append('pack_holes_or_split')
        ap = inp.get('approximation') or {}
        hs = ap.get('handShape') or {}
        if hs.get('kind') != 'heuristic_entry_score' or hs.get('probability') is not False: f.append('shape_not_labelled_non_probability')
        if ap.get('solverInput') is not False: f.append('approximation_solver_input')
        prov = (inp.get('range') or {}).get('provenance')
        if prov is not None and (prov.get('calibration') != 'uncalibrated' or prov.get('solverInput') is not False
                                 or prov.get('reads') != 'public_action_line_only'): f.append('provenance_label')
        if has_true_solver_or_calibration(inp): f.append('calibrated_or_solver_label_anywhere')
    result('D2', r, seg, f)
    # D8 authority
    f = []
    if p.get('mode') != 'shadow': f.append('mode_not_shadow:' + str(p.get('mode')))
    if p.get('applied') is not False: f.append('applied')
    result('D8', r, seg, f)
    if not elig:
        # D5 for refusals: deeper play falls back by name
        dep = None
        try:
            act = [pl for pl in players if pl.get('seat') in dealt_snap and pl.get('seat') != hero.get('seat') and not pl.get('is_folded')
                   and (not pl.get('is_sitting_out') or pl.get('is_all_in'))]
            dep = min(hero['stack'] + hero['bet'], max(pl['stack'] + pl['bet'] for pl in act)) / gs['bigBlind']
        except Exception: pass
        if num(dep) and dep > MAX_DEPTH_BB:
            notes['D5_refusedDeepRecomputable'] += 1
            notes['D5_depthAboveMaxByReason'][str(p.get('reason'))] += 1
            ok = p.get('reason') == 'depth_or_ante_outside_pack' or p.get('reason') in REFUSED_BEFORE_DEPTH
            result('D5', r, seg, [] if ok else ['deep_play_refused_under_other_name'],
                   None if ok else {'reason': p.get('reason'), 'recomputedDepthBB': dep, 'street': street_, 'variant': var})
        # D6 for refused: witness phase11Inputs must be null
        if w is not None:
            wi = w.get('phase11Inputs')
            result('D6', r, seg, [] if wi is None else ['witness_binding_field_absent' if wi == 'absent' else 'refused_but_witness_binding'])
        continue
    c = inp.get('census') or {}
    dealt, cont, fold, away = (set(c.get(k) or []) for k in ['dealtSeats', 'contestingOpponentSeats', 'foldedSeats', 'awaySeats'])
    allin = set(c.get('allInSeats') or [])
    # D3 census
    f = []
    cap = SEAT_CAP.get((var, mode_))
    if not cont <= dealt: f.append('contesting_not_subset_dealt')
    if cont & fold: f.append('contesting_includes_folded')
    if cont & away:
        f.append('contesting_includes_away')
        if (cont & away) <= allin: notes['D3_awayAllInContesting'] += 1
    if c.get('heroSeat') not in dealt: f.append('hero_not_dealt')
    if c.get('heroSeat') in fold: f.append('hero_folded')
    if cap is None or not 2 <= len(dealt) <= cap: f.append('dealt_count_outside_pack_ceiling')
    pk = inp.get('pack') or {}
    if pk.get('seats') != [2, cap]: f.append('pack_seats_not_mode_ceiling')
    if pk.get('seatCapOwner') != ('tournament_deck_capacity' if mode_ == 'tournament' else 'cash_table_seating'): f.append('seat_cap_owner')
    snap_cont = {pl['seat'] for pl in players if pl.get('seat') in dealt and pl.get('user_id') != hero.get('user_id')
                 and not pl.get('is_folded') and (not pl.get('is_sitting_out') or pl.get('is_all_in'))}
    if snap_cont != cont or c.get('heroSeat') != hero.get('seat'): notes['D3_censusVsSnapshotMismatch'] += 1
    result('D3', r, seg, f, {'census': c, 'pack': pk, 'gameMode': mode_, 'variant': var} if f else None)
    # D7 positions versus posted blinds
    if 'blindSeats' in c:
        bd['censusBlindSeats']['dead_small_blind' if isinstance(c['blindSeats'], dict) and c['blindSeats'].get('smallBlind', 0) is None
                               else 'live_small_blind' if isinstance(c['blindSeats'], dict) else 'other'] += 1
        fb = b3_failures(c, inp.get('positions') or {}, gs)
        result('D7', r, seg, fb, {'census': c, 'positions': inp.get('positions'), 'gameStateBlindSeats': gs.get('blindSeats', 'absent'),
                                  'gameMode': mode_, 'variant': var} if fb else None)
    else:
        notes['D7_eligibleWithoutCensusBlindSeats'] += 1
        result('D7', r, seg, ['census_blind_seats_absent'])
    # D4 range population and sampler work
    rg = inp.get('range') or {}
    prov = rg.get('provenance')
    if prov is not None:
        f = []
        try:
            got = {(o.get('userId'), o.get('seat')) for o in (prov.get('opponents') or [])}
            want = {(by_seat.get(x, {}).get('user_id'), x) for x in cont}
            if got != want or any(u is None for u, _ in want) or len(got) != len(prov.get('opponents') or []): f.append('range_population_differs')
            wk, pr, dk = prov['work'], prov['prior'], prov['deck']
            if pr['seatDraws'] != wk['completedSamples'] * dk['dealtOpponents']: f.append('seat_draws_not_completed_times_dealt_opponents')
            if dk['dealtOpponents'] != len(dealt) - 1: f.append('dealt_opponents_not_dealt_minus_one')
            if wk['completedSamples'] != rg.get('samples'): notes['D4_completedDiffersFromRangeSamples'] += 1
            sm = sampler[f'{var}/{street_}']
            sm['n'] += 1; sm['requested'] += wk['requestedSamples']; sm['completed'] += wk['completedSamples']
            sm['budgetExhausted'] += int(wk['budgetExhausted'] is True); sm['fullyCompleted'] += int(wk['completedSamples'] == wk['requestedSamples'])
            sm['seatDraws'] += pr['seatDraws']; sm['uniformEscapes'] += pr['uniformEscapes']
            sm['completedMin'] = wk['completedSamples'] if sm['completedMin'] is None else min(sm['completedMin'], wk['completedSamples'])
            sm['completedMax'] = wk['completedSamples'] if sm['completedMax'] is None else max(sm['completedMax'], wk['completedSamples'])
            bd['samplerBudgetExhaustedByVariantStreet'][f"{var}/{street_}/{wk['budgetExhausted']}"] += 1
            bd['samplerCompletedByStreet'][f"{street_}/{wk['completedSamples']}of{wk['requestedSamples']}"] += 1
        except Exception as e:
            f.append('provenance_not_recomputable:' + type(e).__name__)
        result('D4', r, seg, f, {'provenance': prov, 'contesting': sorted(cont), 'variant': var} if f else None)
    # D5 geometry
    g = inp.get('geometry') or {}; dp = inp.get('depth') or {}
    f = []
    try:
        pot, cb, bb = gs['pot'], gs['currentBet'], gs['bigBlind']
        hb, hs_ = hero['bet'], hero['stack']
        call = min(hs_, max(0, cb - hb))
        plr = cb + pot + call
        stk = hb + hs_
        if any(not eq(g.get(k), v) for k, v in [('pot', pot), ('currentBet', cb), ('bigBlind', bb), ('heroBet', hb), ('heroStack', hs_)]): f.append('recorded_scalars_differ_from_snapshot')
        if not close(g.get('callCost'), call): f.append('call_cost')
        if not close(g.get('potLimitRaiseTo'), plr): f.append('pot_limit_raise_to')
        if not close(g.get('stackRaiseTo'), stk): f.append('stack_raise_to')
        mx = gs.get('maxRaiseTo')
        capw = None if mx is None else min(mx, stk, plr)
        if (capw is None) != (g.get('wagerCap') is None) or (capw is not None and not close(g['wagerCap'], capw)): f.append('wager_cap')
        act = [by_seat[x] for x in cont if x in by_seat]
        if len(act) != len(cont) or not act: raise KeyError('contesting seat absent from snapshot')
        deep = max(pl['stack'] + pl['bet'] for pl in act)
        dep = min(stk, deep) / bb
        if not close(dp.get('effectiveBB'), dep): f.append('effective_depth')
        if dep > MAX_DEPTH_BB: f.append('eligible_above_250bb')
        if p.get('proposalAction') in ('bet', 'raise') and num(p.get('proposalAmount')) and g.get('wagerCap') is not None and p['proposalAmount'] > g['wagerCap'] + 1e-9:
            notes['D5_proposalAboveWagerCap'] += 1
    except Exception as e:
        f.append('geometry_not_recomputable:' + type(e).__name__)
    result('D5', r, seg, f, {'geometry': g, 'depth': dp, 'variant': var} if f else None)
    # D6 witness
    f = []
    try:
        h = sha(canon(parse_raw(r['body'])['decision']['omahaVariantPolicy']['inputs']))
    except Exception: h = None; f.append('input_hash_not_recomputable')
    if w is None: f.append('witness_unavailable_execution_missing' if not ex else 'witness_unavailable_execution_duplicate')
    else:
        wi = w.get('phase11Inputs')
        if not isinstance(wi, dict): f.append('witness_binding_absent' if wi in ('absent', None) else 'witness_binding_malformed')
        else:
            if wi.get('version') != WITNESS_VERSION: f.append('witness_version')
            if wi.get('variant') != inp.get('variant'): f.append('witness_variant_mismatch')
            if h is not None and wi.get('inputSha256') != h: f.append('witness_input_hash_mismatch')
            if wi.get('rangeStatus') != rg.get('status'): f.append('witness_range_status_mismatch')
    result('D6', r, seg, f)

for c in checks.values():
    c['failures'] = dict(c['failures'])
    c['verdict'] = 'pass' if c['failed'] == 0 and c['evaluated'] > 0 else ('fail' if c['failed'] else 'not_evaluated')
def split3(counter):
    by_mode, by_street, by_outcome = Counter(), Counter(), Counter()
    for k, n in counter.items():
        a, b, o = k.split('/', 2); by_mode[a] += n; by_street[b] += n; by_outcome[o] += n
    return {'total': sum(counter.values()), 'byGameMode': dict(by_mode), 'byStreet': dict(by_street), 'byOutcome': dict(by_outcome),
            'byModeStreetOutcome': dict(sorted(counter.items()))}
notes['D5_depthAboveMaxByReason'] = dict(notes['D5_depthAboveMaxByReason'])
out = {
    'version': 'p11-1-journal-observe-v1',
    'declarationSha256': 'b153ead56266359208c827b123a8e815a49e7b413bc48ac1882b6089cfe958ad',
    'baseScanner': {'path': 'docs/evidence/phase10/p10-blindseats-journal-observe.py',
                    'sha256': 'c96082324d881dcfffdd861df6350e7303dbb6b9eed83787492f51a52db2e195'},
    'window': {'start': ws_iso, 'end': we_iso, 'basis': 'snapshot.decisionTimeMs, half-open'},
    'servingRelease': release,
    'scannedAt': iso(time.time()),
    'segmentCoverage': coverage,
    'segmentSelection': 'every *.ndjson.gz with mtime >= window start - %ds, up to the scan time (later segments hold executions and late flushes)' % SEG_LOWER_MARGIN_S,
    'segmentsRetiredDuringScan': dict(seg_rejected),
    'decisionTimeRangeRead': [iso(min_dt / 1000) if min_dt else None, iso(max_dt / 1000) if max_dt else None],
    'decisionRecordsRead': decisions_read,
    'executionRecordsRead': sum(len(v) for v in executions.values()),
    'recordsInWindowByKind': dict(kinds_in_window),
    'population': len(pop),
    'populationRecordsInSegmentsClosedAfterWindowPlus30m': late_seg,
    'eligible': eligible_n,
    'refused': refused_n,
    'exclusions': dict(excl),
    'exclusionDetail': {k: dict(v) for k, v in excl_detail.items()},
    'unreadableByName': dict(unreadable),
    'unreadableIds': unreadable_ids[:DEFECT_SAMPLE],
    'checks': checks,
    'reported': {
        'deadButtonDecisions': split3(bd['deadButton']),
        'deadSmallBlindDecisions': split3(bd['deadSmallBlind']),
        'samplerWorkByVariantStreet': {k: dict(v) for k, v in sorted(sampler.items())},
        'workBudgetByVariantStreet': dict(bd['workBudgetByStreet']),
    },
    'supplementary': notes,
    'breakdowns': {k: dict(sorted(v.items())) for k, v in bd.items()},
    'fieldMap': FIELD_MAP,
    'extensions': EXTENSIONS,
    'wallSeconds': round(time.time() - t0, 1),
}
with open(out_path + '.tmp', 'w') as fh: json.dump(out, fh, indent=1, sort_keys=False, default=str)
os.rename(out_path + '.tmp', out_path)
