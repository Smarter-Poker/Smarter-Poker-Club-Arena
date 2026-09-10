# Independent Review of Booked Spin SQL Authority

Reviewed commits: 189db49328d8652b975635bf614323791e81e230 and owner-gate follow-up 30a5ee0156ef37f2c6c2e8f167e369a5896e14ae. Scope: the self-contained Spin resolver migration, installed fixture, runtime/native runners and evidence. The deferred combined Heads-Up migration was excluded.

The proposal is acceptable for its stated SQL-only scope. I independently removed only the added Spin declarations and booked-receipt branch and compared the entire remaining function body with the installed capture: byte-identical. Installed body MD5 is b5769b647e5b106caaf51982ac245ee8; proposed body MD5 is 4f83c09a69eecc766a1f3984feeb9823. Persisted levels, legacy Spin, Heads-Up and generic MTT behavior are preserved by that whole-body comparison.

The exact postgres owner, private execute ACL, SECURITY DEFINER setting and fixed search_path are checked before and after replacement. The new branch validates frozen JSON number fields against the finite JavaScript Number domain, retains float arithmetic through power/division/multiplication, and explicitly implements positive Math.round ties without PostgreSQL's float ties-to-even or an unsafe add-0.5 shortcut. Malformed present metadata refuses instead of silently substituting another formula.

I reran the actual pinned manager runtime at d9dbf1388617ebfad71b00040aac22819c4103af. All 93 successful rows and the zero-result refusal match the committed evidence, including exact pinned source hashes. Every proposed small blind, big blind and ante matches the freshly executed manager. Runtime output SHA256: 1680ed46a281b2751e63095335fef2e1609f2e2df26e7a8aaebc8acba803acf2.

The reviewed native evidence reports 13 installed mismatches and zero proposed mismatches, 60 unchanged generic cases, 24 unchanged legacy/HU cases, 12 rounding cases, 13 malformed receipt refusals, three preflight refusals and private ACL preservation. I inspected those actual runner assertions; I did not create another native cluster or execute production SQL. This review does not authorize deployment or certify unrelated clock/HU behavior.
