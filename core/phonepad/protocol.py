"""Phone -> Deck protocol: parse, validate and clamp messages (the trust boundary).

Runs on the data-plane hot path (up to 60 msgs/s per phone), so it is plain
``json.loads`` plus a few type checks. ``parse`` never raises.

Reject vs default rules:

- Messages over ``MAX_MESSAGE_BYTES`` (UTF-8), invalid UTF-8, malformed JSON,
  non-object JSON and unknown ``t`` values are rejected (``None``).
- Unknown fields are ignored.
- A field that is present but has the wrong type is rejected. ``bool`` is never
  accepted as an int, and floats (including NaN/Infinity) are never ints.
- ``s``: ``q`` is required and must be a non-negative int. ``b`` and the axes
  default to 0 (released / centered) when absent. Axes are clamped to
  ``-AXIS_MAX..AXIS_MAX``. ``b`` must be non-negative (a negative bitmask would
  press every button), and bits beyond the 17 defined buttons are masked off.
- ``hello``: ``id`` must be a non-empty string and ``k`` a string. ``name`` is
  optional (default ``""``), must be a string if present, and is truncated to
  ``MAX_NAME_LEN`` characters.
"""

import json
from typing import NamedTuple

# Bit order of the ``b`` bitmask. Single source of truth; web/buttons.js mirrors it.
BUTTONS = (
    "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "Guide",
    "L3", "R3", "Up", "Down", "Left", "Right",
)
BUTTON_MASK = (1 << len(BUTTONS)) - 1
AXIS_MAX = 32767
MAX_MESSAGE_BYTES = 1024
MAX_NAME_LEN = 32
_AXES = ("lx", "ly", "rx", "ry")


def bit(name):
    """Return the bitmask value of button ``name``; raises ``ValueError`` if unknown."""
    return 1 << BUTTONS.index(name)


class Hello(NamedTuple):
    """A validated ``hello``: phone ``id``, join ``token`` (``k``) and nickname ``name``."""

    id: str
    token: str
    name: str


class Snapshot(NamedTuple):
    """A validated ``s`` snapshot: sequence ``q``, masked buttons ``b``, clamped axes."""

    q: int
    b: int
    lx: int
    ly: int
    rx: int
    ry: int


def _int(msg, key, default=None):
    """Return ``msg[key]`` if it is a real int (not bool), ``default`` if absent, else None."""
    v = msg.get(key, default)
    return v if type(v) is int else None


def parse(raw):
    """Parse one raw message (``str`` or ``bytes``) into ``Hello`` / ``Snapshot``.

    Returns ``None`` when the message is rejected; never raises for any input.
    """
    try:
        data = raw.encode("utf-8") if isinstance(raw, str) else raw
        if len(data) > MAX_MESSAGE_BYTES:
            return None
        msg = json.loads(data)
    except (TypeError, ValueError, AttributeError, RecursionError):
        return None
    if type(msg) is not dict:
        return None
    t = msg.get("t")
    if t == "s":
        return _snapshot(msg)
    if t == "hello":
        return _hello(msg)
    return None


def _snapshot(msg):
    q = _int(msg, "q")
    b = _int(msg, "b", 0)
    if q is None or q < 0 or b is None or b < 0:
        return None
    axes = []
    for key in _AXES:
        v = _int(msg, key, 0)
        if v is None:
            return None
        axes.append(AXIS_MAX if v > AXIS_MAX else -AXIS_MAX if v < -AXIS_MAX else v)
    return Snapshot(q, b & BUTTON_MASK, *axes)


def _hello(msg):
    pid, token, name = msg.get("id"), msg.get("k"), msg.get("name", "")
    if type(pid) is not str or not pid or type(token) is not str or type(name) is not str:
        return None
    return Hello(pid, token, name[:MAX_NAME_LEN])


class SeqTracker:
    """Per-connection tracker that drops snapshots whose ``q`` is not newer than the last applied."""

    def __init__(self):
        self.last = -1

    def accept(self, q):
        """Return True and record ``q`` if it is newer than the last accepted one, else False."""
        if q <= self.last:
            return False
        self.last = q
        return True
