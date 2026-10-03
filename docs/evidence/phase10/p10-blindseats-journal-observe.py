"""Horse Brain Phase 10 natural evidence for blind seats and the dead button, read-only, on the engine host.

Implements docs/evidence/phase10/declaration-p10-blindseats.txt (declared 2026-10-03T18:33:26Z,
sha256 b26f17ad773124138a24cea5cc01c07b5b7473159dc41c5d6902712edc0f13bc). It is the committed
docs/evidence/phase10/p10-1-journal-observe.py (sha256 9a5c6d7f29366483d3efbd76b1ae982ae516793fed5c237b6a04a88f5107cda1)
extended to the v2 input binding (census.blindSeats, #5999 at 795e6e45bc); every extension is
listed in EXTENSIONS below and copied into the output. B1 is the P10.1 checks C1-C6 of
declaration-p10-1.txt unchanged in meaning; B2-B5 are new. The mapping from each declared check
to the real journal fields is in FIELD_MAP below and is copied into the output artifact.

Reads segment files only (never opens the journal or its catalog, for writing or
otherwise); run under nice 19 / ionice idle, detached. Every check is recomputed here,
independently of the engine code: the record schema, the record digest, the canonical
JSON, the census, the pot-limit geometry, the depth and the witness input hash
(sorted-key canonical JSON of decision.plo4Policy.inputs, SHA-256, with each number
kept as the exact literal the journal wrote).

argv: <window-start-iso> <window-end-iso> <serving-release-sha> <out.json> [<expected-binding-version>]
The fifth argument exists only for a dry run on a release that writes the v1 binding; the
evidence run omits it and requires plo4-input-binding-v2.
"""
import os, sys, gzip, json, time, hashlib, re, calendar
from collections import Counter, defaultdict

DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
PACK_VERSION = 'plo4-policy-round1-v3'
MAX_DEPTH_BB = 250
SEG_LOWER_MARGIN_S = 120   # a segment closed before the window cannot hold a record decided in it
DEFECT_SAMPLE = 25

