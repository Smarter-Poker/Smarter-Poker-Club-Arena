"""Consume the six R46 stock PostgreSQL isolationtester transcripts, fail closed.

PostgreSQL REL_17_11 prints SQL errors to stdout without failing the process.
Step labels precede result consumption; neither a label nor exit zero is proof.
The grammar below follows these primary sources (including session-prefixed
notices, PQprint's one-column void results, and SQL whitespace trimming):
https://github.com/postgres/postgres/blob/REL_17_11/src/test/isolation/isolationtester.c
https://github.com/postgres/postgres/blob/REL_17_11/src/test/isolation/specscanner.l
https://github.com/postgres/postgres/blob/REL_17_11/src/interfaces/libpq/fe-print.c

Call with separately captured, unfiltered stdout/stderr and the actual process
returncode. The caller owns provider/fixture/catalog identity, C message locale,
finite execution deadlines, fresh database composition, all-case aggregation,
and independent connection/worker/database disposal. This parser does not run
anything, qualify those boundaries, or authenticate an arbitrary supplied log.
"""

import hashlib
import re


_CASES = {
    "creation_commit": ("ensure('a','created')", "ensure('b','existing_active')"),
    "creation_rollback": ("ensure('a','created')", "ensure('b','created')"),
    "edit_after_creation": ("ensure('a','created')", "edit_target(true)"),
    "edit_before_creation": ("expect_direct_target_refusal()", "edit_target(false)"),
    "restart_commit": ("restart('a',5,false)", "restart('b',6,true)"),
    "restart_rollback": ("restart('a',5,false)", "restart('b',6,false)"),
}
_TOKEN = re.compile(
    r'(?P<session>session\s+"[a-z_]+")'
    r'|(?P<step>step\s+"[a-z_]+"\s*\{[^{}\n]*\})'
    r'|(?P<block>(?:setup|teardown)\s*\{[^{}]*\})'
    r'|(?P<permutation>permutation(?:[ \t]+"[a-z_]+")+)'
)
_LIMIT = 1024 * 1024


def _sha256(value):
    try:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
    except UnicodeError as exc:
        raise ValueError("input is not valid UTF-8 text") from exc


