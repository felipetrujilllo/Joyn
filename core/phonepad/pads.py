"""Pad layer: the InputBackend interface every virtual-pad backend implements.

Events are ``(type, code, value)`` tuples using evdev code *names*, e.g.
``("EV_KEY", "BTN_SOUTH", 1)`` or ``("EV_ABS", "ABS_X", -32768)``, so callers
never depend on evdev itself.
"""

from abc import ABC, abstractmethod


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
