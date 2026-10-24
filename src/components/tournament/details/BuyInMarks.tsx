/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUY-IN MARKS — how many times a player rebought, and whether they added on
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-24, verbatim: "INSIDE THE RANKING IT SHOULD TELL YOU HOW MANY
 * TIMES THE REBOUGHT AND IF THEY ADDED ON AS WELL. THAT SHOULD BE IN THE RANKING
 * AND INSIDE THE ENTRIES"
 *
 * Entries used to carry this as two abbreviations, "RB 1" and "AO", which a
 * player had to decode, and Ranking did not carry it at all even though every
 * row it renders already held `rebuys` and `add_ons`. One component now draws
 * both marks in words on both tabs, so the two cannot drift apart again.
 *
 * Where the numbers come from:
 *
 *   rebuys   tournament_players.rebuys   (integer, bumped by
 *            fn_ca_process_tournament_chip_purchase_money_v1 per rebuy)
 *   add-on   tournament_players.add_on   (BOOLEAN - an add-on is taken once,
 *            so the contract's `add_ons` count collapses to 0 or 1)
 *
 * A player with neither renders nothing. A column of "0 Rebuys" tells a player
 * nothing and costs a row its name.
 */

/** "1 Rebuy", "3 Rebuys". Never "1 Rebuys", never an abbreviation. */
function rebuyText(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return `${n.toLocaleString()} ${n === 1 ? 'Rebuy' : 'Rebuys'}`;
}

interface BuyInMarksProps {
  rebuys: number | null | undefined;
  addOn: boolean | null | undefined;
}

export default function BuyInMarks({ rebuys, addOn }: BuyInMarksProps) {
  const n = Math.max(0, Math.floor(Number(rebuys) || 0));
  const tookAddOn = addOn === true;
  if (n === 0 && !tookAddOn) return null;

  return (
    <>
      {n > 0 && (
        <span
          className="tl-badge"
          title={`Rebought ${n.toLocaleString()} ${n === 1 ? 'Time' : 'Times'}`}
        >
          {rebuyText(n)}
        </span>
      )}
      {tookAddOn && (
        <span className="tl-badge tl-badge--good" title="Took The Add-On">
          Add-On
        </span>
      )}
    </>
  );
}
