"""Tests for the phone protocol (issue #4)."""

import json
import re
from pathlib import Path

import pytest

from phonepad import protocol
from phonepad.protocol import Hello, SeqTracker, Snapshot, parse

BUTTONS_JS = Path(__file__).resolve().parents[1] / "phonepad" / "web" / "buttons.js"


def s(**fields):
    """Build a raw snapshot message."""
    return json.dumps({"t": "s", "q": 1, **fields})


# Button bit order: single source of truth

def test_button_bit_order():
    assert protocol.BUTTONS == (
        "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "Guide",
        "L3", "R3", "Up", "Down", "Left", "Right",
    )
    assert protocol.bit("A") == 1
    assert protocol.bit("Guide") == 1 << 10
    assert protocol.bit("Right") == 1 << 16
    with pytest.raises(ValueError):
        protocol.bit("Z")


def test_buttons_js_matches_protocol():
    body = re.search(r"BUTTONS\s*=\s*Object\.freeze\(\[(.*?)\]\)", BUTTONS_JS.read_text(), re.S)
    assert tuple(re.findall(r'"([^"]+)"', body.group(1))) == protocol.BUTTONS


# Parsing hello and s

def test_parses_hello():
    assert parse('{"t":"hello","id":"abc","k":"tok","name":"Ana"}') == Hello("abc", "tok", "Ana")


def test_hello_name_optional_and_capped():
    assert parse('{"t":"hello","id":"abc","k":"tok"}') == Hello("abc", "tok", "")
    long = parse(json.dumps({"t": "hello", "id": "a", "k": "t", "name": "n" * 100}))
    assert long.name == "n" * protocol.MAX_NAME_LEN


@pytest.mark.parametrize("msg", [
    {"t": "hello", "k": "tok"},
    {"t": "hello", "id": "", "k": "tok"},
    {"t": "hello", "id": 5, "k": "tok"},
    {"t": "hello", "id": "abc"},
    {"t": "hello", "id": "abc", "k": None},
    {"t": "hello", "id": "abc", "k": "tok", "name": 7},
])
def test_hello_rejects_missing_or_wrong_typed_fields(msg):
    assert parse(json.dumps(msg)) is None


def test_parses_snapshot():
    raw = '{"t":"s","q":7,"b":5,"lx":-100,"ly":200,"rx":0,"ry":32767}'
    assert parse(raw) == Snapshot(7, 5, -100, 200, 0, 32767)


def test_parses_bytes():
    assert parse(b'{"t":"s","q":3}') == Snapshot(3, 0, 0, 0, 0, 0)


def test_snapshot_missing_buttons_and_axes_default_to_neutral():
    assert parse('{"t":"s","q":2}') == Snapshot(2, 0, 0, 0, 0, 0)


@pytest.mark.parametrize("fields", [
    {"q": None}, {"q": -1}, {"q": 1.0}, {"q": True}, {"q": "1"},
    {"b": -1}, {"b": True}, {"b": 1.5},
    {"lx": "0"}, {"ly": 1.0}, {"rx": False}, {"ry": None},
])
def test_snapshot_rejects_wrong_typed_or_negative_fields(fields):
    assert parse(s(**fields)) is None


def test_snapshot_requires_q():
    assert parse('{"t":"s","b":1}') is None


def test_unknown_type_rejected():
    assert parse('{"t":"ping","ts":1}') is None
    assert parse('{"t":"nope"}') is None
    assert parse('{"q":1}') is None


# Validation rules

def test_unknown_fields_ignored():
    assert parse(s(b=1, extra={"x": [1, 2]}, foo="bar")) == Snapshot(1, 1, 0, 0, 0, 0)
    assert parse('{"t":"hello","id":"a","k":"t","zzz":1}') == Hello("a", "t", "")


def test_axes_clamped():
    snap = parse(s(lx=40000, ly=-40000, rx=-32768, ry=10 ** 30))
    assert (snap.lx, snap.ly, snap.rx, snap.ry) == (32767, -32767, -32767, 32767)


def test_unknown_bits_masked_off():
    assert parse(s(b=(1 << 17) | (1 << 30) | 0b101)).b == 0b101
    assert parse(s(b=protocol.BUTTON_MASK)).b == (1 << 17) - 1


def test_messages_over_1kb_rejected():
    pad = lambda n: s(pad="x" * n)  # noqa: E731
    base = len(pad(0))
    assert parse(pad(1024 - base)) is not None  # exactly 1024 bytes
    assert parse(pad(1025 - base)) is None
    # Measured on UTF-8 bytes, not characters: 510 x "é" is 1020 bytes but only 510 chars.
    multibyte = '{"t":"s","q":1,"p":"' + "é" * 510 + '"}'
    assert len(multibyte) < 1024 < len(multibyte.encode())
    assert parse(multibyte) is None
    assert parse(multibyte.encode()) is None


@pytest.mark.parametrize("raw", [
    "", "{", "not json", '{"t":"s",}', "[1,2]", '"s"', "null", "42",
    b"\xff\xfe\x00", '{"t":"s","q":NaN}', '{"t":"s","q":1,"lx":Infinity}',
    '{"t":"s","q":1e400}', "[" * 512 + "]" * 512, None, 123, object(),
])
def test_malformed_input_rejected_without_raising(raw):
    assert parse(raw) is None


# Sequence tracking

def test_seq_tracker_drops_not_newer():
    seq = SeqTracker()
    assert seq.accept(0)
    assert seq.accept(5)
    assert not seq.accept(5)  # duplicate
    assert not seq.accept(3)  # reordered
    assert seq.accept(6)
    assert SeqTracker().accept(0)  # a fresh connection starts empty
