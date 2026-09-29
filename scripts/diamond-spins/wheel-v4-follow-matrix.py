#!/usr/bin/env python3
"""The Diamond Wheel v4 model and its follow-up matrix, derived and proved here.

Owner ruling 2026-09-21 (R2, R12, R13, R15): a bonus game 50% of the time, an
instant chip win 30%, a throwable / time bank / rabbit hunt 20%, the payback
held at 80%, and never the same prize or game twice in a row.

Nothing downstream retypes these numbers. Run

    python3 scripts/diamond-spins/wheel-v4-follow-matrix.py --sql
    python3 scripts/diamond-spins/wheel-v4-follow-matrix.py --ts

to print the SQL VALUES list the migration installs and the TypeScript constants
the browser verifier reads, and

    python3 scripts/diamond-spins/wheel-v4-follow-matrix.py --check <file>...

to prove a committed artifact still carries exactly what this file derives.

THE DERIVATION. Let w be the base law (weights out of N=100000). We want a
symmetric integer matrix F with F[i][i] = 0 and row sums equal to W, because a
symmetric F with row sums W makes W stationary: for every j,

    sum_i (W[i]/N) * (F[i][j]/W[i]) = sum_i F[i][j]/N = sum_i F[j][i]/N = W[j]/N

so the unconditional law of EVERY spin is still W. The mix stays exactly
50/30/20 and the payback exactly 0.8, standard and VIP, while no prize can
follow itself. The continuous seed is the classic "no repeat" kernel
F[i][j] = N w_i w_j h_i h_j with h_i = (T - sqrt(T^2 - 4 w_i)) / (2 w_i) and T
solved so the row sums come out right; the integers are then repaired to exact
row sums, keeping the four bonus games interchangeable so that the cross-tier
rule below stays value neutral.
"""

from __future__ import annotations

import json
import math
import re
import sys
from fractions import Fraction as Fr

N = 100000

LABELS = [
    'Diamond Plinko', '1x Chips', 'Throwables', 'Diamond Crash', 'Diamonds', 'Time Bank',
    'Donkey Cross', '2x Chips', 'Rabbit Hunt', 'Diamond Mines', '3x Chips', 'Upgrade',
]
KINDS = [
    'bonus', 'chips', 'throwables', 'bonus', 'diamonds', 'time_bank',
    'bonus', 'chips', 'rabbit_hunt', 'bonus', 'chips', 'upgrade',
]
GAMES = ['plinko', None, None, 'crash', None, None, 'crossing', None, None, 'mines', None, None]
W = [11950, 29600, 6667, 11950, 1200, 6666, 11950, 240, 6667, 11950, 160, 1000]

# The multiplier column each receipt carries. Chips pay it; an item is worth it;
# Diamonds risks one entry on the three-card game; Upgrade's award doubles.
MULT = [Fr(1), Fr(1), Fr(1, 4), Fr(1), Fr(1), Fr(1, 4), Fr(1), Fr(2), Fr(1, 4), Fr(1), Fr(3), Fr(2)]
# The VIP table: ords 3, 6 and 9 are instant chip wins of exactly equal value.
VIP_LABELS = {2: '0.2x Chips', 5: '0.25x Chips', 8: '0.3x Chips'}
VIP_MULT = {2: Fr(1, 5), 5: Fr(1, 4), 8: Fr(3, 10)}

# The Upgrade wheel, unchanged since 2026-09-17.
UPGRADE_LABELS = [
    'Super Plinko', 'Super Crash', 'Super Donkey Cross', 'Super Diamond Mines',
    '5x Chips', '10x Chips', '25x Chips', '100x Chips',
]
UPGRADE_KINDS = ['bonus'] * 4 + ['chips'] * 4
UPGRADE_GAMES = ['plinko', 'crash', 'crossing', 'mines', None, None, None, None]
UPGRADE_W = [20000, 20000, 20000, 20000, 9600, 7400, 2000, 1000]
UPGRADE_MULT = [Fr(2)] * 4 + [Fr(5), Fr(10), Fr(25), Fr(100)]

