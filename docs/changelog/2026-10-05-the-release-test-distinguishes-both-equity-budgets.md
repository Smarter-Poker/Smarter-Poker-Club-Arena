# The release test distinguishes both equity budgets

Engine release 37348217831 failed because the real-clock net-action test expected every non-firing policy result to say `work_budget`. The sampler has a separate 2.5 ms deadline; when it expires before any sample and the policy finishes within its 4 ms deadline, the correct existing result is `equity_budget_unavailable`.

The test now checks that closed set of two reasons and each reason's evidence: unavailable equity and range below the policy deadline, or elapsed time above the policy deadline. Both must retain the exact baseline decision and proposal, refuse firing/application, carry no action economics or feature tag, and pass receipt binding validation. The firing-node economic assertions remain unchanged. No runtime policy or time limit changes.

Injected clocks reproduce both boundaries without relying on runner load. The 3 ms case failed the old assertion with the same message as the hosted release; both boundary cases and the existing real-clock coverage pass after the correction.
