# Uniform-policy continuation smoke-test contract

Retain the pressure harness's original 1,500 uniform draws, raw equity, raw net call price, every fold and call count, and the existing 0.12 excess margin. Compare that equity against price plus the existing nonterminal realization cost: 0.05 on the flop, 0.03 on the turn, zero on the river or when the call exhausts the stack. The synthetic potter bets every holding, so no measured selection penalty is added.

The fixed-estimator repair exposed a comparison that treated a nonterminal call as realizing all showdown equity. The retained failure has uniform equity 0.4646667 and price 63/(126+63-6)=0.3442623, but another 0.05 of continuation cost. Its public-range recovery estimate independently refused its actual price. This intentional oracle correction does not prove that estimate calibrated, the opening profitable, or a historical live call correct. The test is a uniform-policy call smoke test with continuation costs, not a public-range or profit certificate. No hand-specific exemption, new draw, sample tuning, strategy change, or margin increase is introduced. Both potter and limp-potter assertions use the same contract.

Boundary checks retain zero cost on river/all-in calls, independent net-price arithmetic and a high-equity missed-call positive control. Original failure and exact 120-hand diagnostic remain archived.
