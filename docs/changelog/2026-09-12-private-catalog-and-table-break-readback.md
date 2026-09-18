# Private catalog coverage and table-break readback

A service-only metadata helper now provides complete names and columns for the private schema, allowing migration verification to distinguish a qualified object from its schema. It refuses a missing namespace and preserves quoted identifiers. Existing public catalog response shapes are unchanged.

The table-break readback RPC is named `fn_f06_break_state`; its canonical locking, unbound-receipt refusal and state response are unchanged. The former name is removed before runtime consumers are published. Four explicit permission statements restate the existing service-only authority. No financial writer, repair schedule or exception-list entry is added.

Actual migrations `20260912101439` and `20260912101809` are recorded byte for byte. Independent source/native-fixture reviews and root installed definition/permission/history checks support these bounded changes. The native readback-name fixture uses explicit dependency stubs; it is not real funded movement proof. Generator/parser integration, protected release and full movement/cleanup gates remain separate.
