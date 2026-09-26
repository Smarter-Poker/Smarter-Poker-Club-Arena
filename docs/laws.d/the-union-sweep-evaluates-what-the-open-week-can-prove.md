# tests/the-union-sweep-evaluates-what-the-open-week-can-prove.law.test.ts

The union stop-loss evaluates non-payment and exposure as independent legs (an exposure the open week cannot certify is `not_evaluable` and never releases a suspended club), the open-week rake basis snapshot reads through the rakeback settler's committed cursor instead of now(), and the rakeback period calculator reads one week of attributions instead of the club's lifetime; each is proved on the body in force and refuted on the body it replaced (20260926042119, 20260926042810).
