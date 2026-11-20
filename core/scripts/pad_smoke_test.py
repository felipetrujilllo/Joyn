"""Pad smoke test (build step 0): one virtual Xbox 360 pad presses A and sweeps the left stick.

Usage, from the repo root:

    .venv/bin/python core/scripts/pad_smoke_test.py                       # real pad, until Ctrl+C
    .venv/bin/python core/scripts/pad_smoke_test.py --backend fake --loops 1 --delay 0

The pad is created as player 2 (the Deck's built-in controls are player 1). On exit,
normal or Ctrl+C, it is set neutral and destroyed so no button stays held.

Hardware check (build step 0), on the Deck, from the repo root in Desktop Mode:
  1. Quick check in the terminal (sudo until core/scripts/setup.sh exists; it's a later ticket):
       sudo .venv/bin/python core/scripts/pad_smoke_test.py
     In a second terminal, `cat /proc/bus/input/devices` lists "Microsoft X-Box 360 pad", and
     `sudo .venv/bin/python -m evdev.evtest` (pick that device) shows BTN_SOUTH and ABS_X changing.
     SteamOS may not ship the `evtest` command; the evdev one comes with the venv. Ctrl+C to stop.
  2. Game check. Switching to Gaming Mode closes the desktop terminal and would kill a script
     started there, so run it as a transient systemd service instead:
       sudo systemd-run --unit=pad-smoke "$PWD/.venv/bin/python" "$PWD/core/scripts/pad_smoke_test.py"
     Switch to Gaming Mode and start Overcooked: it lists the pad as player 2. The pad presses A by
     itself about every 1.2 s, so it will click around Steam's menus; that is expected (and its A
     press is what joins player 2). Stop it with `sudo systemctl stop pad-smoke`; the kernel removes
     the pad when the process ends.
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # find phonepad without PYTHONPATH (sudo drops it)

from phonepad.backends.fake import FakeBackend  # noqa: E402
from phonepad.backends.uinput import UinputBackend, UinputError  # noqa: E402

PLAYER = 2
BACKENDS = {"uinput": UinputBackend, "fake": FakeBackend}

# One loop: each step is emitted then synced.
LOOP = [
    [("EV_KEY", "BTN_SOUTH", 1)],
    [("EV_KEY", "BTN_SOUTH", 0)],
    [("EV_ABS", "ABS_X", -32768)],
    [("EV_ABS", "ABS_X", 0)],
    [("EV_ABS", "ABS_X", 32767)],
    [("EV_ABS", "ABS_X", 0)],
]
NEUTRAL = [("EV_KEY", "BTN_SOUTH", 0), ("EV_ABS", "ABS_X", 0)]


def run(backend, loops=None, sleep=time.sleep, delay=0.2):
    """Create player 2's pad on ``backend`` and play ``LOOP`` ``loops`` times (None = forever).

    ``sleep(delay)`` runs after each step. The pad is always neutralized and closed on exit.
    """
    backend.create_pad(PLAYER)
    try:
        n = 0
        while loops is None or n < loops:
            for step in LOOP:
                backend.emit(PLAYER, step)
                backend.sync(PLAYER)
                sleep(delay)
            n += 1
    finally:
        backend.emit(PLAYER, NEUTRAL)
        backend.sync(PLAYER)
        backend.close()


def main(argv=None):
    """CLI entry point; returns the process exit code."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--backend", choices=BACKENDS, default="uinput")
    p.add_argument("--loops", type=int, default=None, help="loops to run (default: until Ctrl+C)")
    p.add_argument("--delay", type=float, default=0.2, help="seconds between steps")
    args = p.parse_args(argv)

    backend = BACKENDS[args.backend]()
    try:
        run(backend, args.loops, delay=args.delay)
    except UinputError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        pass
    if args.backend == "fake":
        for event in backend.events[PLAYER]:
            print(event)
    return 0


if __name__ == "__main__":
    sys.exit(main())
