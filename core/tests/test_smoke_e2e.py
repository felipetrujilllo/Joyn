"""Runs core/scripts/smoke_e2e.py (issue #11) as Felipe would: a subprocess, no PYTHONPATH."""

import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "smoke_e2e.py"


def test_end_to_end_smoke_passes_over_a_real_socket():
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    run = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                         timeout=90, env=env, cwd=str(SCRIPT.parent))
    assert run.returncode == 0, run.stdout + run.stderr
    assert "FAIL" not in run.stdout
    assert run.stdout.strip().splitlines()[-1] == "PASS end-to-end smoke test"
