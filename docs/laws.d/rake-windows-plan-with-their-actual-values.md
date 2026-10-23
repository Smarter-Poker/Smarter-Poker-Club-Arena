# tests/rake-windows-plan-with-their-actual-values.law.test.ts

Migration 20261023032335 runs Union Data's window reader (fn_ca_rake_windows_v3) through EXECUTE ... USING so it is planned with the window and clubs it reads; the law pins that the statement is the 20261022165130 text with only its arguments renamed to $1..$4, that the preimage is guarded, and that the reader stays closed to client roles.
