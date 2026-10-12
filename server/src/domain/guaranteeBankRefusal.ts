/**
 * A GUARANTEE REFUSAL HAS TWO SIGNATURES, AND BOTH MUST REACH THE OWNERS
 * (Dan 2026-08-29: "IF THE BANK DOESN'T HOLD ENOUGH CHIPS A POP UP MUST APPEAR").
 *
 * Two BEFORE triggers on public.tournaments refuse a guaranteed event the
 * funding bank cannot cover, both with errcode 55000:
 *   - trg_tournaments_guarantee_affordable:
 *       "Club X cannot guarantee N chips: ... short by M."
 *   - trg_tournaments_publish_readiness (fn_tournament_management_readiness_for_row,
 *     which also counts guaranteed satellite seats as promises):
 *       "Tournament cannot be published because its guarantee is short by M chips"
 *
 * Every refusal site used to match only the first, so on 2026-10-02 Midway
 * Union's High Roller PKO was refused 30 times by the second and no owner was
 * told. Every site now asks this one question.
 */
export function isGuaranteeBankRefusal(message: string | null | undefined): boolean {
  return /cannot guarantee|guarantee is short by/i.test(String(message ?? ''));
}
