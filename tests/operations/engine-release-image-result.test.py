"""Offline request/result integrity; no host operation or live attestation."""
import copy
import calendar
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load("terminal", ROOT / "server/scripts/engine-release-image-result.py")
fixtures = load("request_fixtures", Path(__file__).with_name("engine-release-image-request.test.py"))


class TerminalTest(unittest.TestCase):
    def setUp(self):
        fixtures.RequestTest.setUp(self)
        self.release_raw = m.request.derive_release(
            self.raw, "123-2", self.generation, m.request.digest(self.raw))
        self.release_digest = m.request.digest(self.release_raw)
        self.release = m.bundle.decode(self.release_raw)
        self.value = {
            "protocol": m.PROTOCOL, "outcome": "published", "run_key": "123-2",
            "request_sha256": self.release_digest,
            "intake_sha256": self.release["intake_sha256"],
            "source_sha": self.release["source_sha"],
            "control_sha": self.release["control_sha"],
            "image_authority_sha256": m.request.digest(m.bundle.encode(self.release["image_authority"])),
            "attempted_image_id": self.identity["image_id"],
            "invocation_id": "d" * 32,
            "runtime": {"source_sha": self.release["source_sha"], "image_id": self.identity["image_id"],
                        "container_id": "e" * 64, "instance_id": "1-deadbeef",
                        "started_at": "2026-09-14T12:00:00.123456789Z"},
            "exit_status": 0, "finished_at_epoch": 2000000200,
        }

    def tearDown(self):
        fixtures.RequestTest.tearDown(self)

    def raw_value(self, value=None):
        return m.bundle.encode(self.value if value is None else value)

    def validate(self, value=None):
        return m.validate_terminal(self.raw_value(value), self.release_raw, "123-2", self.release_digest)

    def test_complete_bound_published_record(self):
        self.assertEqual(self.validate(), self.value)

    def test_replayed_record_never_authorizes_mutation_cleanup_or_live_attestation(self):
        result = m.decide_replay(self.raw_value(), self.release_raw, "123-2", self.release_digest)
        self.assertEqual(result["outcome"], "published")
        for key in ["new_transaction_authorized", "cleanup_authorized", "live_runtime_attested"]:
            self.assertIs(result[key], False)

    def test_failure_records_preserve_recovered_identity_without_claiming_live_recovery(self):
        self.value["outcome"] = "failed"
        self.value["exit_status"] = 1
        self.value["runtime"]["source_sha"] = "9" * 40
        self.value["runtime"]["image_id"] = "sha256:" + "8" * 64
        result = m.decide_replay(self.raw_value(), self.release_raw, "123-2", self.release_digest)
        self.assertEqual(result["outcome"], "failed")
        self.assertIs(result["live_runtime_attested"], False)

    def test_wrong_independent_request_digest_is_rejected(self):
        with self.assertRaises(ValueError):
            m.validate_terminal(self.raw_value(), self.release_raw, "123-2", "0" * 64)

    def test_an_intake_cannot_be_used_as_a_release(self):
        with self.assertRaises(ValueError):
            m.validate_terminal(self.raw_value(), self.raw, "123-2", m.request.digest(self.raw))

    def test_v1_result_cannot_be_promoted(self):
        with self.assertRaises(ValueError):
            self.validate({"schema": 1, "result": "published", "runId": "123-2"})

    def test_every_request_axis_is_bound(self):
        replacements = {
            "run_key": "123-3", "request_sha256": "1" * 64,
            "intake_sha256": "2" * 64, "source_sha": "3" * 40,
            "control_sha": "4" * 40, "image_authority_sha256": "5" * 64,
            "attempted_image_id": "sha256:" + "6" * 64,
        }
        for field, replacement in replacements.items():
            value = copy.deepcopy(self.value)
            value[field] = replacement
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(value)

    def test_terminal_shape_cannot_drop_or_add_authority_fields(self):
        for field in self.value:
            value = copy.deepcopy(self.value)
            del value[field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(value)
        value = copy.deepcopy(self.value)
        value["cleanup_authorized"] = True
        with self.assertRaises(ValueError):
            self.validate(value)

    def test_runtime_shape_cannot_drop_or_add_fields(self):
        for field in self.value["runtime"]:
            value = copy.deepcopy(self.value)
            del value["runtime"][field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(value)
        self.value["runtime"]["healthy"] = True
        with self.assertRaises(ValueError):
            self.validate()

    def test_published_result_requires_exact_source_and_image(self):
        for field, replacement in [("source_sha", "8" * 40), ("image_id", "sha256:" + "7" * 64)]:
            value = copy.deepcopy(self.value)
            value["runtime"][field] = replacement
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(value)

    def test_no_retryable_or_nonfailure_status_is_terminal_failure(self):
        self.value["outcome"] = "failed"
        for status in [0, 75, -1, 256, True, False, "1", 1.0, None]:
            self.value["exit_status"] = status
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.validate()

    def test_published_requires_integer_zero_status(self):
        for status in [1, 75, True, False, "0", 0.0, None]:
            self.value["exit_status"] = status
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.validate()

    def test_bounded_completion_identity(self):
        for field, values in {
            "invocation_id": ["", "D" * 32, "d" * 31, None],
            "finished_at_epoch": [0, -1, 10000000000, True, "1", 1.0, None],
        }.items():
            for replacement in values:
                value = copy.deepcopy(self.value)
                value[field] = replacement
                with self.subTest(field=field, replacement=replacement), self.assertRaises(ValueError):
                    self.validate(value)

    def test_runtime_identity_rejects_malformed_values(self):
        for field, values in {
            "source_sha": [None, "", "g" * 40],
            "image_id": [None, "latest", "sha256:" + "g" * 64],
            "container_id": [None, "short", "E" * 64],
            "instance_id": [None, "0-deadbeef", "1-short", "1-deadbeef\n"],
            "started_at": [None, "", "2026-09-14", "2026-09-14T12:00:00+00:00"],
        }.items():
            for replacement in values:
                value = copy.deepcopy(self.value)
                value["runtime"][field] = replacement
                with self.subTest(field=field, replacement=replacement), self.assertRaises(ValueError):
                    self.validate(value)

    def test_runtime_start_must_be_a_real_calendar_time(self):
        for replacement in ["2026-99-14T12:00:00Z", "2026-02-30T12:00:00Z", "2026-09-14T25:00:00Z"]:
            self.value["runtime"]["started_at"] = replacement
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                self.validate()

    def test_completion_cannot_precede_runtime_start(self):
        self.value["finished_at_epoch"] = 1
        with self.assertRaises(ValueError):
            self.validate()

    def test_nanosecond_start_can_complete_in_the_same_recorded_second(self):
        self.value["finished_at_epoch"] = calendar.timegm((2026, 9, 14, 12, 0, 0))
        self.assertEqual(self.validate()["runtime"]["started_at"], "2026-09-14T12:00:00.123456789Z")

    def test_real_leap_day_is_preserved(self):
        self.value["runtime"]["started_at"] = "2024-02-29T12:00:00Z"
        self.assertEqual(self.validate()["runtime"]["started_at"], "2024-02-29T12:00:00Z")

    def test_permanent_process_failures_remain_failure_history(self):
        self.value["outcome"] = "failed"
        for status in [1, 127, 137, 255]:
            self.value["exit_status"] = status
            with self.subTest(status=status):
                self.assertEqual(self.validate()["exit_status"], status)

    def test_completion_can_follow_original_deadline_without_renewing_it(self):
        self.assertGreater(self.value["finished_at_epoch"], self.deadline)
        result = m.decide_replay(self.raw_value(), self.release_raw, "123-2", self.release_digest)
        self.assertIs(result["new_transaction_authorized"], False)
        self.assertEqual(m.bundle.decode(self.release_raw)["not_after_epoch"], self.deadline)

    def test_noncanonical_duplicate_and_oversized_bytes_are_rejected(self):
        canonical = self.raw_value()
        cases = [b"", canonical + b"\n", b"x" * (m.request.LIMIT + 1),
                 json.dumps(self.value, indent=2).encode(),
                 b'{"protocol":"forged",' + canonical[1:]]
        for raw in cases:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                m.validate_terminal(raw, self.release_raw, "123-2", self.release_digest)


if __name__ == "__main__":
    unittest.main()
