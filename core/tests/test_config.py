"""Tests for phonepad.config, using real files under tmp_path."""

import json
import stat

import pytest

from phonepad import config


def test_default_path_is_under_home_config():
    assert config.DEFAULT_PATH.parts[-3:] == (".config", "phonepad", "config.json")


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