def _contract(entry, spec_text):
    if not isinstance(entry, dict) or not isinstance(spec_text, str):
        raise ValueError("case entry and UTF-8 spec text are required")
    case = entry.get("case")
    if not isinstance(case, str) or case not in _CASES:
        raise ValueError("unsupported isolation case")
    digest = _sha256(spec_text)
    if digest != entry.get("sha256"):
        raise ValueError("spec SHA-256 differs from the catalog case")
    if type(entry.get("permutations")) is not int or entry["permutations"] != 1:
        raise ValueError("exactly one explicit permutation is required")
    marker = "R46 ISOLATION ASSERTIONS COMPLETE: " + case
    blocker, waiter = ("b", "a") if case == "edit_before_creation" else ("a", "b")
    if (entry.get("final_marker") != marker
            or entry.get("registered_blocker") != blocker
            or entry.get("registered_waiter") != waiter):
        raise ValueError("catalog marker or registered actor identity differs from the case")

    # Parse only the deliberately small grammar used by these reviewed assets.
    # This rejects extra steps/permutations and forced (*) waits rather than
    # mistaking an isolationtester scheduling annotation for an observed lock.
    source = re.sub(r"(?m)^[ \t]*#[^\n]*", "", spec_text)
    session, sessions, setups, teardowns, steps, owners, permutations = (
        None, [], {}, {}, {}, {}, []
    )
    pos = 0
    while pos < len(source):
        if source[pos].isspace():
            pos += 1
            continue
        token = _TOKEN.match(source, pos)
        if token is None:
            raise ValueError("unsupported spec syntax")
        body = token.group()
        if token.lastgroup == "session":
            session = re.search(r'"([a-z_]+)"', body).group(1)
            sessions.append(session)
        elif token.lastgroup == "step":
            name, sql = re.fullmatch(r'step\s+"([a-z_]+)"\s*\{(.*)\}', body).groups()
            if name in steps:
                raise ValueError("duplicate spec step")
            steps[name], owners[name] = sql.strip(), session
        elif token.lastgroup == "block":
            kind, sql = re.fullmatch(r'(setup|teardown)\s*\{(.*)\}', body, re.S).groups()
            blocks = setups if kind == "setup" else teardowns
            if session in blocks:
                raise ValueError("duplicate spec setup/teardown")
            blocks[session] = sql.strip()
        else:
            permutations.append(re.findall(r'"([a-z_]+)"', body))
        pos = token.end()

    permutation = [blocker + "_begin", blocker + "_action", waiter + "_begin",
                   waiter + "_action", "observed_wait", blocker + "_finish",
                   waiter + "_finish", "final_state"]
    expected_steps = {
        "a_begin": "BEGIN ISOLATION LEVEL READ COMMITTED;",
        "b_begin": "BEGIN ISOLATION LEVEL READ COMMITTED;",
        "a_action": "SELECT r46_mtt_isolation." + _CASES[case][0] + ";",
        "b_action": "SELECT r46_mtt_isolation." + _CASES[case][1] + ";",
        "a_finish": "ROLLBACK;" if case.endswith("_rollback") else "COMMIT;",
        "b_finish": "COMMIT;",
        "observed_wait": f"SELECT r46_mtt_isolation.blocked('{blocker}','{waiter}');",
        "final_state": f"SELECT r46_mtt_isolation.verify_final('{case}');",
    }
    expected_owners = {name: name[0] if name[0] in "ab" else "observer"
                       for name in expected_steps}
    if (sessions != ["a", "b", "observer"] or permutations != [permutation]
            or steps != expected_steps or owners != expected_owners):
        raise ValueError("spec actors, SQL, or single permutation differ from the case contract")
    if (set(setups) != {None, "a", "b", "observer"}
            or setups[None] != "SELECT r46_mtt_isolation.pristine();"
            or teardowns != {"a": "ROLLBACK;", "b": "ROLLBACK;"}):
        raise ValueError("unsupported setup/teardown contract")
    return case, digest, marker, blocker, waiter, permutation, steps


class _Transcript:
    def __init__(self, stdout):
        self.lines = stdout.split("\n")
        self.index = 0

    def peek(self):
        while self.index < len(self.lines) and self.lines[self.index] == "":
            self.index += 1
        return self.lines[self.index] if self.index < len(self.lines) else None

    def expect(self, expected):
        if self.peek() != expected:
            # Do not echo untrusted output (possibly including connection data).
            raise ValueError(f"unexpected/missing output at line {self.index + 1}: expected {expected}")
        self.index += 1

    def void_result(self, name):
        self.expect(name)
        # PQprint emits header, dashes, one empty padded value and row count.
        # Accept stripped trailing spaces, but do not discard the empty row.
        tail = self.lines[self.index:self.index + 3]
        if (len(tail) != 3 or tail[0] != "-" * len(name)
                or tail[1] not in ("", " " * len(name)) or tail[2] != "(1 row)"):
            raise ValueError(f"missing successful one-row void result for {name}")
        self.index += 3


