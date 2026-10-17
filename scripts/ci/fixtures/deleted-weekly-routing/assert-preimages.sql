SELECT dr_assert(md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='bbf9b44151a265cfa6c019c197229344','atomic preimage r2');
SELECT dr_assert(md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='be339460b4005d27a66d2d7bb056b490','atomic preimage r3');
SELECT dr_assert(md5(pg_get_functiondef('public.fn_ca_deleted_wallet_credit()'::regprocedure))='c38d47f45b2192b5e20e52205819a381','atomic preimage credit');
SELECT dr_assert(md5(pg_get_functiondef('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)'::regprocedure))='bccd30228fd808adb885cf3c7f47db88','atomic preimage bank');
