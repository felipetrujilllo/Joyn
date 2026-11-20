"""Tests for the project skeleton (issue #1)."""

import subprocess
import sys
from pathlib import Path

import phonepad

ROOT = Path(__file__).resolve().parents[2]


def test_version():
    assert phonepad.__version__ == "0.0.1"


def test_main_runs_and_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "phonepad"],
        cwd=ROOT / "core", capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "phonepad 0.0.1: server not implemented yet"


def test_requirements_list_deps_and_evdev_is_linux_only():
    lines = (ROOT / "requirements.txt").read_text().splitlines()
    names = {line.split(";")[0].split("=")[0].split(">")[0].strip() for line in lines if line.strip()}
    assert {"aiohttp", "qrcode", "pytest", "evdev"} <= names
    evdev = next(line for line in lines if line.startswith("evdev"))
    assert 'sys_platform == "linux"' in evdev


def test_gitignore_entries():
    entries = set((ROOT / ".gitignore").read_text().split())
    assert {".venv/", "__pycache__/", ".DS_Store", ".pytest_cache/"} <= entries
