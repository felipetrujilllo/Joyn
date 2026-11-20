"""Tests for startup (issue #8): controller URL, LAN IP, terminal QR, uinput preflight."""

import errno
import json
import os
import sys

from aiohttp import web

from phonepad import __main__ as cli
from phonepad import qr
from phonepad.backends.fake import FakeBackend
from phonepad.pads import PadManager


def test_controller_url_plain():
    assert qr.controller_url("192.168.4.36", 8642, "abc") == "http://192.168.4.36:8642/?k=abc"


def test_controller_url_encodes_token():
    assert qr.controller_url("10.42.0.1", 8642, "a+b/c= &") == "http://10.42.0.1:8642/?k=a%2Bb%2Fc%3D%20%26"


def test_ascii_qr_has_the_4_module_quiet_zone():
    plain = qr.ascii_qr("x")
    qr_obj = qr.qrcode.QRCode(border=0)
    qr_obj.add_data("x")
    qr_obj.make(fit=True)
    inner = len(qr_obj.get_matrix())
    assert len(plain.splitlines()[0]) == inner + 2 * 4  # 4 blank modules on each side


def test_ascii_qr_is_stable_multiline_and_grows_with_data():
    small = qr.ascii_qr("http://10.42.0.1:8642/?k=abc")
    assert small == qr.ascii_qr("http://10.42.0.1:8642/?k=abc")
    rows = small.splitlines()
    assert len(rows) > 10 and len({len(r) for r in rows}) == 1  # a filled rectangle
    assert len(qr.ascii_qr("http://10.42.0.1:8642/?k=" + "x" * 200).splitlines()) > len(rows)


class FakeSocket:
    """A UDP socket stand-in: ``connect`` fails for destinations in ``fail``."""

    def __init__(self, ip, fail=()):
        self.ip, self.fail, self.connected = ip, fail, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def connect(self, addr):
        self.connected.append(addr[0])
        if addr[0].endswith(".255"):  # Linux: UDP connect() to a broadcast address without SO_BROADCAST
            raise OSError(errno.EACCES, "Permission denied")
        if addr[0] in self.fail:
            raise OSError(errno.ENETUNREACH, "Network is unreachable")

    def getsockname(self):
        return (self.ip, 50000)


def test_lan_ip_override_wins():
    def boom():
        raise AssertionError("must not probe")
    assert qr.lan_ip("10.42.0.1", make_socket=boom) == ("10.42.0.1", None)


def test_lan_ip_uses_probed_address():
    assert qr.lan_ip(make_socket=lambda: FakeSocket("192.168.4.36")) == ("192.168.4.36", None)


def test_lan_ip_offline_hotspot_finds_the_deck_address():
    # Deck on its own hotspot: no default route, so the public probe is unreachable, and a
    # broadcast probe would be refused (EACCES) like on Linux. The hotspot probe must still work.
    sock = FakeSocket("10.42.0.1", fail=("8.8.8.8",))
    assert qr.lan_ip(make_socket=lambda: sock) == ("10.42.0.1", None)
    assert sock.connected == list(qr.PROBES)
    assert not any(p.endswith(".255") for p in qr.PROBES)


def test_lan_ip_falls_back_to_localhost_with_warning():
    def unreachable():
        return FakeSocket("0.0.0.0", fail=qr.PROBES)
    ip, warning = qr.lan_ip(make_socket=unreachable)
    assert ip == "127.0.0.1" and "--ip" in warning
    assert qr.lan_ip(make_socket=lambda: FakeSocket("127.0.0.1"))[0] == "127.0.0.1"


def config_file(tmp_path, token="tok+en/1", port=8642):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"token": token, "port": port}))
    return str(path)


def never_run(*args, **kwargs):
    raise AssertionError("the server must not start")


def test_version_flag_starts_nothing(capsys):
    assert cli.main(["--version"], run_app=never_run) == 0
    assert capsys.readouterr().out.strip() == "phonepad 0.0.1"


def test_startup_prints_url_and_qr_and_runs_fake_backend(tmp_path, capsys, monkeypatch):
    calls, built = [], []
    real_create_app = cli.create_app
    monkeypatch.setattr(cli, "create_app", lambda config, pads: built.append(pads) or real_create_app(config, pads))
    argv = ["--backend", "fake", "--ip", "10.42.0.1", "--config", config_file(tmp_path)]
    assert cli.main(argv, run_app=lambda app, **kw: calls.append((app, kw))) == 0
    out = capsys.readouterr().out
    url = "http://10.42.0.1:8642/?k=tok%2Ben%2F1"
    assert url in out.splitlines()
    assert qr.ascii_qr(url) in out
    assert "Ctrl+C" in out
    (app, kw), = calls
    assert kw == {"host": "0.0.0.0", "port": 8642, "print": None}
    (pads,) = built
    assert isinstance(pads, PadManager) and isinstance(pads.backend, FakeBackend)
    assert isinstance(app, web.Application)


def test_uinput_not_writable_prints_fix_and_does_not_start(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(os, "access", lambda path, mode: False)
    assert cli.main(["--config", config_file(tmp_path)], run_app=never_run) == 1
    err = capsys.readouterr().err
    core = os.path.dirname(os.path.dirname(os.path.abspath(cli.__file__)))
    assert "/dev/uinput" in err
    # a command that works as typed: sudo drops PYTHONPATH, so it must run from core/ with the venv python
    assert "cd {} && sudo {} -m phonepad".format(core, sys.executable) in err
    assert "setup.sh" not in err  # doesn't exist yet; don't point people at it
    assert "Traceback" not in err


def test_unwritable_config_folder_prints_message_and_exits_1(tmp_path, capsys):
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("x")
    path = blocker / "config.json"  # its "folder" is a file, so creating it fails with OSError
    assert cli.main(["--backend", "fake", "--config", str(path)], run_app=never_run) == 1
    err = capsys.readouterr().err
    assert "Cannot read or write the config file" in err and str(path) in err
    assert "Traceback" not in err


def test_corrupt_config_prints_message_and_exits_1(tmp_path, capsys):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    assert cli.main(["--backend", "fake", "--config", str(path)], run_app=never_run) == 1
    err = capsys.readouterr().err
    assert str(path) in err and "not valid JSON" in err
    assert path.read_text() == "{not json"


def test_port_in_use_prints_message_and_exits_1(tmp_path, capsys):
    def busy(app, **kw):
        raise OSError(errno.EADDRINUSE, "Address already in use")
    argv = ["--backend", "fake", "--ip", "10.42.0.1", "--config", config_file(tmp_path)]
    assert cli.main(argv, run_app=busy) == 1
    assert "Port 8642 is already in use" in capsys.readouterr().err
