# Hand Display Privacy

Owner request: remove rake and jackpot rake from hand details, shares and every connected player-facing hand display. Remove the summary/detail deductions, personal rake footer and fetch, history row labels, copied text and exported text. New shares omit deduction fields at both model and codec boundaries. Legacy links remain decodable, with deduction-free rendering. Preserve pot totals, actual winnings and all accounting records/calculations.

Client-only delivery; no engine or database change. Regression coverage renders both modal tabs and the shared rundown with positive deductions, checks new wire payloads, exports and history output, and retains corpus comparisons for pot/action/winner fidelity. Export text intentionally omits the previous rake suffix; external tracker ingestion is not certified.
