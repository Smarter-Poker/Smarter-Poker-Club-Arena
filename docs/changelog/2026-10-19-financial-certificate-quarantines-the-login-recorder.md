# The Financial Admin certificate quarantines the login recorder

#7462 added `fn_achievement_record_login`, a write that the app shell starts on
every signed-in load. It records the login streak in `profiles`. The Financial
Admin certificate in post-deploy job 118267557038 blocks every REST mutation
it has not reviewed, so it refused the page: "Financial read-only guard
blocked 1 REST mutation: POST /rest/v1/rpc/fn_achievement_record_login".

The recorder is a shell background write, like presence and client-error
reports, so it now joins `FINANCIAL_ADMIN_QUARANTINED_SHELL_POST_PATHS`. The
guard aborts it (it is never forwarded) and does not count it as a Financial
page mutation. Every other unreviewed mutation is still blocked.

The same job's two Cashier failures were a separate, finished window. The
client that calls the recorder was live from 20:09:06 to 20:13:11 UTC before
its function answered: 38 calls returned 404, every call since has returned 200.