BONUS_ORDS = [i for i, k in enumerate(KINDS) if k == 'bonus']


def value(kind: str, multiplier: Fr) -> Fr:
    """What one unit of entry is worth on this segment, as an exact rational.

    A bonus game returns 0.8 of its stake; the Upgrade wheel is worth 4 entries;
    the three-card Diamonds game returns 11/6 of what it risks; everything else
    pays its multiplier.
    """
    if kind == 'bonus':
        return multiplier * Fr(4, 5)
    if kind == 'upgrade':
        return Fr(4)
    if kind == 'diamonds':
        return multiplier * Fr(11, 6)
    return multiplier


def values(vip: bool) -> list[Fr]:
    return [
        value('chips' if vip and i in VIP_MULT else KINDS[i], VIP_MULT[i] if vip and i in VIP_MULT else MULT[i])
        for i in range(12)
    ]


def follow_matrix() -> list[list[int]]:
    """The symmetric, zero-diagonal, row-sum-preserving follow-up matrix."""
    n = 12
    others = [i for i in range(n) if i not in BONUS_ORDS]
    w = [x / N for x in W]

    def hs(t: float) -> list[float]:
        return [(t - math.sqrt(t * t - 4 * w[i])) / (2 * w[i]) for i in range(n)]

    lo, hi = 2 * math.sqrt(max(w)) + 1e-12, 10.0
    for _ in range(200):
        t = (lo + hi) / 2
        if sum(w[i] * h for i, h in enumerate(hs(t))) - t > 0:
            lo = t
        else:
            hi = t
    h = hs(hi if hi else lo)
    real = [[0.0 if i == j else N * w[i] * w[j] * h[i] * h[j] for j in range(n)] for i in range(n)]

    g0 = BONUS_ORDS[0]
    y = {j: max(1, round(real[g0][j])) for j in others}
    # The three bonus-to-bonus cells of a game's row share one value, so it has
    # to divide what the row has left after the non-game cells are placed.
    while (W[g0] - sum(y.values())) % 3:
        y[1] += 1
    x = (W[g0] - sum(y.values())) // 3
    f = [[0] * n for _ in range(n)]
    for a in BONUS_ORDS:
        for b in BONUS_ORDS:
            if a != b:
                f[a][b] = x
        for j in others:
            f[a][j] = f[j][a] = y[j]
    for ii, i in enumerate(others):
        for j in others[ii + 1:]:
            f[i][j] = f[j][i] = max(1, round(real[i][j]))

    def residual() -> dict[int, int]:
        return {i: W[i] - sum(f[i]) for i in others}

    r = residual()
    guard = 0
    while any(r.values()) and guard < 100000:
        guard += 1
        pos = [i for i in others if r[i] > 0]
        neg = [i for i in others if r[i] < 0]
        if len(pos) >= 2:
            i, j = sorted(pos, key=lambda k: -r[k])[:2]
            f[i][j] += 1
            f[j][i] += 1
        elif [(i, j) for i in neg for j in neg if i < j and f[i][j] > 1]:
            cand = [(i, j) for i in neg for j in neg if i < j and f[i][j] > 1]
            i, j = max(cand, key=lambda p: f[p[0]][p[1]])
            f[i][j] -= 1
            f[j][i] -= 1
        elif neg:
            i = min(neg, key=lambda k: r[k])
            k = max((k for k in others if k != i and f[i][k] > 1), key=lambda k: (r[k] < 0, f[i][k]))
            f[i][k] -= 1
            f[k][i] -= 1
        elif len(pos) == 1 and r[pos[0]] >= 2:
            i = pos[0]
            k, m = max(
                ((k, m) for k in others for m in others if k < m and i not in (k, m) and f[k][m] > 1),
                key=lambda p: f[p[0]][p[1]],
            )
            f[i][k] += 1
            f[k][i] += 1
            f[i][m] += 1
            f[m][i] += 1
            f[k][m] -= 1
            f[m][k] -= 1
        else:
            raise SystemExit('the repair pass is stuck: %r' % r)
        r = residual()
    if any(r.values()):
        raise SystemExit('the repair pass did not converge')
    return f


