"""Pad layer: the InputBackend interface and the PadManager that drives it.

Events are ``(type, code, value)`` tuples using evdev code *names*, e.g.
``("EV_KEY", "BTN_SOUTH", 1)`` or ``("EV_ABS", "ABS_X", -32768)``, so callers
never depend on evdev itself.
"""

from abc import ABC, abstractmethod

from phonepad.protocol import bit


class InputBackend(ABC):
    """Creates one virtual Xbox 360 pad per player and feeds it events."""

    @abstractmethod
    def create_pad(self, player):
        """Create the virtual pad for ``player`` (an int slot number)."""

    @abstractmethod
    def emit(self, player, events):
        """Write ``events`` (iterable of ``(type, code, value)``) to ``player``'s pad."""

    @abstractmethod
    def sync(self, player):
        """Emit ``SYN_REPORT`` on ``player``'s pad so the events above take effect."""

    @abstractmethod
    def destroy(self, player):
        """Remove ``player``'s pad."""

    @abstractmethod
    def close(self):
        """Destroy every pad this backend created."""


# Button name -> evdev key, per the CLAUDE.local.md "Virtual pad" table.
_KEYS = tuple((bit(name), code) for name, code in (
    ("A", "BTN_SOUTH"), ("B", "BTN_EAST"), ("X", "BTN_NORTH"), ("Y", "BTN_WEST"),
    ("LB", "BTN_TL"), ("RB", "BTN_TR"),
    ("Back", "BTN_SELECT"), ("Start", "BTN_START"), ("Guide", "BTN_MODE"),
    ("L3", "BTN_THUMBL"), ("R3", "BTN_THUMBR"),
))
_LT, _RT = bit("LT"), bit("RT")
_UP, _DOWN, _LEFT, _RIGHT = bit("Up"), bit("Down"), bit("Left"), bit("Right")


def _events(b, lx, ly, rx, ry):
    """Full pad state as evdev events; opposite D-pad directions cancel to 0."""
    events = [("EV_KEY", code, 1 if b & mask else 0) for mask, code in _KEYS]
    events += [
        ("EV_ABS", "ABS_Z", 255 if b & _LT else 0),
        ("EV_ABS", "ABS_RZ", 255 if b & _RT else 0),
        ("EV_ABS", "ABS_HAT0X", bool(b & _RIGHT) - bool(b & _LEFT)),
        ("EV_ABS", "ABS_HAT0Y", bool(b & _DOWN) - bool(b & _UP)),
        ("EV_ABS", "ABS_X", lx), ("EV_ABS", "ABS_Y", ly),
        ("EV_ABS", "ABS_RX", rx), ("EV_ABS", "ABS_RY", ry),
    ]
    return events


_NEUTRAL = _events(0, 0, 0, 0, 0)


class PadManager:
    """Owns the players' pads on an InputBackend and turns snapshots into events.

    Every ``apply`` writes the complete state then one ``SYN_REPORT``; the
    kernel drops unchanged values, and a lost snapshot can't leave a button stuck.
    """

    def __init__(self, backend):
        self.backend = backend
        self.players = []

    def add(self, player):
        """Create ``player``'s pad on the backend."""
        self.backend.create_pad(player)
        self.players.append(player)

    def apply(self, player, snapshot):
        """Write a validated ``protocol.Snapshot`` to ``player``'s pad (one SYN)."""
        s = snapshot
        self.backend.emit(player, _events(s.b, s.lx, s.ly, s.rx, s.ry))
        self.backend.sync(player)

    def neutral(self, player):
        """Center sticks and release every button and trigger on ``player``'s pad (one SYN)."""
        self.backend.emit(player, _NEUTRAL)
        self.backend.sync(player)

    def remove(self, player):
        """Neutralize, then destroy ``player``'s pad."""
        self.neutral(player)
        self.backend.destroy(player)
        self.players.remove(player)

    def close(self):
        """Neutralize, then destroy every pad (server shutdown)."""
        for player in list(self.players):
            self.remove(player)
