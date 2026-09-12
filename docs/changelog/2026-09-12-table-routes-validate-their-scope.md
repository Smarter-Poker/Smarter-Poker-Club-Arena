# Refuse malformed table routes before starting database reads

Production certification found `/table/demo` and `/table/nonexistent-table-id` reaching UUID database columns through seat, jackpot and hole-card reads. TablePage now resolves its route or embedded table ID to a valid UUID before passing it to any effect. The seat service also refuses invalid IDs before constructing its query.

Valid table IDs keep the existing queries and behavior. Six service regression cases cover quiet refusal and a valid table read. The existing production route checks remain the required served-state proof; this source change alone does not complete the production certificate.
