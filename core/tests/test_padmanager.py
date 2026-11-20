"""Tests for PadManager (issue #5): snapshot -> evdev events, using FakeBackend."""

import pytest

from phonepad.backends.fake import SYN, FakeBackend
from phonepad.backends.uinput import xbox360_capabilities
from phonepad.pads import PadManager
from phonepad.protocol import BUTTONS, Snapshot, bit

P = 2
KEYS = {
    "A": "BTN_SOUTH", "B": "BTN_EAST", "X": "BTN_NORTH", "Y": "BTN_WEST",
    "LB": "BTN_TL", "RB": "BTN_TR",
    "Back": "BTN_SELECT", "Start": "BTN_START", "Guide": "BTN_MODE",
    "L3": "BTN_THUMBL", "R3": "BTN_THUMBR",
}
NEUTRAL_ABS = {
    "ABS_X": 0, "ABS_Y": 0, "ABS_RX": 0, "ABS_RY": 0,
    "ABS_Z": 0, "ABS_RZ": 0, "ABS_HAT0X": 0, "ABS_HAT0Y": 0,
}


def snap(*names, lx=0, ly=0, rx=0, ry=0):
    b = 0
    for name in names:
        b |= bit(name)
    return Snapshot(1, b, lx, ly, rx, ry)


@pytest.fixture
def pm():
    pm = PadManager(FakeBackend())
    pm.add(P)
    return pm


def applied(pm, snapshot):
    """Apply ``snapshot``; check exactly one SYN, last; return (keys, abs) state dicts."""
    start = len(pm.backend.events[P])
    pm.apply(P, snapshot)
    events = pm.backend.events[P][start:]
    return state(events)


def state(events):
    assert events.count(SYN) == 1 and events[-1] == SYN
    keys = {c: v for t, c, v in events if t == "EV_KEY"}
    abs_ = {c: v for t, c, v in events if t == "EV_ABS"}
    return keys, abs_


def test_key_table_covers_every_non_trigger_non_dpad_button():
    assert set(KEYS) == set(BUTTONS) - {"LT", "RT", "Up", "Down", "Left", "Right"}


@pytest.mark.parametrize("name", sorted(KEYS))
def test_each_button_alone_presses_only_its_key(pm, name):
    keys, abs_ = applied(pm, snap(name))
    assert keys == {code: int(code == KEYS[name]) for code in KEYS.values()}
    assert abs_ == NEUTRAL_ABS


@pytest.mark.parametrize("name,code", [("LT", "ABS_Z"), ("RT", "ABS_RZ")])
def test_triggers_are_0_or_255(pm, name, code):
    keys, abs_ = applied(pm, snap(name))
    assert abs_ == dict(NEUTRAL_ABS, **{code: 255})
    assert set(keys.values()) == {0}
    _, abs_ = applied(pm, snap())
    assert abs_[code] == 0


@pytest.mark.parametrize("names,hx,hy", [
    (("Up",), 0, -1), (("Down",), 0, 1), (("Left",), -1, 0), (("Right",), 1, 0),
    (("Up", "Right"), 1, -1), (("Down", "Left"), -1, 1),
    (("Up", "Down"), 0, 0), (("Left", "Right"), 0, 0),
    (("Up", "Down", "Left", "Right"), 0, 0), (("Up", "Down", "Right"), 1, 0),
])
def test_dpad_to_hat(pm, names, hx, hy):
    keys, abs_ = applied(pm, snap(*names))
    assert abs_ == dict(NEUTRAL_ABS, ABS_HAT0X=hx, ABS_HAT0Y=hy)
    assert set(keys.values()) == {0}


@pytest.mark.parametrize("lx,ly,rx,ry", [
    (32767, -32767, -32767, 32767), (-32767, 32767, 32767, -32767),
    (123, -4567, -8, 30000), (0, -32767, 0, 0),  # full up is negative Y, not inverted
])
def test_sticks_pass_through(pm, lx, ly, rx, ry):
    _, abs_ = applied(pm, snap(lx=lx, ly=ly, rx=rx, ry=ry))
    assert abs_ == dict(NEUTRAL_ABS, ABS_X=lx, ABS_Y=ly, ABS_RX=rx, ABS_RY=ry)


def test_one_syn_per_apply(pm):
    pm.apply(P, snap("A", lx=5))
    pm.apply(P, snap("B", ry=-5))
    events = pm.backend.events[P]
    assert events.count(SYN) == 2 and events[-1] == SYN
    first = events[:events.index(SYN) + 1]
    assert ("EV_KEY", "BTN_SOUTH", 1) in first and ("EV_ABS", "ABS_X", 5) in first


def test_neutral_releases_everything(pm):
    pm.apply(P, snap(*BUTTONS, lx=100, ly=-100, rx=32767, ry=-32767))
    start = len(pm.backend.events[P])
    pm.neutral(P)
    keys, abs_ = state(pm.backend.events[P][start:])
    assert keys == {code: 0 for code in KEYS.values()}
    assert abs_ == NEUTRAL_ABS


def test_every_emitted_code_exists_on_the_real_pad(pm):
    caps = xbox360_capabilities()
    pm.apply(P, snap(*BUTTONS, lx=1, ly=1, rx=1, ry=1))
    pm.neutral(P)
    for type_, code, value in pm.backend.events[P]:
        if type_ == "EV_KEY":
            assert code in caps["keys"]
        elif type_ == "EV_ABS":
            lo, hi = caps["abs"][code]
            assert lo <= value <= hi
        else:
            assert (type_, code, value) == SYN
    emitted = {c for t, c, _ in pm.backend.events[P] if t != "EV_SYN"}
    assert emitted == set(caps["keys"]) | set(caps["abs"])


class LoggingFake(FakeBackend):
    """FakeBackend that also logs destroy calls into the event stream, to check ordering."""

    def destroy(self, player):
        super().destroy(player)
        self.events[player].append("destroyed")


def test_add_creates_pad():
    pm = PadManager(FakeBackend())
    pm.add(2)
    pm.add(3)
    assert pm.backend.pads == [2, 3]


def last_report_before_destroy(events):
    """Assert the pad was destroyed right after a report; return that report's state."""
    assert events[-1] == "destroyed" and events[-2] == SYN
    syns = [i for i, e in enumerate(events) if e == SYN]
    start = syns[-2] + 1 if len(syns) > 1 else 0
    return state(events[start:-1])


def test_remove_neutralizes_then_destroys():
    pm = PadManager(LoggingFake())
    pm.add(2)
    pm.add(3)
    pm.apply(2, snap("A", lx=99))
    pm.remove(2)
    keys, abs_ = last_report_before_destroy(pm.backend.events[2])
    assert set(keys.values()) == {0} and abs_ == NEUTRAL_ABS
    assert pm.backend.pads == [3]
    assert pm.backend.events[3] == []


def test_close_neutralizes_then_destroys_every_pad():
    pm = PadManager(LoggingFake())
    for p in (2, 3, 4):
        pm.add(p)
    pm.apply(3, snap("RT", "Up", ry=-32767))
    pm.close()
    assert pm.backend.pads == []
    for p in (2, 3, 4):
        keys, abs_ = last_report_before_destroy(pm.backend.events[p])
        assert set(keys.values()) == {0} and abs_ == NEUTRAL_ABS
