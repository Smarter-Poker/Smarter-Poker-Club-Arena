# Club channels require current membership

The engine previously accepted any club-member row for a club channel, including a retained departed financial wallet. Club channel admission now requires an active lifecycle, an enabled membership, and native active/approved status. Automatic Diamond participation remains supported. Failed or unknown membership reads retain the existing bounded recovery and fail closed.

The focused club recovery suite covers departed, suspended, inactive, missing lifecycle, absent membership, read failures, stale intent, and native chip and Diamond admission across player and staff roles. The regression failed before the change.

This engine change is a prerequisite for the separately qualified historical rakeback wallet migration. The engine must complete its protected release and affected runtime verification before that migration creates departed financial wallets. This PR makes no database changes or payments.