FIELD_MAP = {
    'population': 'journal records with kind == "decision"; decision time = body.snapshot.decisionTimeMs '
                  '(the decision instant, not the journal atMs); variant = body.snapshot.gameState.gameVariant '
                  '== "plo4" and single board = gameState.boardCount in (absent, 1) with no communityCards2/3; '
                  'cash/tournament = gameState.gameMode; release = record.sourceRelease',
    'variant_policy_step': 'body.decision.policyGraph.transitions[].node == "variant_policy"',
    'C1': 'body.decision.plo4Policy present; eligible == (inputs != null); refused (eligible false) => '
          'inputs null and reason a non-empty name matching ^[a-z][a-z0-9_]{0,127}$; "applied to the v2 binding": '
          'an eligible binding has inputs.version == plo4-input-binding-v2 (failure binding_version_not_v2). A '
          'decision whose receipt the client dropped (#5998 F8, phase10_shadow_receipt_binding_dropped, which deletes '
          'plo4Policy and the phase10 policyOwnership) has a variant_policy step and no plo4Policy, so it fails C1 as '
          'plo4Policy_missing and is listed by identifier, never dropped',
    'C2': 'plo4Policy.version and inputs.pack.version == plo4-policy-round1-v3 (and policyOwnership.packVersion); '
          'shape score label = inputs.approximation.handShape {kind: heuristic_entry_score, probability: false}; '
          'inputs.approximation.solverInput false and pack.calibratedConfidence null; range provenance = '
          'inputs.range.provenance {calibration: uncalibrated, solverInput: false} when present. Any other '
          'calibration label or a true solverInput anywhere in the binding is a defect',
    'C3': 'inputs.census: contestingOpponentSeats subset of dealtSeats, disjoint from foldedSeats and awaySeats; '
          'heroSeat in dealtSeats and not in foldedSeats; len(dealtSeats) in 2..8',
    'C4': 'set(inputs.range.provenance.opponents[].userId) == user ids of census.contestingOpponentSeats, the '
          'seat -> user id map taken from body.snapshot.gameState.players (when provenance is non-null)',
    'C5': 'from the recorded snapshot (gameState.pot, currentBet, bigBlind, maxRaiseTo; player.stack, bet; the '
          'contesting players stack+bet): call = min(heroStack, max(0, currentBet - heroBet)) [the declared '
          '"call price" is the chip call cost, inputs.geometry.callCost, not the postflop callPrice ratio]; '
          'pot-limit raise-to = (heroBet + call) + (pot + call), i.e. the street total after calling plus the '
          'pot after calling; gated: min(raise-to, heroBet + heroStack) == min(geometry.potLimitRaiseTo, '
          'geometry.stackRaiseTo) on every eligible record, the uncapped geometry.potLimitRaiseTo == raise-to '
          'wherever the hero can complete the call, and min(raise-to, heroBet + heroStack, engine maxRaiseTo) == '
          'geometry.wagerCap. Where the hero cannot complete the call no raise exists; an uncapped difference '
          'there is counted and listed under supplementary, not gated; effective depth = min(hero stack+bet, deepest contesting opponent stack+bet) / BB '
          '== inputs.depth.effectiveBB and <= 250 on every eligible proposal; every decision with recomputed '
          'depth > 250 is not eligible and, when it reached the depth check, is named depth_or_ante_outside_pack',
    'C6': 'plo4Policy.readFrameSha256 is 64 hex on every eligible decision and equals body.readFrame.sha256 (the '
          'frame the decision record retains); the witness is the execution record joined on (producerId, '
          'turnKey): phase10Inputs {version horse-phase10-input-binding-v1, inputSha256 == recomputed sha256 of '
          'canonical inputs, readFrameSha256 == plo4Policy.readFrameSha256, rangeStatus == inputs.range.status}; '
          'phase10Inputs null for a refused proposal',
    'C7': 'plo4Policy.mode == shadow and applied == false; the variant_policy transition is unchanged '
          '(after == before == {baselineAction, baselineAmount}); the accepted action = the controller-accepted '
          'record in the joined execution witness (acceptedActions[0].record.action). Compared literally with '
          'the baseline; any difference is attributed to the later policy node that changed it '
          '(policyGraph transitions after variant_policy) or to controller coercion/fallback, never silently',
    'B1': 'C1-C6 above, each counted and gated separately; B1 passes only if all six pass. The P10.1 C7 '
          '(authority) is not part of B1; the declaration restates it as B4',
    'B2': 'dead button = body.snapshot.gameState.dealerSeat not in the dealt seats (gameState.dealtSeatIds, or the '
          'snapshot player seats when dealtSeatIds is absent, as in C5); population for the gate = gameMode == '
          'tournament and 3 or more dealt seats. Gated: plo4Policy.reason != canonical_state_unavailable; the decision '
          'is eligible with a binding (eligible true, inputs an object) or refused with another name (counted by '
          'name). A dead-button decision with no plo4Policy at all (F8 drop) fails B2 as no_receipt',
    'B3': 'every eligible decision whose inputs.census carries blindSeats. The posted blinds are the engine\'s '
          'snapshot.gameState.blindSeats (HandController.getBlindSeatsSnapshot); gated: census.blindSeats equals '
          'them exactly and census.dealerSeat == gameState.dealerSeat. The binding labels two seats, the hero '
          '(positions.hero at census.heroSeat) and the aggressor (positions.aggressor at positions.aggressorSeat, when '
          'non-null); for each labelled seat: label small_blind => seat == blindSeats.smallBlind, label big_blind => '
          'seat == blindSeats.bigBlind. "Consistent with the clockwise order from the button", recomputed here from '
          'census.dealerSeat and census.dealtSeats alone: cw = dealt seats clockwise starting after the dealer seat '
          '(the dealer seat itself last when dealt); heroOffset == (index of hero in cw + 1) mod n; the posted blinds '
          'are the first seats of cw excluding an occupied button (smallBlind then bigBlind, or bigBlind alone when '
          'smallBlind is null, which needs a tournament table of 3 or more), heads-up smallBlind is the button and '
          'bigBlind the other seat; the expected label of a seat is button for the last seat of cw (the seat that acts '
          'last), big_blind / small_blind for the posted seats, and for the seats strictly between the big blind and '
          'that last seat: cutoff for the last of them, early for the first, middle otherwise; hero and aggressor '
          'labels must equal the expected labels; an empty dealer seat is accepted only at a tournament table of 3 or '
          'more (empty_button_outside_tournament_3plus)',
    'B4': 'every population record that carries plo4Policy: plo4Policy.mode == shadow, applied == false, the '
          'variant_policy transition unchanged (P10.1 C7 clauses), and the accepted action is never the proposal where '
          'no later node or controller explains it (C7 failure accepted_proposal_not_baseline). Selection outcome '
          'records: plo4Policy.selection and the execution witness phase10Authority.selection must be none or '
          'shadow_change (never selected, controller_accepted or withdrawn_before_acceptance, which follow a '
          'selection); plo4Policy.authority.state and phase10Authority.authority.state must be unselected or refused, '
          'and a non-null authorityVerdict / phase10Authority.verdict must be unselected or refused. Any other value '
          'fails the literal reading and is listed',
    'B5': 'plo4Policy.reason == blind_seats_unavailable counted on the population; every journal decision record '
          'is a live engine decision (snapshot.type DECIDE_FAST or DECIDE_DEEP), so each one fails B5 and is '
          'listed as a wiring defect with gameState.blindSeats (absent / null) and gameState.bombPot',
    'reported': 'dead-button decisions (dealer seat not dealt, any mode and seat count) and dead-small-blind '
                'decisions (gameState.blindSeats.smallBlind null) by gameMode, street and outcome (eligible or the '
                'refusal name); refusal names and counts; dead-button canonical_state_unavailable count beside the 465 '
                'of the 46bb9cf6 window, context only',
    'exclusions': 'each decision record takes the first matching name, in this order: unreadable_record, '
                  'outside_window, release_other, not_plo4 (other variant, or multi-board plo4 under '
                  'plo4_multiboard), no_variant_policy_step. unreadable_record counts every line or segment in the '
                  'scanned set that failed to decode or failed the journal schema, whatever its kind or time, '
                  'because an unreadable record has no trustworthy kind or time',
}

