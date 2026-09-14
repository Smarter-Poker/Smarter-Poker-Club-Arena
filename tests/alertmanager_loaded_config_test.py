"""Behavioral coverage for the production config verifier (stdlib only)."""
import importlib.util
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "infra/monitoring/verify-alertmanager-config.py"
SPEC = importlib.util.spec_from_file_location("verifier", SCRIPT)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def metrics(config=b"abc", successful=1):
    return (f"alertmanager_config_hash {verifier.expected_hash(config):.14e}\n"
            f"alertmanager_config_last_reload_successful {successful}\n")


class LoadedConfigTests(unittest.TestCase):
    def test_deploy_recreates_only_on_proven_mismatch_and_requires_repaired_parity(self):
        deploy = (SCRIPT.parent / "deploy.sh").read_text()
        block = deploy[deploy.index('AM_VERIFIER='):deploy.index('\nFAIL=0')]
        for statuses, exit_code, recreated in [("0", 0, False), ("2 0", 0, True),
                                                ("3", 3, False), ("2 2", 2, True),
                                                ("2 3", 3, True)]:
            with self.subTest(statuses=statuses), tempfile.TemporaryDirectory() as directory:
                # Run the actual release block, replacing only its external I/O.
                script = '''set -euo pipefail
SRC_DIR=/authorized
python3() {
  printf '%s\\n' "$*" >> "$TEST_LOG"
  local value="${statuses[0]}"
  statuses=("${statuses[@]:1}")
  return "$value"
}
docker() { printf 'docker %s\\n' "$*" >> "$TEST_LOG"; }
curl() { return 0; }
sleep() { :; }
'''
                script += f"statuses=({statuses})\n" + block
                script += '\nprintf "receipt authorized\\n" >> "$TEST_LOG"\n'
                log = Path(directory) / "calls"
                result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                        env={**os.environ, "TEST_LOG": str(log)}, timeout=5)
                calls = log.read_text()
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertEqual("docker compose up -d --no-deps --force-recreate alertmanager" in calls,
                                 recreated)
                self.assertEqual("receipt authorized" in calls, exit_code == 0)
                self.assertEqual(calls.count("verify-alertmanager-config.py"), 2 if recreated else 1)

    def test_upstream_little_endian_six_byte_vector(self):
        # MD5(abc) begins 90 01 50 98 3c d2, not the big-endian integer.
        self.assertEqual(verifier.expected_hash(b"abc"), 0xD23C98500190)
        self.assertEqual(verifier.verify(b"abc", metrics())[0], 0)

    def test_successful_reload_of_detached_old_inode_is_not_a_release(self):
        self.assertEqual(verifier.verify(b"new routes", metrics(b"old routes"))[0], 2)

    def test_even_one_changed_byte_is_detected(self):
        self.assertEqual(verifier.verify(b"abc\n", metrics())[0], 2)

    def test_matching_hash_with_failed_reload_is_not_a_release(self):
        self.assertEqual(verifier.verify(b"abc", metrics(successful=0))[0], 2)

    def test_missing_duplicate_labeled_nonfinite_and_invalid_metrics_fail_closed(self):
        valid = metrics()
        for body in ["", valid.splitlines()[0], valid + valid,
                     valid.replace("hash ", 'hash{replica="1"} '),
                     valid.replace(valid.split()[1], "NaN"),
                     valid.replace(valid.split()[1], "Inf"),
                     valid.replace(valid.split()[1], "1.5"),
                     metrics(successful=2),
                     valid.replace(valid.split()[1], str(2**48)),
                     valid.replace(valid.split()[1], "-1")]:
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    verifier.verify(b"abc", body)

    def test_real_http_cli_distinguishes_mismatch_from_unavailable(self):
        class Handler(BaseHTTPRequestHandler):
            body = metrics().encode()
            status = 200

            def do_GET(self):
                self.send_response(self.status)
                self.end_headers()
                self.wfile.write(self.body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / "config.yml"
                config.write_bytes(b"abc")
                args = [sys.executable, str(SCRIPT), str(config), "--metrics-url",
                        f"http://127.0.0.1:{server.server_port}/metrics"]
                for body, status, expected in [(metrics(), 200, 0),
                                                (metrics(b"previous"), 200, 2),
                                                (metrics(successful=0), 200, 2),
                                                ("malformed SECRET", 200, 3),
                                                ("SECRET", 503, 3)]:
                    Handler.body, Handler.status = body.encode(), status
                    result = subprocess.run(args, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    self.assertNotIn("SECRET", result.stdout + result.stderr)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
