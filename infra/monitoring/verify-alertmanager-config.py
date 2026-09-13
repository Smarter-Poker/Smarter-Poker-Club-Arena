#!/usr/bin/env python3
"""Prove Alertmanager loaded the shipped bytes, without printing credentials.

Alertmanager v0.27.0 config/coordinator.go publishes the first six MD5 bytes
as a little-endian integer after every reload subscriber succeeds. This gauge
is a runtime identity check; the release manifest separately uses SHA-256.
https://github.com/prometheus/alertmanager/blob/v0.27.0/config/coordinator.go
"""

import argparse
import hashlib
import math
from pathlib import Path
import sys
from urllib.request import urlopen


def expected_hash(config):
    return int.from_bytes(hashlib.md5(config).digest()[:6], "little")


def read_metric(metrics, name):
    values = []
    for line in metrics.splitlines():
        fields = line.split()
        if fields and (fields[0] == name or fields[0].startswith(name + "{")):
            if len(fields) != 2 or fields[0] != name:
                raise ValueError("unexpected metric shape: " + name)
            value = float(fields[1])
            if not math.isfinite(value):
                raise ValueError("nonfinite metric: " + name)
            values.append(value)
    if len(values) != 1:
        raise ValueError("expected one metric: " + name)
    return values[0]


def verify(config, metrics):
    loaded = read_metric(metrics, "alertmanager_config_hash")
    successful = read_metric(metrics, "alertmanager_config_last_reload_successful")
    if loaded < 0 or loaded >= 2**48 or not loaded.is_integer() or successful not in (0, 1):
        raise ValueError("invalid Alertmanager configuration metrics")
    expected = expected_hash(config)
    if successful != 1 or loaded != expected:
        return 2, f"Alertmanager configuration mismatch: expected={expected} loaded={int(loaded)} reload_successful={int(successful)}"
    return 0, f"Alertmanager loaded configuration verified: hash={expected} sha256={hashlib.sha256(config).hexdigest()}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--metrics-url", default="http://127.0.0.1:9093/metrics")
    args = parser.parse_args()
    try:
        config = args.config.read_bytes()
        with urlopen(args.metrics_url, timeout=5) as response:
            metrics = response.read(4 * 1024 * 1024 + 1)
        if len(metrics) > 4 * 1024 * 1024:
            raise ValueError("metrics response exceeds limit")
        code, message = verify(config, metrics.decode("utf-8"))
    except Exception as exc:
        # Do not print the exception body: HTTP locations may carry credentials.
        print(f"Cannot verify Alertmanager configuration ({type(exc).__name__})", file=sys.stderr)
        return 3
    print(message)
    return code


if __name__ == "__main__":
    sys.exit(main())
