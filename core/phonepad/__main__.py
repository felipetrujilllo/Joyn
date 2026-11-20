"""Entry point for `python -m phonepad`: start the server and print the controller URL + QR."""

import argparse
import errno
import os
import sys

from aiohttp import web

from phonepad import __version__, config as configfile, qr
from phonepad.backends import uinput
from phonepad.backends.fake import FakeBackend
from phonepad.pads import PadManager
from phonepad.server import create_app


class StartupError(Exception):
    """phonepad can't start; the message says why and how to fix it."""


def parse_args(argv=None):
    """Parse the command line."""
    p = argparse.ArgumentParser(prog="python -m phonepad", description=__doc__)
    p.add_argument("--version", action="store_true", help="print the version and exit")
    p.add_argument("--backend", choices=("uinput", "fake"), default="uinput",
                   help="uinput: real pads (Linux); fake: no pads, for trying the page anywhere")
    p.add_argument("--ip", help="address to put in the controller URL (default: auto-detect)")
    p.add_argument("--config", default=str(configfile.DEFAULT_PATH), help="config file path")
    return p.parse_args(argv)


def _uinput_help():
    """The /dev/uinput message, with a command that works as typed (sudo drops PYTHONPATH,
    so run from core/ where ``-m`` finds the package)."""
    core = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return (
        "Cannot write to {path}, so no controller can be created.\n"
        "For now, start phonepad with sudo:\n"
        "  cd {core} && sudo {python} -m phonepad\n"
        "(It still uses your own config and token. A one-time setup that removes the need\n"
        "for sudo comes in a later ticket.)"
    ).format(path=uinput.UINPUT_PATH, core=core, python=sys.executable)


def prepare(args):
    """Return ``(app, port, banner)`` ready to run; raises ``StartupError`` if it can't start."""
    try:
        config = configfile.load(args.config)
    except configfile.ConfigError as e:
        raise StartupError(str(e))
    except OSError as e:  # e.g. a read-only or unwritable folder
        raise StartupError("Cannot read or write the config file {}: {}".format(args.config, e))
    if args.backend == "uinput":
        # UinputBackend opens the device only when the first phone joins; fail now instead
        if not os.access(uinput.UINPUT_PATH, os.W_OK):
            raise StartupError(_uinput_help())
        backend = uinput.UinputBackend()
    else:
        backend = FakeBackend()
    app = create_app(config, PadManager(backend))
    ip, warning = qr.lan_ip(args.ip)
    url = qr.controller_url(ip, config["port"], config["token"])
    lines = [warning] if warning else []
    lines += ["Scan with your phone, or open:", url, qr.ascii_qr(url),
              "Backend: {}. Press Ctrl+C to stop.".format(args.backend)]
    return app, config["port"], "\n".join(lines)


def main(argv=None, run_app=web.run_app):
    """Run phonepad; return the exit code. ``run_app`` is injectable for tests."""
    args = parse_args(argv)
    if args.version:
        print(f"phonepad {__version__}")
        return 0
    try:
        app, port, banner = prepare(args)
    except StartupError as e:
        print(e, file=sys.stderr)
        return 1
    print(banner, flush=True)
    try:
        run_app(app, host="0.0.0.0", port=port, print=None)  # cleanup -> pads.close()
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        print("Port {} is already in use (is phonepad already running?). "
              "Stop the other program or change \"port\" in {}.".format(port, args.config),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
