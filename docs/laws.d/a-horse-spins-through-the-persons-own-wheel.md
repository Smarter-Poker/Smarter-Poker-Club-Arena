# tests/a-horse-spins-through-the-persons-own-wheel.law.test.ts

Every Diamond Spins door names its player with auth.uid(), and a horse has no
session, so a broke horse could not spin its Diamonds into chips (Dan,
2026-10-18). fn_horse_diamond_spins is the horse's input device: engine only
(fn_caller_is_engine plus service_role-only EXECUTE), horse only
(profiles.is_horse), and every action runs the exact public function the
person's page calls from a closed allow-list, writing nothing itself, so a
horse cannot get a different wheel, prize table or rule. The horse is named as
caller with transaction-local claims and the engine's identity is restored
before the door returns.
