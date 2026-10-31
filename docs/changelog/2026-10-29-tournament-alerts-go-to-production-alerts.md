# Tournament alerts terminate at Production Alerts

Tournament alerts previously reached the durable Codex inbox and then continued into the critical/warning email routes. Critical failures and recovery messages therefore repeated in email even after chat delivery.

Terminal routes now match component=tournament and legacy Tournament/MTT/Spin alert names before the generic severity routes. They retain firing and recovery evidence in the existing inbox without matching secondary email. Canary suppression and unrelated infrastructure email remain unchanged.

The existing monitoring deployment executes the upstream amtool route evaluator against the candidate configuration before activation. The checked-in cases cover severity, legacy SMS priority labels, missing component labels, canaries, and infrastructure routing. The previous configuration fails the same receiver assertion; the corrected configuration passes all16 cases. Installed configuration and real event delivery still require live verification.
