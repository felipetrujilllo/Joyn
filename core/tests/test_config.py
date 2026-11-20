"""Tests for phonepad.config, using real files under tmp_path."""

import json
import stat

import pytest

from phonepad import config


def test_default_path_is_under_home_config():
    assert config.DEFAULT_PATH.parts[-3:] == (".config", "phonepad", "config.json")


def sudo_env(monkeypatch, tmp_path):
    """Pretend we run as root via sudo from user 'deck' whose home is tmp_path/deck."""
    home = tmp_path / "deck"
    home.mkdir()
    monkeypatch.setattr(config.os, "geteuid", lambda: 0)
    monkeypatch.setenv("SUDO_USER", "deck")
    monkeypatch.setenv("SUDO_UID", "1000")
    monkeypatch.setenv("SUDO_GID", "1001")
    real = config.os.path.expanduser
    monkeypatch.setattr(config.os.path, "expanduser", lambda p: str(home) if p == "~deck" else real(p))
    return home


def test_under_sudo_the_default_path_is_the_real_users(monkeypatch, tmp_path):
    home = sudo_env(monkeypatch, tmp_path)
    assert config.default_path() == home / ".config" / "phonepad" / "config.json"
    monkeypatch.setattr(config.os, "geteuid", lambda: 1000)  # not root: ignore SUDO_* leftovers
    assert config.default_path() == config.Path.home() / ".config" / "phonepad" / "config.json"


def test_under_sudo_the_saved_file_and_new_folder_belong_to_the_real_user(monkeypatch, tmp_path):
    home = sudo_env(monkeypatch, tmp_path)
    chowned = []
    monkeypatch.setattr(config.os, "chown", lambda p, u, g: chowned.append((p, u, g)))
    monkeypatch.setattr(config.os, "fchown", lambda fd, u, g: chowned.append(("fd", u, g)))
    path = home / ".config" / "phonepad" / "config.json"
    cfg = config.load(path)
    assert path.exists() and cfg["token"]
    assert (str(path.parent), 1000, 1001) in chowned  # the folder it created
    assert ("fd", 1000, 1001) in chowned  # the file itself


def test_first_run_creates_file_with_token_and_default_port(tmp_path):
    path = tmp_path / "nested" / "phonepad" / "config.json"
    cfg = config.load(path)
    assert path.exists()
    assert cfg["port"] == 8642
    assert json.loads(path.read_text()) == cfg
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_token_has_at_least_128_bits_and_is_url_safe(tmp_path):
    token = config.load(tmp_path / "config.json")["token"]
    # token_urlsafe(16) -> 22 base64url chars = 132 bits >= 128
    assert len(token) >= 22
    assert set(token) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    assert config.load(tmp_path / "other.json")["token"] != token


def test_second_load_returns_same_token(tmp_path):
    path = tmp_path / "config.json"
    first = config.load(path)
    assert config.load(path)["token"] == first["token"]


def test_save_round_trips_and_keeps_unknown_keys(tmp_path):
    path = tmp_path / "config.json"
    cfg = config.load(path)
    cfg["ssid"] = "phonepad"
    cfg["port"] = 9000
    config.save(cfg, path)
    assert config.load(path) == cfg
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert [p.name for p in tmp_path.iterdir()] == ["config.json"]  # no temp files left


def test_missing_port_falls_back_to_default(tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"token": "abc"}')
    assert config.load(path) == {"token": "abc", "port": 8642}


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        "[1, 2]",
        "{}",
        '{"token": ""}',
        '{"token": 123}',
        '{"token": "abc", "port": "8642"}',
        '{"token": "abc", "port": true}',
    ],
)
def test_corrupt_file_raises_clear_error_and_is_untouched(tmp_path, content):
    path = tmp_path / "config.json"
    path.write_text(content)
    with pytest.raises(config.ConfigError) as exc:
        config.load(path)
    assert str(path) in str(exc.value)
    assert "delete" in str(exc.value)
    assert path.read_text() == content
