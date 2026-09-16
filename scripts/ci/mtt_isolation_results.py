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
