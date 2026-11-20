"""Tests for core/scripts/pad_smoke_test.py (issue #3). No hardware needed."""

import importlib.util
import subprocess
import sys
from pathlib import Path

from phonepad.backends.fake import FakeBackend
from phonepad.backends.uinput import UinputBackend

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pad_smoke_test.py"
_spec = importlib.util.spec_from_file_location("pad_smoke_test", SCRIPT)
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)

SYN = ("EV_SYN", "SYN_REPORT", 0)
ONE_LOOP = [
    ("EV_KEY", "BTN_SOUTH", 1), SYN,
    ("EV_KEY", "BTN_SOUTH", 0), SYN,
    ("EV_ABS", "ABS_X", -32768), SYN,
    ("EV_ABS", "ABS_X", 0), SYN,
    ("EV_ABS", "ABS_X", 32767), SYN,
    ("EV_ABS", "ABS_X", 0), SYN,
]
NEUTRAL = [("EV_KEY", "BTN_SOUTH", 0), ("EV_ABS", "ABS_X", 0), SYN]


def test_one_loop_presses_a_and_sweeps_left_stick_on_player_2():
    fake = FakeBackend()
    sleeps = []
    smoke.run(fake, loops=1, sleep=sleeps.append, delay=0.5)
    assert fake.events == {2: ONE_LOOP + NEUTRAL}
    assert fake.pads == []  # closed on exit
    assert sleeps == [0.5] * 6


def test_ctrl_c_still_neutralizes_and_closes():
    fake = FakeBackend()

    def interrupt(_):
        if len(fake.events[2]) == 2:  # right after A was pressed and synced
            raise KeyboardInterrupt

    try:
        smoke.run(fake, loops=None, sleep=interrupt)
    except KeyboardInterrupt:
        pass
    assert fake.events[2] == [("EV_KEY", "BTN_SOUTH", 1), SYN] + NEUTRAL
    assert fake.pads == []


def test_uinput_error_prints_message_and_exits_nonzero(monkeypatch, capsys):
    def no_access(caps):
        raise PermissionError(13, "Permission denied", "/dev/uinput")

    monkeypatch.setitem(smoke.BACKENDS, "uinput", lambda: UinputBackend(open_device=no_access))
    assert smoke.main(["--loops", "1", "--delay", "0"]) == 1
    err = capsys.readouterr().err
    assert "Cannot write to /dev/uinput" in err and "Traceback" not in err


def test_cli_fake_one_loop_prints_recorded_events():
    out = subprocess.run(
        [sys.executable, str(SCRIPT), "--backend", "fake", "--loops", "1", "--delay", "0"],
        capture_output=True, text=True, check=True,
    ).stdout
    assert out.splitlines() == [repr(e) for e in ONE_LOOP + NEUTRAL]