def cross_tier_main(row: list[int], super_game: str | None) -> list[int]:
    """Row 12 after an Upgrade that landed Super g: ordinary g is excluded and
    its weight is shared by the other three ordinary games. Value neutral,
    because every ordinary game is worth the same 0.8 of the entry."""
    if super_game is None:
        return list(row)
    out = list(row)
    hit = GAMES.index(super_game)
    share, rest = divmod(out[hit], 3)
    others = [i for i in BONUS_ORDS if i != hit]
    out[hit] = 0
    for n_, i in enumerate(others):
        out[i] += share + (1 if n_ < rest else 0)
    return out


def upgrade_weights(prev_game: str | None) -> list[int]:
    """The Upgrade wheel after an ordinary game g: Super g is excluded and its
    20000 is shared by the other three Super games, +6667 / +6667 / +6666 in
    ord order. Value neutral for the same reason."""
    out = list(UPGRADE_W)
    if prev_game is None:
        return out
    hit = UPGRADE_GAMES.index(prev_game)
    share, rest = divmod(out[hit], 3)
    others = [i for i in range(4) if i != hit]
    out[hit] = 0
    for n_, i in enumerate(others):
        out[i] += share + (1 if n_ < rest else 0)
    return out


def prove(f: list[list[int]]) -> dict[str, object]:
    n = 12
    assert sum(W) == N, 'the base law must sum to 100000'
    assert all(f[i][i] == 0 for i in range(n)), 'a prize may never follow itself'
    assert all(f[i][j] == f[j][i] for i in range(n) for j in range(n)), 'the matrix must be symmetric'
    assert all(f[i][j] >= 1 for i in range(n) for j in range(n) if i != j), 'every other prize stays reachable'
    assert all(sum(f[i]) == W[i] for i in range(n)), 'every row must sum to its own base weight'
    for j in range(n):
        assert sum(Fr(W[i], N) * Fr(f[i][j], W[i]) for i in range(n)) == Fr(W[j], N), 'W must be stationary'

    buckets = (('bonus', 'upgrade', 'diamonds'), ('chips',), ('throwables', 'time_bank', 'rabbit_hunt'))
    mix = tuple(sum(Fr(W[j], N) for j in range(n) if KINDS[j] in s) for s in buckets)
    assert mix == (Fr(1, 2), Fr(3, 10), Fr(1, 5)), 'the long-run mix must be exactly 50/30/20'

    worst = Fr(0)
    rows: list[dict[str, object]] = []
    for vip in (False, True):
        v = values(vip)
        assert sum(Fr(W[i], N) * v[i] for i in range(n)) == Fr(4, 5), 'the payback must be exactly 0.8'
        for i in range(n):
            cond = sum(Fr(f[i][j], W[i]) * v[j] for j in range(n))
            assert cond < 1, 'no conditional expectation may reach the entry'
            worst = max(worst, cond)
    # The cross-tier rows keep both the row total and the payback.
    for g in ('plinko', 'crash', 'crossing', 'mines'):
        row = cross_tier_main(f[11], g)
        assert sum(row) == W[11], 'the cross-tier main row must keep its total'
        assert row[GAMES.index(g)] == 0, 'the repeated game must be gone'
        v = values(False)
        assert sum(Fr(row[j], W[11]) * v[j] for j in range(n)) == sum(
            Fr(f[11][j], W[11]) * v[j] for j in range(n)
        ), 'moving weight between equal-value games may not move the payback'
        up = upgrade_weights(g)
        assert sum(up) == N and up[UPGRADE_GAMES.index(g)] == 0, 'the Upgrade wheel must keep its total'
        assert sum(Fr(up[j], N) * value(UPGRADE_KINDS[j], UPGRADE_MULT[j]) for j in range(8)) == Fr(4), (
            'the Upgrade wheel must still be worth four entries'
        )
    assert sum(Fr(UPGRADE_W[j], N) * value(UPGRADE_KINDS[j], UPGRADE_MULT[j]) for j in range(8)) == Fr(4)
    for i in range(n):
        rows.append({'ord': i + 1, 'label': LABELS[i], 'weights': f[i]})
    return {'mix': [str(x) for x in mix], 'max_conditional': float(worst), 'rows': rows}


