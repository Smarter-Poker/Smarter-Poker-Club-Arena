"""P13.3 completion reader, stage 1 (engine host, read-only).

Prints one JSON line per journaled betting decision of ONE joint variant, made
on ONE engine release, decided in [from, to):
{"eventId", "decisionTimeMs", "gameMode", "variant", "boardCount", "bombPot",
 "dealtPlayers", "governorScale", "receipt"} where receipt is
body.decision.jointPolicy as journaled (null when absent). Stage 2
(server/src/scripts/phase13CompletionRecord.ts) counts them with the
authority's own horsePhase13CompletionCounts and writes the
horse-phase13-completion-v1 record, so no counting rule lives here.

The joint owner decides single-board, multi-board and bomb hands alike, so
all three are printed (boardCount and bombPot say which). Pineapple discards
are journaled as their own kind (discard_decision); they are never betting
decisions and are counted apart here, by name, windowed by the request's own
journalContext.requestedAtMs, never printed. Only DECIDE_FAST decision records
count: a DEEP second look is a second record for the same turn and is counted
apart by name.

Reads closed archive segment files only (never the live journal), verifying
each segment's sha256 name. Run under nice 19 / ionice idle.

argv: <from-iso> <to-iso> <release-sha40> <variant: one of the nine joint variants>
stderr: a JSON summary (segments read, records, excluded by name).
env (tests only): PHASE13_EXTRACT_SEGMENT_DIRS, colon-separated segment
directories replacing the two host archive directories.
"""
import os, sys, gzip, json, hashlib, calendar, time
from collections import Counter

VARIANTS = ('nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'flh', 'pineapple', 'short_deck')
DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
if os.environ.get('PHASE13_EXTRACT_SEGMENT_DIRS'):
    DIRS = os.environ['PHASE13_EXTRACT_SEGMENT_DIRS'].split(':')
frm, to, release, variant = sys.argv[1:5]
assert variant in VARIANTS and len(release) == 40
def ms(iso):
    return calendar.timegm(time.strptime(iso.replace('Z', '').split('.')[0], '%Y-%m-%dT%H:%M:%S')) * 1000
FROM, TO = ms(frm), ms(to)
summary = Counter()
for d in DIRS:
    for e in os.scandir(d):
        if not e.name.endswith('.ndjson.gz'): continue
        try:
            if e.stat().st_mtime * 1000 < FROM - 120000: continue
            raw = gzip.decompress(open(e.path, 'rb').read())
        except FileNotFoundError:
            summary['segment_retired_during_scan'] += 1; continue
        if hashlib.sha256(raw).hexdigest() != e.name[:-len('.ndjson.gz')]:
            summary['segment_digest_mismatch'] += 1; continue
        summary['segments_read'] += 1
        for line in raw.decode('utf-8').splitlines():
            r = json.loads(line)
            kind = r.get('kind')
            if kind not in ('decision', 'discard_decision'): continue
            body = json.loads(r['body'])
            s = body.get('snapshot') or {}
            if kind == 'discard_decision':
                # A discard snapshot is a DECIDE_DISCARD request: its variant is
                # top level and its time is the request's own (or the record's).
                ctx = s.get('journalContext') or {}
                at = ctx.get('requestedAtMs', r.get('atMs'))
                if isinstance(at, int) and FROM <= at < TO and s.get('gameVariant') == variant:
                    summary['excluded_discard_decision'] += 1
                continue
            gs = s.get('gameState') or {}
            dt = s.get('decisionTimeMs')
            if not isinstance(dt, int) or not (FROM <= dt < TO): continue
            if gs.get('gameVariant') != variant: continue
            # One natural decision per turn: a DEEP second look is journaled as
            # a second 'decision' record for the same turn.
            if s.get('type') != 'DECIDE_FAST':
                summary['excluded_deep_second_look'] += 1; continue
            if r.get('sourceRelease') != release:
                summary['excluded_release_other'] += 1; continue
            receipt = (body.get('decision') or {}).get('jointPolicy')
            board_count = gs.get('boardCount') or 1
            bomb = gs.get('bombPot') is True
            if board_count > 1: summary['multiboard_records'] += 1
            if bomb: summary['bomb_records'] += 1
            if receipt is None: summary['records_without_joint_receipt'] += 1
            dealt = gs.get('dealtSeatIds')
            dealt_players = len(dealt) if isinstance(dealt, list) else (
                receipt.get('dealtPlayers') if isinstance(receipt, dict) else None)
            summary['records'] += 1
            print(json.dumps({'eventId': r['eventId'], 'decisionTimeMs': dt, 'gameMode': gs.get('gameMode'),
                              'variant': variant, 'boardCount': board_count, 'bombPot': bomb,
                              'dealtPlayers': dealt_players, 'governorScale': body.get('governorScale'),
                              'receipt': receipt},
                             separators=(',', ':')))
print(json.dumps(dict(summary), sort_keys=True), file=sys.stderr)
