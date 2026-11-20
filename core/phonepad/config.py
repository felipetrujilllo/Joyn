"""Load and save the phonepad config file (``~/.config/phonepad/config.json``).

The config is a plain dict. Keys this module knows about:

- ``token`` (str, required): the secret in the controller URL (``?k=``). Generated
  once on first run and kept across restarts so Home Screen icons keep working.
- ``port`` (int, optional): the HTTP port. Defaults to ``DEFAULT_PORT`` when missing.

Unknown keys are kept on load and save, so later features can add fields.
"""

import json
import os
import secrets
import tempfile
from pathlib import Path

def _sudo_owner():
    """Return ``(uid, gid, home)`` of the user who ran ``sudo``, or None when not under sudo."""
    try:
        if os.geteuid() != 0 or "SUDO_USER" not in os.environ:
            return None
        return (int(os.environ["SUDO_UID"]), int(os.environ["SUDO_GID"]),
                Path(os.path.expanduser("~" + os.environ["SUDO_USER"])))
    except (KeyError, ValueError):
        return None


def default_path():
    """``~/.config/phonepad/config.json`` of the real user, also under ``sudo`` (same token)."""
    owner = _sudo_owner()
    home = owner[2] if owner else Path.home()
    return home / ".config" / "phonepad" / "config.json"


DEFAULT_PATH = default_path()
DEFAULT_PORT = 8642
TOKEN_BYTES = 16  # 128 bits of randomness


class ConfigError(Exception):
    """The config file exists but can't be used as-is."""


def load(path=DEFAULT_PATH):
    """Return the config dict from ``path``, creating it with defaults on first run.

    First run (file missing): writes a new random token and the default port.
    A missing ``port`` falls back to ``DEFAULT_PORT``. Invalid JSON, a non-object,
    a missing/empty/non-string token or a non-integer port raises ``ConfigError``;
    the file is never overwritten or regenerated in that case.
    """
    path = Path(path)
    if not path.exists():
        config = {"token": secrets.token_urlsafe(TOKEN_BYTES), "port": DEFAULT_PORT}
        save(config, path)
        return config

    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:  # covers bad JSON and bad UTF-8
        raise _corrupt(path, "it is not valid JSON ({})".format(e))
    if not isinstance(config, dict):
        raise _corrupt(path, "it is not a JSON object")
    token = config.get("token")
    if not isinstance(token, str) or not token:
        raise _corrupt(path, '"token" is missing or not a non-empty string')
    port = config.setdefault("port", DEFAULT_PORT)
    if not isinstance(port, int) or isinstance(port, bool):
        raise _corrupt(path, '"port" is not an integer')
    return config


def save(config, path=DEFAULT_PATH):
    """Write ``config`` to ``path`` atomically, readable only by the user (0600).

    Parent folders are created. A temp file in the same folder is written and
    then renamed over ``path``, so a crash never leaves a half-written file.
    """
    path = Path(path)
    created = not path.parent.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = _sudo_owner()
    if owner and created:
        os.chown(str(path.parent), owner[0], owner[1])  # so later runs without sudo can use it
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)  # mkstemp already uses 0600; be explicit, it holds secrets
        if owner:
            os.fchown(fd, owner[0], owner[1])  # the real user's file, not root's
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(path))
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _corrupt(path, reason):
    return ConfigError(
        "Config file {} is invalid: {}. Fix the file, or delete it to create a new one "
        "(a new token means old QR codes and Home Screen icons stop working).".format(path, reason)
    )