def sixths(kind: str, multiplier: Fr) -> Fr:
    """The value in sixths of an entry, which is always an exact decimal, so the
    payback identity can be asserted in SQL without a rational type."""
    return value(kind, multiplier) * 6


def decimal(x: Fr) -> str:
    """An exact decimal literal for a rational whose denominator divides 10^6."""
    scaled = x * 1000000
    assert scaled.denominator == 1, 'value %s is not an exact decimal' % x
    text = ('%d' % scaled.numerator).rjust(7, '0')
    whole, frac = text[:-6], text[-6:].rstrip('0')
    return whole + ('.' + frac if frac else '')


def emit_sql() -> str:
    f = follow_matrix()
    out: list[str] = []
    out.append('-- GENERATED by scripts/diamond-spins/wheel-v4-follow-matrix.py. Do not hand edit.')
    out.append('-- The base law: 50% a game, 30% instant chips, 20% an item, payback exactly 0.8.')
    out.append('MODEL:')
    for i in range(12):
        label = VIP_LABELS[i] if i in VIP_LABELS else LABELS[i]
        kind = 'chips' if i in VIP_MULT else KINDS[i]
        mult = VIP_MULT[i] if i in VIP_MULT else MULT[i]
        out.append(
            " (%d,'%s','%s',%s,%s,%s,'%s','%s',%s,%s,%d)"
            % (
                i + 1, LABELS[i], KINDS[i], "'%s'" % GAMES[i] if GAMES[i] else 'NULL',
                decimal(MULT[i]), decimal(sixths(KINDS[i], MULT[i])),
                label, kind, decimal(mult), decimal(sixths(kind, mult)), W[i],
            )
        )
    out.append('FOLLOW:')
    for i in range(12):
        out.append(' (%d,%s)' % (i + 1, ','.join(str(x) for x in f[i])))
    return '\n'.join(out)


