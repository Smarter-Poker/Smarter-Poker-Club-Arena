/**
 * ═══ THE ENGINE'S OWN NUMBER, FOR THE PROBE TO COMPARE ═══════════════════
 *
 * Reads `{ rows, scenarios }` on stdin and writes the ENGINE's answers on
 * stdout. It imports the server's real pricer and the server's real
 * resolution of the published rows - not a copy of either - so what the probe
 * then feeds to `fn_poker_diamond_settle_cash_hand` is the number a live
 * Diamond cash hand would declare.
 *
 * The rows come out of the probe's disposable database, so both sides of the
 * comparison are reading ONE set of published answers. If the engine and the
 * settler disagree by a single Diamond, the settler refuses the hand and the
 * probe fails - which is the whole point of running them against each other
 * rather than against two sets of expectations.
 *
 * Reads no environment, opens no socket, and imports nothing with a database
 * client behind it.
 */
import {
  diamondCashRakeSettingNames,
  diamondCashRakeStakeScope,
  priceDiamondCashRake,
  resolveDiamondCashRakeSchedule,
  type EconomicsRow,
} from '../../server/src/domain/diamondCashRakeSchedule.js';

interface Scenario {
  label: string;
  bb: number;
  pot: number;
  dealt: number;
  saw_flop: boolean;
}

const input = JSON.parse(await new Response(process.stdin).text()) as {
  rows: EconomicsRow[];
  scenarios: Scenario[];
};

/** What the engine charges for each hand. */
const prices = input.scenarios.map((scenario) => ({
  label: scenario.label,
  rake: priceDiamondCashRake(resolveDiamondCashRakeSchedule(input.rows, scenario.bb), {
    pot: scenario.pot,
    dealtIn: scenario.dealt,
    sawFlop: scenario.saw_flop,
  }),
}));

/**
 * And every published answer as the ENGINE resolved it, so the probe can hold
 * that resolution against `fn_ca_diamond_economic`'s own. A pricer that
 * agrees on the arithmetic while reading a different row is still wrong.
 */
const stakes = [...new Set(input.scenarios.map((scenario) => scenario.bb))];
const readings: Array<{ name: string; scope: string; value: string }> = [];
for (const name of diamondCashRakeSettingNames()) {
  for (const scope of ['all', ...stakes.map((bb) => diamondCashRakeStakeScope(bb))]) {
    const rows = input.rows.filter((row) => row.name === name && row.scope === scope);
    if (rows.length === 0) continue;
    const schedules = stakes.map((bb) => ({
      bb,
      schedule: resolveDiamondCashRakeSchedule(input.rows, bb),
    }));
    const bracket = name.endsWith('_heads_up')
      ? '_heads_up'
      : name.endsWith('_three_handed')
        ? '_three_handed'
        : '';
    const base = name.replace(/_heads_up$|_three_handed$/, '');
    for (const { bb, schedule } of schedules) {
      if (!schedule.enabled) continue;
      if (base === 'cash_rake_percent' && scope === 'all')
        readings.push({ name, scope, value: decimal(schedule.percent[bracket]) });
      if (base === 'cash_rake_cap' && scope === diamondCashRakeStakeScope(bb))
        readings.push({ name, scope, value: decimal(schedule.cap[bracket]) });
      if (name === 'cash_rake_min_pot' && scope === 'all')
        readings.push({ name, scope, value: decimal(schedule.minPot) });
    }
  }
}

function decimal(value: { units: bigint; scale: number }): string {
  if (value.scale === 0) return value.units.toString();
  const digits = value.units.toString().padStart(value.scale + 1, '0');
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}

process.stdout.write(
  JSON.stringify({
    prices,
    readings: [...new Map(readings.map((r) => [`${r.name}/${r.scope}`, r])).values()],
  })
);