def validate_case_result(case_entry, spec_text, *, stdout, stderr, returncode):
    """Return a bound transcript receipt, or raise ValueError on any gap.

    A successful ``blocked`` result is the fixture's actual pg_blocking_pids
    assertion. The final NOTICE is emitted only after its complete database
    assertions; its accompanying successful result is independently required.
    A caller must never supply just step labels, merged/filtered output, or a
    previous process result. The receipt describes transcript acceptance only.
    """
    case, digest, marker, blocker, waiter, permutation, steps = _contract(case_entry, spec_text)
    if type(returncode) is not int or returncode != 0:
        raise ValueError("isolationtester did not exit with integer status zero")
    if not isinstance(stdout, str) or not isinstance(stderr, str):
        raise ValueError("separate stdout and stderr text is required")
    if stderr != "":
        raise ValueError("isolationtester stderr is not empty")
    if not stdout or len(stdout) > _LIMIT or not stdout.endswith("\n"):
        raise ValueError("missing, oversized, or truncated isolationtester stdout")
    if any(ord(char) < 32 and char != "\n" or ord(char) == 127 for char in stdout):
        raise ValueError("unexpected control characters in isolationtester stdout")
    transcript = _Transcript(stdout)
    transcript.expect("Parsed test spec with 3 sessions")
    transcript.expect("starting permutation: " + " ".join(permutation))
    transcript.void_result("pristine")

    completed = []

    def finish(name, resumed=False):
        transcript.expect(f"step {name}: " + ("<... completed>" if resumed else steps[name]))
        if steps[name].startswith("SELECT "):
            function = steps[name].split(".", 1)[1].split("(", 1)[0]
            transcript.void_result(function)
        completed.append(name)

    # These unannotated permutations have one lock waiter. A successful owner
    # release is followed by the resumed waiter before its next session step.
    for name in permutation[:3]:
        finish(name)
    waiting_step = waiter + "_action"
    transcript.expect(f"step {waiting_step}: {steps[waiting_step]} <waiting ...>")
    finish("observed_wait")
    finish(blocker + "_finish")
    finish(waiting_step, resumed=True)
    finish(waiter + "_finish")

    # libpq can deliver the final NOTICE in PQconsumeInput before the step
    # header, or in PQgetResult just after it. Neither position is success
    # without the final query's tuple result. No notices are accepted earlier.
    notice = "observer: NOTICE:  " + marker
    marker_before_header = transcript.peek() == notice
    if marker_before_header:
        transcript.expect(notice)
    transcript.expect("step final_state: " + steps["final_state"])
    if not marker_before_header:
        transcript.expect(notice)
    transcript.void_result("verify_final")
    completed.append("final_state")

    # Both actors already COMMITted/ROLLBACKed. Their explicit teardown
    # ROLLBACKs necessarily warn, in declaration order, after final assertions.
    # No generic WARNING/NOTICE/ERROR ignore rule is safe here.
    warnings = [f"{actor}: WARNING:  there is no transaction in progress" for actor in ("a", "b")]
    for warning in warnings:
        transcript.expect(warning)
    if transcript.peek() is not None:
        raise ValueError("unexpected trailing isolationtester output")
    return {
        "case": case,
        "status": "transcript_accepted",
        "spec_sha256": digest,
        "stdout_sha256": _sha256(stdout),
        "permutation": permutation,
        "completed_steps": completed,
        "observed_wait_assertion": True,
        "final_marker": marker,
        "accepted_teardown_warnings": warnings,
    }


