# Payout law recognizes the original function boundary

The payout law failed on the installed original tournament receipt migration because it looked only for `$function$;`, while the valid captured function definition ends with `$function$` followed by a newline and semicolon. Its single payout insert belongs to `fn_credit_and_log`; the obligation caller delegates to that owner and writes no second payout.

The scanner now locates the matched dollar delimiter and a following whitespace-separated semicolon. The existing satellite separation checks use the same boundary reader. The historical exception list, complete migration scan and payout ownership rule are unchanged. Direct controls cover tagged and untagged delimiters, whitespace, duplicate inserts before/after/in a sibling function, and malformed definitions that must receive no exemption.

The original focused Vitest run reproduced the exact migration offender. The corrected run passes all 11 tests. No monetary logic or installed migration was changed; migration 20260917233447 retains SHA256 `5e28144b38b3131428b42f714249972db63d0da9b5fc98eead4d05edb3a3f7c1`.