ws_iso, we_iso, release, out_path = sys.argv[1:5]
BINDING_VERSION = sys.argv[5] if len(sys.argv) > 5 else 'plo4-input-binding-v2'
EXTENSIONS = [
    'docstring, version label p10-blindseats-journal-observe-v1 and declarationSha256 point at declaration-p10-blindseats.txt',
    'optional fifth argument: the expected binding version (default plo4-input-binding-v2; a dry run on a v1 release passes plo4-input-binding-v1)',
    'C1: an eligible binding must carry inputs.version == the expected binding version (binding_version_not_v2)',
    'REFUSED_BEFORE_DEPTH (used by C5 for refusals taken before the depth check) follows the Plo4LivePolicy order at 795e6e45: adds blind_seats_unavailable (taken after seat_count_outside_pack and before private_state_rejected); dead_button_blinds_unproven (#5992) no longer exists',
    'execution witness join also keeps phase10Authority (selection, authority, verdict) for B4',
    'B2, B3, B4 and B5 checks; the P10.1 C7 is evaluated inside B4 (its failures keep their C7 names)',
    'reported breakdowns: dead-button and dead-small-blind decisions by mode, street and outcome; gameState.blindSeats presence; dead-button canonical_state_unavailable beside 465',
    'B1 verdict aggregated from C1-C6',
]
def iso_epoch(s):
    return calendar.timegm(time.strptime(s.replace('Z', ''), '%Y-%m-%dT%H:%M:%S'))