def emit_ts() -> str:
    f = follow_matrix()
    lines: list[str] = []
    lines.append('/**')
    lines.append(' * THE DIAMOND WHEEL v4 LAW, GENERATED, NEVER HAND EDITED.')
    lines.append(' *')
    lines.append(' * Produced by `python3 scripts/diamond-spins/wheel-v4-follow-matrix.py --ts`,')
    lines.append(' * which also derives and proves it (owner ruling 2026-09-21, R2/R12/R13/R15).')
    lines.append(' * The migration installs the same numbers, from the same script, so the')
    lines.append(' * browser can recompute a spin without trusting the receipt it is checking.')
    lines.append(' *')
    lines.append(' * WHEEL_V4_WEIGHTS is the base law W out of 100000. WHEEL_V4_FOLLOW[i] is the')
    lines.append(' * law used by the spin AFTER ord i+1: symmetric, zero on the diagonal, and')
    lines.append(' * summing to W[i], which is what keeps every spin\'s unconditional law exactly')
    lines.append(' * W and so the mix exactly 50/30/20 and the payback exactly 0.8.')
    lines.append(' */')
    lines.append('')
    lines.append('export const WHEEL_V4_TOTAL = 100000;')
    lines.append('')
    lines.append('export const WHEEL_V4_WEIGHTS: readonly number[] = [')
    lines.append('  %s,' % ', '.join(str(x) for x in W))
    lines.append('];')
    lines.append('')
    lines.append('export const WHEEL_V4_FOLLOW: readonly (readonly number[])[] = [')
    for i in range(12):
        lines.append('  [%s], // after %s' % (', '.join(str(x) for x in f[i]), LABELS[i]))
    lines.append('];')
    lines.append('')
    lines.append('/** The bonus-game ords on the main wheel, in ord order: the cross-tier rule moves weight only between these. */')
    lines.append('export const WHEEL_V4_GAME_ORDS: readonly number[] = [%s];' % ', '.join(str(i + 1) for i in BONUS_ORDS))
    lines.append('')
    lines.append('/** ord -> the bonus game it awards, for the four game segments. */')
    lines.append('export const WHEEL_V4_GAME_BY_ORD: Readonly<Record<number, string>> = {')
    for i in BONUS_ORDS:
        lines.append("  %d: '%s'," % (i + 1, GAMES[i]))
    lines.append('};')
    lines.append('')
    lines.append('export const WHEEL_V4_UPGRADE_WEIGHTS: readonly number[] = [')
    lines.append('  %s,' % ', '.join(str(x) for x in UPGRADE_W))
    lines.append('];')
    lines.append('')
    lines.append('/** The Upgrade wheel ord that awards each Super game. */')
    lines.append('export const WHEEL_V4_UPGRADE_ORD_BY_GAME: Readonly<Record<string, number>> = {')
    for i, g in enumerate(UPGRADE_GAMES):
        if g:
            lines.append("  %s: %d," % (g, i + 1))
    lines.append('};')
    return '\n'.join(lines) + '\n'


def numbers(text: str) -> list[list[int]]:
    """Every bracketed or parenthesised run of integers, in order. Reading the
    numbers rather than the bytes means a formatter can never look like drift."""
    out: list[list[int]] = []
    for group in re.findall(r'[\[(]([\s\d,.\n]+)[\])]', text):
        row = [int(x) for x in re.findall(r'(?<![.\d])(\d+)(?![.\d])', group)]
        if row:
            out.append(row)
    return out


def check(paths: list[str]) -> int:
    """Prove a committed artifact still carries exactly what this file derives.

    A .sql file is checked against the emitted VALUES rows, which is how the
    migration installs them. A .ts file is checked by its NUMBERS, so that a
    formatter rewrapping a line can never look like the law drifting.
    """
    sql = emit_sql()
    rows = [line.strip() for line in sql.split('MODEL:')[1].strip().split('\n') if line.strip() and not line.startswith('FOLLOW')]
    f = follow_matrix()
    wanted = [list(W)] + [list(row) for row in f] + [list(UPGRADE_W)]
    bad = 0
    for path in paths:
        with open(path, encoding='utf-8') as handle:
            text = handle.read()
        if path.endswith('.sql'):
            missing = [row for row in rows if row not in text]
        else:
            found = numbers(text)
            missing = [row for row in wanted if row not in found]
        if missing:
            bad += 1
            print('%s does not carry what the generator derives (%d rows missing, first: %s)'
                  % (path, len(missing), missing[0]), file=sys.stderr)
        else:
            print('%s matches the generated law' % path)
    return bad


def main(argv: list[str]) -> int:
    f = follow_matrix()
    if '--sql' in argv:
        print(emit_sql())
        return 0
    if '--ts' in argv:
        print(emit_ts(), end='')
        return 0
    if '--check' in argv:
        return check(argv[argv.index('--check') + 1:])
    report = prove(f)
    if '--json' in argv:
        print(json.dumps(report, indent=1))
        return 0
    print('base law            %s' % W)
    print('long-run mix        games %s chips %s items %s' % tuple(report['mix']))
    print('payback             4/5 exactly, standard and VIP')
    print('max conditional EV  %.6f of the entry' % report['max_conditional'])
    for row in report['rows']:
        print('after %-15s %s' % (row['label'], row['weights']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
