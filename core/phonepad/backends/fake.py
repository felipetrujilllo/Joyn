"""FakeBackend: an in-memory InputBackend that records events, for tests."""

from phonepad.pads import InputBackend

SYN = ("EV_SYN", "SYN_REPORT", 0)


class FakeBackend(InputBackend):
    """Records every emitted event, syncs included, per player in order.

    ``events[player]`` is the list of ``(type, code, value)`` tuples; it is
    kept after ``destroy`` so tests can still inspect it. ``pads`` holds the
    players whose pad currently exists, in creation order.
    """

    def __init__(self):
        self.pads = []
        self.events = {}

    def create_pad(self, player):
        """Create ``player``'s pad; raises ValueError if it already exists."""
        if player in self.pads:
            raise ValueError(f"pad for player {player} already exists")
        self.pads.append(player)
        self.events.setdefault(player, [])

    def emit(self, player, events):
        """Record ``events`` for ``player``; raises KeyError if it has no pad."""
        self._require(player)
        self.events[player].extend(tuple(e) for e in events)

    def sync(self, player):
        """Record a ``SYN_REPORT`` for ``player``."""
        self._require(player)
        self.events[player].append(SYN)

    def destroy(self, player):
        """Remove ``player``'s pad (its recorded events are kept)."""
        self._require(player)
        self.pads.remove(player)

    def close(self):
        """Remove every pad."""
        self.pads.clear()

    def _require(self, player):
        if player not in self.pads:
            raise KeyError(f"no pad for player {player}")