def validate_format_lock_result(entry, spec_text, *, stdout, stderr, returncode, negative=False):
    """Strictly consume both stock preparation lock permutations and controls.

    Exit zero and printed SQL labels cannot establish lock ownership. Require
    the actual waiter/resume sequence, successful scalar results, exact observer
    proof (or the deliberately induced refusal), both releases, and final ABI.
    """
    cases = {
        "format_admission": ("fn_ca_lock_mtt_admission_contract", "FORMAT_LOCK",
            "SELECT public.fn_ca_lock_mtt_admission_contract();", "legacy-capacity-v1"),
        "registration_admission": ("fn_ca_lock_tournament_seat_acquisition", "REGISTRATION_ADMISSION_LOCK",
            "SELECT public.fn_ca_lock_tournament_seat_acquisition('46464300-0000-4000-8000-000000000001',NULL,NULL);",
            '{"ok": true, "status": "REGISTERING", "table_id": null, "tournament_id": "46464300-0000-4000-8000-000000000001"}'),
        "seat_capacity_admission": ("fn_ensure_late_registration_capacity", "SEAT_CAPACITY_ADMISSION_LOCK",
            "SELECT public.fn_ensure_late_registration_capacity('46464403-0000-4000-8000-000000000001',0);",
            '{"ok": true, "reason": "tournament_not_running", "created": false}'),
    }
    case = entry.get("case")
    if (case not in cases or _sha256(spec_text) != entry.get("sha256")
            or type(entry.get("permutations")) is not int or entry["permutations"] != 2):
        raise ValueError("preparation lock spec/identity binding changed")
    if (type(returncode) is not int or returncode != 0 or stderr != ""
            or not isinstance(stdout, str) or not stdout or len(stdout) > _LIMIT
            or not stdout.endswith("\n") or type(negative) is not bool):
        raise ValueError("preparation isolation process did not return complete separate output")
    if any(ord(char) < 32 and char != "\n" or ord(char) == 127 for char in stdout):
        raise ValueError("unexpected preparation output control characters")
    function, marker, reader_sql, reader_result = cases[case]
    steps = dict(re.findall(r'^step "([a-z_]+)"\s*\{(.*?)\}', spec_text, re.M | re.S))
    simple = {"reader_begin": "BEGIN;", "reader_lock": reader_sql,
              "reader_commit": "COMMIT;", "reader_rollback": "ROLLBACK;", "writer_begin": "BEGIN;",
              "writer_update": "UPDATE public.ca_mtt_admission_contract SET abi=abi WHERE singleton;",
              "writer_rollback": "ROLLBACK;", "final_legacy": "SELECT abi FROM public.ca_mtt_admission_contract;"}
    if (set(steps) != {*simple, "observed_wait"}
            or any(steps[name].strip() != sql for name, sql in simple.items())
            or "pg_blocking_pids(w.pid)" not in steps["observed_wait"]
            or "RAISE NOTICE '" + marker + "_WAIT_PROVEN';" not in steps["observed_wait"]):
        raise ValueError("preparation lock SQL shape changed")
    permutations = [re.findall(r'"([a-z_]+)"', line)
                    for line in spec_text.splitlines() if line.startswith("permutation ")]
    expected = [["reader_begin", "reader_lock", "writer_begin", "writer_update", "observed_wait",
                 finish, "writer_rollback", "final_legacy"] for finish in ("reader_commit", "reader_rollback")]
    if permutations != expected:
        raise ValueError("both exact unforced preparation permutations required")
    transcript = _Transcript("\n".join(line.rstrip(" ") for line in stdout.split("\n")))
    transcript.expect("Parsed test spec with 3 sessions")

    def scalar(name, value):
        transcript.expect(name)
        dashes = transcript.peek()
        width = max(len(name), len(value))
        if not dashes or not re.fullmatch(r'-{' + str(width) + ',' + str(width + 2) + '}', dashes):
            raise ValueError("preparation scalar result header missing")
        transcript.index += 1
        transcript.expect(value)
        transcript.expect("(1 row)")

    for permutation in expected:
        transcript.expect("starting permutation: " + " ".join(permutation))
        transcript.expect("step reader_begin: BEGIN;")
        transcript.expect("step reader_lock: " + reader_sql)
        scalar(function, reader_result)
        transcript.expect("step writer_begin: BEGIN;")
        transcript.expect("step writer_update: " + simple["writer_update"] + ("" if negative else " <waiting ...>"))
        notice = "observer: NOTICE:  " + marker + "_WAIT_PROVEN"
        before_header = not negative and transcript.peek() == notice
        if before_header:
            transcript.expect(notice)
        transcript.expect("step observed_wait:")
        for line in steps["observed_wait"].splitlines():
            if line.strip():
                transcript.expect(line.rstrip(" "))
        if negative:
            transcript.expect("ERROR:  " + marker + "_WAIT_NOT_PROVEN")
        elif not before_header:
            transcript.expect(notice)
        finish = permutation[5]
        transcript.expect("step " + finish + ": " + simple[finish])
        if not negative:
            transcript.expect("step writer_update: <... completed>")
        transcript.expect("step writer_rollback: ROLLBACK;")
        transcript.expect("step final_legacy: " + simple["final_legacy"])
        scalar("abi", "legacy-capacity-v1")
        for actor in ("reader", "writer"):
            transcript.expect(actor + ": WARNING:  there is no transaction in progress")
    if transcript.peek() is not None:
        raise ValueError("unexpected trailing preparation isolation output")
    return {"case": case, "status": "negative_control_rejected" if negative else "transcript_accepted",
            "spec_sha256": _sha256(spec_text), "stdout_sha256": _sha256(stdout),
            "permutations": 2, "observed_wait_assertions": 0 if negative else 2,
            "exact_missing_lock_refusals": 2 if negative else 0, "final_abi": "legacy-capacity-v1"}