WS, WE = iso_epoch(ws_iso), iso_epoch(we_iso)
WS_MS, WE_MS = WS * 1000, WE * 1000
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
excl_detail = {'release_other': Counter(), 'not_plo4': Counter()}
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
                if (wb.get('identity') or {}).get('variant') != 'plo4': continue
                aa = wb.get('acceptedActions') or []
                executions[(r['producerId'], r['turnKey'])].append({
                    'segment': seg, 'eventId': r['eventId'],
                    'phase10Inputs': wb.get('phase10Inputs', 'absent'),
                    'phase10Authority': wb.get('phase10Authority', 'absent'),
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
        if gs_.get('gameVariant') != 'plo4':
            excl['not_plo4'] += 1; excl_detail['not_plo4']['variant:' + str(gs_.get('gameVariant'))] += 1; continue
        if gs_.get('boardCount', 1) not in (1, None) or gs_.get('communityCards2') or gs_.get('communityCards3'):
            excl['not_plo4'] += 1; excl_detail['not_plo4']['plo4_multiboard'] += 1; continue
        tr = ((body.get('decision') or {}).get('policyGraph') or {}).get('transitions') or []
        if not any(isinstance(t, dict) and t.get('node') == 'variant_policy' for t in tr):
            excl['no_variant_policy_step'] += 1; continue
        if m > WE + 1800: late_seg += 1
        pop.append((r, seg))   # the body is re-parsed at check time; parsed dicts are not held
        del body
    if coverage[d]['scannedSegments'] % 10000 == 0:
        print(iso(time.time()), 'segments', sum(v['scannedSegments'] for v in coverage.values()), 'of', len(cand),
              'population', len(pop), file=sys.stderr, flush=True)

# ---- exclusions ---------------------------------------------------------------
for name in ['release_other', 'not_plo4', 'outside_window', 'unreadable_record', 'no_variant_policy_step']:
    excl.setdefault(name, 0)
excl['unreadable_record'] = sum(unreadable.values())

# ---- checks ---------------------------------------------------------------------------------
REASON = re.compile(r'^[a-z][a-z0-9_]{0,127}$')
# Refusals the policy takes before it reaches the depth check (Plo4LivePolicy order at 795e6e45).
REFUSED_BEFORE_DEPTH = {'off', 'invalid_mode', 'variant_outside_pack', 'multiboard_owned_by_phase13', 'canonical_state_unavailable',
                        'seat_count_outside_pack', 'blind_seats_unavailable', 'private_state_rejected', 'invalid_geometry',
                        'invalid_wager_geometry'}
checks = {c: {'evaluated': 0, 'passed': 0, 'failed': 0, 'failures': Counter(), 'failureIds': []}
          for c in ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'B2', 'B3', 'B4', 'B5']}
B_DEFECT_IDS = 500   # B2-B5 list up to this many failing records by identifier (C1-C6 keep DEFECT_SAMPLE)
notes = {'C3_awayAllInContesting': 0, 'C3_censusVsSnapshotMismatch': 0, 'C5_proposalAboveWagerCap': 0,
         'C5_depthAboveMaxByReason': Counter(), 'C6_executionMissing': 0, 'C6_executionDuplicate': 0,
         'C7_acceptedDiffersFromBaselineBy': Counter(), 'C7_acceptedEqualsProposalNotBaseline': 0,
         'C5_uncappedRaiseToDiffersWhereCallIsShort': 0, 'C5_uncappedRaiseToDiffersWhereCallIsShortIds': [],
         'B3_eligibleWithoutCensusBlindSeats': 0}
def ident(r, seg):
    return {'eventId': r['eventId'], 'producerId': r['producerId'], 'sequence': r['sequence'], 'handKey': r['handKey'],
            'turnKey': r['turnKey'], 'segment': seg}
def result(c, r, seg, fails, extra=None):
    ch = checks[c]; ch['evaluated'] += 1
    if fails:
        ch['failed'] += 1
        for f in fails: ch['failures'][f] += 1
        if len(ch['failureIds']) < (B_DEFECT_IDS if c.startswith('B') else DEFECT_SAMPLE):
            x = ident(r, seg); x['failures'] = fails
            if extra: x.update(extra)
            ch['failureIds'].append(x)
    else: ch['passed'] += 1
def eq(a, b): return a is not None and not isinstance(a, bool) and not isinstance(b, bool) and a == b
def num(x): return isinstance(x, (int, float)) and not isinstance(x, bool)
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
bd = {k: Counter() for k in ['gameMode', 'street', 'position', 'depthBand', 'rangeStatus', 'acceptedAction',
                              'refusalReason', 'eligibleReason', 'executionStatus', 'lane',
                              'deadButton', 'deadSmallBlind', 'blindSeatsPresence', 'B2Outcome', 'B5Detail',
                              'selection', 'authorityState', 'authorityVerdict', 'witnessSelection', 'witnessAuthorityState',
                              'witnessVerdict', 'censusBlindSeats']}
def b3_failures(c, pos, gs):
    """B3, recomputed from the binding's own census and the engine's posted blind seats."""
    f = []
    bs = c.get('blindSeats')
    if bs != gs.get('blindSeats', 'absent'): f.append('census_blind_seats_differ_from_engine_posted')
    if c.get('dealerSeat') != gs.get('dealerSeat'): f.append('census_dealer_differs_from_snapshot')
    try:
        dealer = c['dealerSeat']; dealt = sorted(c['dealtSeats']); n = len(dealt)
        if not isinstance(bs, dict) or set(bs) != {'smallBlind', 'bigBlind'}: raise ValueError('blind_seats_shape')
        sb, bb = bs['smallBlind'], bs['bigBlind']
        cw = [x for x in dealt if x > dealer] + [x for x in dealt if x <= dealer]   # clockwise from the seat after the button
        last = cw[-1]                                                               # acts last: the button's slot
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
cross = Counter()
eligible_n = refused_n = 0
for r, seg in pop:
    body = json.loads(r['body'])
    s = body['snapshot']; gs = s['gameState']; hero = s.get('player') or {}
    dec = body['decision']; p = dec.get('plo4Policy')
    players = gs.get('players') or []
    by_seat = {pl.get('seat'): pl for pl in players if isinstance(pl, dict)}
    bd['gameMode'][str(gs.get('gameMode'))] += 1
    bd['street'][str(gs.get('stage'))] += 1
    bd['lane'][s.get('type')] += 1
    # B2 / B5 / reported: the dead button and the posted blinds, from the engine's own snapshot
    dealt_snap = gs.get('dealtSeatIds') if isinstance(gs.get('dealtSeatIds'), list) else [pl.get('seat') for pl in players]
    dealer = gs.get('dealerSeat')
    gbs = gs.get('blindSeats', 'absent')
    bd['blindSeatsPresence']['absent' if gbs == 'absent' else 'null' if gbs is None else 'object' if isinstance(gbs, dict) else 'other'] += 1
    mode_, street_ = str(gs.get('gameMode')), str(gs.get('stage'))
    outcome = ('no_receipt' if not isinstance(p, dict) else
               'eligible' if (p.get('eligible') is True and isinstance(p.get('inputs'), dict)) else 'refused:' + str(p.get('reason')))
    if dealer not in dealt_snap:
        bd['deadButton'][f'{mode_}/{street_}/{outcome}'] += 1
        if gs.get('gameMode') == 'tournament' and len(dealt_snap) >= 3:
            fb = []
            if outcome == 'no_receipt': fb.append('no_receipt')
            elif outcome == 'refused:canonical_state_unavailable': fb.append('canonical_state_unavailable')
            elif outcome != 'eligible' and not (isinstance(p.get('reason'), str) and REASON.match(p['reason'])): fb.append('refused_unnamed')
            bd['B2Outcome'][outcome] += 1
            result('B2', r, seg, fb, {'dealerSeat': dealer, 'dealtSeats': dealt_snap, 'blindSeats': gbs, 'outcome': outcome} if fb else None)
    if isinstance(gbs, dict) and 'smallBlind' in gbs and gbs['smallBlind'] is None:
        bd['deadSmallBlind'][f'{mode_}/{street_}/{outcome}'] += 1
    if isinstance(p, dict):
        if p.get('reason') == 'blind_seats_unavailable':
            bd['B5Detail'][f"blindSeats:{'absent' if gbs == 'absent' else json.dumps(gbs)}/bombPot:{gs.get('bombPot')}/{mode_}/{s.get('type')}"] += 1
            result('B5', r, seg, ['blind_seats_unavailable_on_live_decision'],
                   {'gameStateBlindSeats': gbs, 'bombPot': gs.get('bombPot'), 'lane': s.get('type'), 'gameMode': mode_, 'street': street_,
                    'dealerSeat': dealer, 'dealtSeats': dealt_snap})
        else:
            result('B5', r, seg, [])
    # C1 presence
    f = []
    if not isinstance(p, dict): f.append('plo4Policy_missing')
    else:
        inp = p.get('inputs', 'absent')
        if inp == 'absent': f.append('inputs_field_absent')
        elif p.get('eligible') is True and not isinstance(inp, dict): f.append('eligible_without_inputs')
        elif p.get('eligible') is False and inp is not None: f.append('refused_with_inputs')
        elif p.get('eligible') not in (True, False): f.append('eligible_not_boolean')
        if isinstance(inp, dict) and p.get('eligible') is True and inp.get('version') != BINDING_VERSION: f.append('binding_version_not_v2')
        if p.get('eligible') is False and not (isinstance(p.get('reason'), str) and REASON.match(p['reason'])): f.append('refusal_unnamed')
    result('C1', r, seg, f)
    if not isinstance(p, dict):
        continue
    inp = p.get('inputs') if isinstance(p.get('inputs'), dict) else None
    elig = p.get('eligible') is True and inp is not None
    # execution witness join
    ex = executions.get((r['producerId'], r['turnKey'])) or []
    w = None
    if len(ex) == 1: w = ex[0]
    elif len(ex) > 1: notes['C6_executionDuplicate'] += 1
    else: notes['C6_executionMissing'] += 1
    acc = None
    if w is not None:
        bd['executionStatus'][str(w.get('executionStatus'))] += 1
        acc = w.get('accepted')
    else: bd['executionStatus']['no_execution_record'] += 1
    bd['acceptedAction'][acc['action'] if acc else ('none' if w is not None else 'no_execution_record')] += 1
    if elig:
        eligible_n += 1
        bd['eligibleReason'][str(p.get('reason'))] += 1
        bd['position'][str((inp.get('positions') or {}).get('hero'))] += 1
        bd['depthBand'][band((inp.get('depth') or {}).get('effectiveBB'))] += 1
        bd['rangeStatus'][str((inp.get('range') or {}).get('status'))] += 1
        cross[(str(gs.get('gameMode')), str(gs.get('stage')))] += 1
    else:
        refused_n += 1
        bd['refusalReason'][str(p.get('reason'))] += 1
        bd['position']['refused:' + str(p.get('position'))] += 1
        bd['depthBand']['refused:' + band(p.get('depthBB'))] += 1
        bd['rangeStatus']['refused_no_binding'] += 1
    # C2 labels
    f = []
    if p.get('version') != PACK_VERSION: f.append('receipt_version')
    po = dec.get('policyOwnership') or {}
    if po.get('packVersion') != PACK_VERSION: f.append('ownership_pack_version')
    if inp is not None:
        if (inp.get('pack') or {}).get('version') != PACK_VERSION: f.append('binding_pack_version')
        if (inp.get('pack') or {}).get('calibratedConfidence', 'x') is not None: f.append('pack_calibrated_confidence')
        ap = inp.get('approximation') or {}
        hs = ap.get('handShape') or {}
        if hs.get('kind') != 'heuristic_entry_score' or hs.get('probability') is not False: f.append('shape_not_labelled_non_probability')
        if ap.get('solverInput') is not False: f.append('approximation_solver_input')
        prov = (inp.get('range') or {}).get('provenance')
        if prov is not None and (prov.get('calibration') != 'uncalibrated' or prov.get('solverInput') is not False): f.append('provenance_label')
        if has_true_solver_or_calibration(inp): f.append('calibrated_or_solver_label_anywhere')
    result('C2', r, seg, f)
    if not elig:
        # C5, deeper play falls back by name: recompute depth from the snapshot where it allows
        dep = None
        try:
            dealt_ids = gs.get('dealtSeatIds') if isinstance(gs.get('dealtSeatIds'), list) else [pl.get('seat') for pl in players]
            act = [pl for pl in players if pl.get('seat') in dealt_ids and pl.get('seat') != hero.get('seat') and not pl.get('is_folded') and (not pl.get('is_sitting_out') or pl.get('is_all_in'))]
            dep = min(hero['stack'] + hero['bet'], max(pl['stack'] + pl['bet'] for pl in act)) / gs['bigBlind']
        except Exception: pass
        if num(dep) and dep > MAX_DEPTH_BB:
            notes['C5_depthAboveMaxByReason'][str(p.get('reason'))] += 1
            ok = p.get('reason') == 'depth_or_ante_outside_pack' or p.get('reason') in REFUSED_BEFORE_DEPTH
            result('C5', r, seg, [] if ok else ['deep_play_refused_under_other_name'], None if ok else {'reason': p.get('reason'), 'recomputedDepthBB': dep})
        # C6 for refused: witness must be null
        f6 = []
        if w is not None and w.get('phase10Inputs') not in (None, 'absent'): f6.append('refused_but_witness_binding')
        if w is not None: result('C6', r, seg, f6)
    else:
        c = inp.get('census') or {}
        dealt, cont, fold, away = (set(c.get(k) or []) for k in ['dealtSeats', 'contestingOpponentSeats', 'foldedSeats', 'awaySeats'])
        allin = set(c.get('allInSeats') or [])
        f = []
        if not cont <= dealt: f.append('contesting_not_subset_dealt')
        if cont & fold: f.append('contesting_includes_folded')
        if cont & away:
            f.append('contesting_includes_away')
            if (cont & away) <= allin: notes['C3_awayAllInContesting'] += 1
        if c.get('heroSeat') not in dealt: f.append('hero_not_dealt')
        if c.get('heroSeat') in fold: f.append('hero_folded')
        if not 2 <= len(dealt) <= 8: f.append('dealt_count_outside_2_8')
        # supplementary independent census from the snapshot players
        snap_cont = {pl['seat'] for pl in players if pl.get('seat') in dealt and pl.get('user_id') != hero.get('user_id')
                     and not pl.get('is_folded') and (not pl.get('is_sitting_out') or pl.get('is_all_in'))}
        if snap_cont != cont or c.get('heroSeat') != hero.get('seat'): notes['C3_censusVsSnapshotMismatch'] += 1
        result('C3', r, seg, f, {'census': c} if f else None)
        # B3 positions versus the posted blinds
        if 'blindSeats' in c:
            bd['censusBlindSeats']['dead_small_blind' if isinstance(c['blindSeats'], dict) and c['blindSeats'].get('smallBlind', 0) is None
                                   else 'live_small_blind' if isinstance(c['blindSeats'], dict) else 'other'] += 1
            fb = b3_failures(c, inp.get('positions') or {}, gs)
            result('B3', r, seg, fb, {'census': c, 'positions': inp.get('positions'), 'gameStateBlindSeats': gs.get('blindSeats', 'absent'),
                                      'gameMode': gs.get('gameMode')} if fb else None)
        else:
            notes['B3_eligibleWithoutCensusBlindSeats'] += 1
        # C4
        prov = (inp.get('range') or {}).get('provenance')
        if prov is not None:
            ids = {o.get('userId') for o in (prov.get('opponents') or [])}
            want = {by_seat.get(x, {}).get('user_id') for x in cont}
            result('C4', r, seg, [] if ids == want and None not in want else ['range_population_differs'])
        # C5 geometry
        g = inp.get('geometry') or {}; dp = inp.get('depth') or {}
        f = []
        try:
            pot, cb, bb = gs['pot'], gs['currentBet'], gs['bigBlind']
            hb, hs_ = hero['bet'], hero['stack']
            call = min(hs_, max(0, cb - hb))
            plr = (hb + call) + (pot + call)
            if any(not eq(g.get(k), v) for k, v in [('pot', pot), ('currentBet', cb), ('bigBlind', bb), ('heroBet', hb), ('heroStack', hs_)]): f.append('recorded_scalars_differ_from_snapshot')
            if not eq(g.get('callCost'), call): f.append('call_cost')
            stk = hb + hs_
            close = lambda a, b: num(a) and abs(a - b) <= 1e-9 * max(1, abs(b))
            # The declared quantity is the pot-limit raise-to capped by the stack.
            if not num(g.get('potLimitRaiseTo')) or not num(g.get('stackRaiseTo')) or not close(min(g['potLimitRaiseTo'], g['stackRaiseTo']), min(plr, stk)):
                f.append('pot_limit_raise_to_capped')
            if not close(g.get('potLimitRaiseTo'), plr):
                if hb + call >= cb - 1e-9:
                    f.append('pot_limit_raise_to')   # the hero can complete the call, so the uncapped bound is live
                else:
                    # The hero cannot complete the call (call capped by the stack), so no raise exists and the
                    # capped value above is the whole bound; the uncapped field is reported, not gated.
                    notes['C5_uncappedRaiseToDiffersWhereCallIsShort'] += 1
                    if len(notes['C5_uncappedRaiseToDiffersWhereCallIsShortIds']) < DEFECT_SAMPLE:
                        x = ident(r, seg); x.update({'recordedPotLimitRaiseTo': g.get('potLimitRaiseTo'), 'declaredRaiseTo': plr,
                                                     'stackRaiseTo': stk, 'currentBet': cb, 'heroBet': hb, 'callCost': call, 'wagerCap': g.get('wagerCap')})
                        notes['C5_uncappedRaiseToDiffersWhereCallIsShortIds'].append(x)
            if not eq(g.get('stackRaiseTo'), stk): f.append('stack_raise_to')
            mx = gs.get('maxRaiseTo')
            cap = None if mx is None else min(mx, stk, plr)
            if (cap is None) != (g.get('wagerCap') is None) or (cap is not None and abs(g['wagerCap'] - cap) > 1e-9 * max(1, abs(cap))): f.append('wager_cap')
            act = [by_seat[x] for x in cont if x in by_seat]
            if len(act) != len(cont) or not act: raise KeyError('contesting seat absent from snapshot')
            deep = max(pl['stack'] + pl['bet'] for pl in act)
            dep = min(stk, deep) / bb
            if not num(dp.get('effectiveBB')) or abs(dp['effectiveBB'] - dep) > 1e-9 * max(1, dep): f.append('effective_depth')
            if dep > MAX_DEPTH_BB: f.append('eligible_above_250bb')
            if p.get('proposalAction') in ('bet', 'raise') and num(p.get('proposalAmount')) and g.get('wagerCap') is not None and p['proposalAmount'] > g['wagerCap'] + 1e-9:
                notes['C5_proposalAboveWagerCap'] += 1
        except Exception as e:
            f.append('geometry_not_recomputable:' + type(e).__name__)
        result('C5', r, seg, f, {'geometry': g, 'depth': dp} if f else None)
        # C6 read frame and witness
        f = []
        rf = p.get('readFrameSha256')
        if not (isinstance(rf, str) and SHA.match(rf)): f.append('read_frame_missing')
        elif rf != (body.get('readFrame') or {}).get('sha256'): f.append('read_frame_not_retained_frame')
        try:
            h = sha(canon(parse_raw(r['body'])['decision']['plo4Policy']['inputs']))
        except Exception: h = None; f.append('input_hash_not_recomputable')
        if w is None: f.append('witness_unavailable_execution_missing' if not ex else 'witness_unavailable_execution_duplicate')
        else:
            wi = w.get('phase10Inputs')
            if not isinstance(wi, dict): f.append('witness_binding_absent')
            else:
                if wi.get('version') != 'horse-phase10-input-binding-v1': f.append('witness_version')
                if h is not None and wi.get('inputSha256') != h: f.append('witness_input_hash_mismatch')
                if wi.get('readFrameSha256') != rf: f.append('witness_read_frame_mismatch')
                if wi.get('rangeStatus') != (inp.get('range') or {}).get('status'): f.append('witness_range_status_mismatch')
        result('C6', r, seg, f)
    # C7 authority (every record that carries plo4Policy)
    f = []
    if p.get('mode') != 'shadow': f.append('mode_not_shadow')
    if p.get('applied') is not False: f.append('applied')
    vp = [t for t in (dec.get('policyGraph') or {}).get('transitions', []) if t.get('node') == 'variant_policy']
    base = {'action': p.get('baselineAction'), 'amount': p.get('baselineAmount')}
    if len(vp) != 1 or vp[0].get('changed') is not False or vp[0].get('after') != base or vp[0].get('before') != base: f.append('variant_policy_changed_action')
    if acc is not None:
        if acc.get('action') != base['action']:
            later = [t['node'] for t in dec['policyGraph']['transitions'] if t.get('changed') and t.get('node') != 'variant_policy']
            why = ('later_node:' + ','.join(later)) if later else ('execution:' + str(w.get('executionStatus')))
            notes['C7_acceptedDiffersFromBaselineBy'][why] += 1
            if acc.get('action') == p.get('proposalAction') and not later and w.get('executionStatus') == 'intended':
                notes['C7_acceptedEqualsProposalNotBaseline'] += 1; f.append('accepted_proposal_not_baseline')
    # B4: the selection outcome is unselected / refused wherever a record carries one
    UNSEL = ('none', 'shadow_change'); NOAUTH = ('unselected', 'refused')
    sel = p.get('selection', 'absent')
    bd['selection'][str(sel)] += 1
    if sel != 'absent' and sel not in UNSEL: f.append('decision_selection_' + str(sel))
    au = p.get('authority', 'absent')
    if isinstance(au, dict):
        bd['authorityState'][str(au.get('state'))] += 1
        if au.get('state') not in NOAUTH: f.append('decision_authority_state_' + str(au.get('state')))
    else:
        bd['authorityState'][str(au)] += 1
        if au not in ('absent', None): f.append('decision_authority_malformed')
    av = p.get('authorityVerdict', 'absent')
    bd['authorityVerdict'][str(av)] += 1
    if av not in ('absent', None) and av not in NOAUTH: f.append('decision_authority_verdict_' + str(av))
    if w is not None:
        wa = w.get('phase10Authority')
        if isinstance(wa, dict):
            bd['witnessSelection'][str(wa.get('selection'))] += 1
            if wa.get('selection') not in UNSEL: f.append('witness_selection_' + str(wa.get('selection')))
            wau = wa.get('authority')
            bd['witnessAuthorityState'][str(wau.get('state')) if isinstance(wau, dict) else str(wau)] += 1
            if isinstance(wau, dict) and wau.get('state') not in NOAUTH: f.append('witness_authority_state_' + str(wau.get('state')))
            bd['witnessVerdict'][str(wa.get('verdict'))] += 1
            if wa.get('verdict') is not None and wa.get('verdict') not in NOAUTH: f.append('witness_verdict_' + str(wa.get('verdict')))
        else:
            bd['witnessSelection']['absent' if wa == 'absent' else str(wa)] += 1
    result('B4', r, seg, f)

for c in checks.values():
    c['failures'] = dict(c['failures'])
    c['verdict'] = 'pass' if c['failed'] == 0 and c['evaluated'] > 0 else ('fail' if c['failed'] else 'not_evaluated')
b1_parts = {k: checks[k]['verdict'] for k in ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']}
B1 = {'components': b1_parts,
      'verdict': 'fail' if 'fail' in b1_parts.values() else 'pass' if all(v == 'pass' for v in b1_parts.values()) else
                 'pass_except_not_evaluated:' + ','.join(k for k, v in b1_parts.items() if v == 'not_evaluated')}
def split3(counter):
    by_mode, by_street, by_outcome = Counter(), Counter(), Counter()
    for k, n in counter.items():
        a, b, o = k.split('/', 2); by_mode[a] += n; by_street[b] += n; by_outcome[o] += n
    return {'total': sum(counter.values()), 'byGameMode': dict(by_mode), 'byStreet': dict(by_street), 'byOutcome': dict(by_outcome),
            'byModeStreetOutcome': dict(sorted(counter.items()))}
reported = {
    'deadButtonDecisions': split3(bd['deadButton']),
    'deadSmallBlindDecisions': split3(bd['deadSmallBlind']),
    'refusalNames': dict(bd['refusalReason']),
    'deadButtonCanonicalStateUnavailable': sum(n for k, n in bd['deadButton'].items() if k.endswith('/refused:canonical_state_unavailable')),
    'deadButtonCanonicalStateUnavailableIn46bb9cf6Window': 465,
    'comparisonNote': 'different windows and releases, context only',
}
notes['C5_depthAboveMaxByReason'] = dict(notes['C5_depthAboveMaxByReason'])
notes['C7_acceptedDiffersFromBaselineBy'] = dict(notes['C7_acceptedDiffersFromBaselineBy'])
out = {
    'version': 'p10-blindseats-journal-observe-v1',
    'declarationSha256': 'b26f17ad773124138a24cea5cc01c07b5b7473159dc41c5d6902712edc0f13bc',
    'baseScanner': {'path': 'docs/evidence/phase10/p10-1-journal-observe.py',
                    'sha256': '9a5c6d7f29366483d3efbd76b1ae982ae516793fed5c237b6a04a88f5107cda1'},
    'bindingVersionRequired': BINDING_VERSION,
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
    'B1': B1,
    'checks': checks,
    'reported': reported,
    'supplementary': notes,
    'breakdowns': {k: dict(v) for k, v in bd.items()},
    'eligibleByModeAndStreet': {f'{a}/{b}': n for (a, b), n in sorted(cross.items())},
    'fieldMap': FIELD_MAP,
    'extensions': EXTENSIONS,
    'wallSeconds': round(time.time() - t0, 1),
}
with open(out_path + '.tmp', 'w') as fh: json.dump(out, fh, indent=1, sort_keys=False, default=str)
os.rename(out_path + '.tmp', out_path)
