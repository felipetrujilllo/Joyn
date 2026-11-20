"""Tests for the virtual pad backends (issue #2). No evdev or hardware needed."""

import sys
import types

import pytest

from phonepad.backends import uinput
from phonepad.backends.fake import FakeBackend
from phonepad.backends.uinput import UinputBackend, UinputError, xbox360_capabilities
from phonepad.pads import InputBackend


# --- InputBackend + FakeBackend ---

def test_backends_implement_input_backend():
    assert issubclass(FakeBackend, InputBackend)
    assert issubclass(UinputBackend, InputBackend)
    with pytest.raises(TypeError):
        InputBackend()


def test_fake_backend_records_every_event_per_player_in_order():
    fake = FakeBackend()
    fake.create_pad(2)
    fake.create_pad(3)
    fake.emit(2, [("EV_KEY", "BTN_SOUTH", 1), ("EV_ABS", "ABS_X", -32768)])
    fake.sync(2)
    fake.emit(3, [("EV_ABS", "ABS_HAT0Y", -1)])
    fake.emit(2, [("EV_KEY", "BTN_SOUTH", 0)])
    fake.sync(2)
    fake.sync(3)
    assert fake.pads == [2, 3]
    assert fake.events[2] == [
        ("EV_KEY", "BTN_SOUTH", 1), ("EV_ABS", "ABS_X", -32768),
        ("EV_SYN", "SYN_REPORT", 0),
        ("EV_KEY", "BTN_SOUTH", 0),
        ("EV_SYN", "SYN_REPORT", 0),
    ]
    assert fake.events[3] == [("EV_ABS", "ABS_HAT0Y", -1), ("EV_SYN", "SYN_REPORT", 0)]


def test_fake_backend_destroy_and_close():
    fake = FakeBackend()
    fake.create_pad(2)
    fake.emit(2, [("EV_KEY", "BTN_EAST", 1)])
    with pytest.raises(ValueError):
        fake.create_pad(2)
    fake.destroy(2)
    assert fake.pads == []
    assert fake.events[2] == [("EV_KEY", "BTN_EAST", 1)]
    with pytest.raises(KeyError):
        fake.emit(2, [("EV_KEY", "BTN_EAST", 0)])
    fake.create_pad(3)
    fake.create_pad(4)
    fake.close()
    assert fake.pads == []


# --- UinputBackend capabilities ---

def test_xbox360_identity():
    caps = xbox360_capabilities()
    assert caps["name"] == "Microsoft X-Box 360 pad"
    assert caps["bustype"] == "BUS_USB"
    assert caps["vendor"] == 0x045E
    assert caps["product"] == 0x028E
    assert caps["version"] == 0x0110


def test_xbox360_codes_and_ranges_match_virtual_pad_table():
    caps = xbox360_capabilities()
    assert sorted(caps["keys"]) == sorted([
        "BTN_SOUTH", "BTN_EAST", "BTN_NORTH", "BTN_WEST",  # A B X Y
        "BTN_TL", "BTN_TR",                                # LB RB
        "BTN_SELECT", "BTN_START", "BTN_MODE",             # Back Start Guide
        "BTN_THUMBL", "BTN_THUMBR",                        # L3 R3
    ])
    stick = (-32768, 32767)
    assert caps["abs"] == {
        "ABS_X": stick, "ABS_Y": stick, "ABS_RX": stick, "ABS_RY": stick,
        "ABS_Z": (0, 255), "ABS_RZ": (0, 255),
        "ABS_HAT0X": (-1, 1), "ABS_HAT0Y": (-1, 1),
    }


class RecordingDevice:
    def __init__(self, caps):
        self.caps = caps
        self.written = []
        self.closed = False

    def write(self, type_, code, value):
        self.written.append((type_, code, value))

    def syn(self):
        self.written.append("syn")

    def close(self):
        self.closed = True


def test_uinput_backend_opens_device_from_capabilities_and_writes(monkeypatch):
    stub_ecodes = types.ModuleType("evdev.ecodes")
    stub_ecodes.ecodes = {"EV_KEY": 1, "BTN_SOUTH": 304, "EV_ABS": 3, "ABS_X": 0}
    stub = types.ModuleType("evdev")
    stub.ecodes = stub_ecodes
    monkeypatch.setitem(sys.modules, "evdev", stub)
    monkeypatch.setitem(sys.modules, "evdev.ecodes", stub_ecodes)

    devices = []
    backend = UinputBackend(open_device=lambda caps: devices.append(RecordingDevice(caps)) or devices[-1])
    backend.create_pad(2)
    backend.emit(2, [("EV_KEY", "BTN_SOUTH", 1), ("EV_ABS", "ABS_X", -5)])
    backend.sync(2)
    (device,) = devices
    assert device.caps == xbox360_capabilities()
    assert device.written == [(1, 304, 1), (3, 0, -5), "syn"]
    backend.close()
    assert device.closed


# --- /dev/uinput not writable ---

def assert_clear_message(error):
    message = str(error)
    assert "/dev/uinput" in message
    assert "scripts/setup.sh" in message
    assert "udev rule" in message
    assert "sudo" in message


def test_permission_error_from_device_gives_clear_message():
    def denied(caps):
        raise PermissionError(13, "Permission denied", "/dev/uinput")

    with pytest.raises(UinputError) as info:
        UinputBackend(open_device=denied).create_pad(2)
    assert_clear_message(info.value)


def test_default_opener_checks_dev_uinput_is_writable(monkeypatch):
    checked = []
    monkeypatch.setattr(uinput.os, "access", lambda path, mode: checked.append(path) or False)
    with pytest.raises(UinputError) as info:
        UinputBackend().create_pad(2)
    assert checked == ["/dev/uinput"]
    assert_clear_message(info.value)
