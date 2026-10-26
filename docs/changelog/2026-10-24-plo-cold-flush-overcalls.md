# PLO cold flush overcalls

Hand 45855223 exposed two connected decisions on a monotone PLO5 river: a third-nut-or-worse flush fired a third barrel into two opponents who called both earlier barrels, and another low flush called off after a bet and a short all-in raise. The previous cap required hero to have bet first or a large final call/pot ratio, allowing cold multiway pressure to bypass it.

The existing Omaha nut-discipline cap now recognizes price-increasing cold bet/jam chains among opponents sharing hero's pots. It tracks actual paid contributions, so a short raise counts as range evidence without treating an all-in call as aggression. A third-nut-or-worse flush checks after two live opponents each called both prior barrels. Nut/second-nut value, cheap calls, earlier streets, actual qualifying-low pots, and multiple boards retain their existing decisions.

Using the exact accepted public controller nodes and the acting horse's revealed cards, the corrected baseline bet Drew's river40/40 and called Cole all-in40/40 across five styles and eight seeds. The candidate checks the initial river, folds the cold overcall, and preserves the later21.75 call. Twenty-five focused cases and13 existing Omaha-discipline cases pass. No opponent hidden holdings, player-name rule, chip mutation or model promotion is used. Original worker RNG and historical read frames are unavailable, so this is a scoped regression rather than an exact replay of its learned state.

Urgent publication uses the existing protected release and certified maintenance transaction. Source/tests are not live activation evidence; the current task checkpoint retains actual provider and runtime proof.
