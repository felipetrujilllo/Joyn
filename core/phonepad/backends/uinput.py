"""UinputBackend: one virtual Xbox 360 pad per player via python-evdev (Linux only).

evdev is imported lazily, only when a device is opened or written, so this
module imports fine on machines without it (macOS dev, tests).
"""

import os

from phonepad.pads import InputBackend

UINPUT_PATH = "/dev/uinput"

FIX_HINT = (
    "Run core/scripts/setup.sh to install the udev rule (re-run it after SteamOS updates), "
    "or use sudo for a first quick test."
)


class UinputError(RuntimeError):
    """The virtual pad could not be created (no access to /dev/uinput, or no evdev)."""


def xbox360_capabilities():
    """Return the wired Xbox 360 pad description using evdev code names.

    Pure data: identity (name, bustype, vendor, product, version), ``keys``
    (button codes) and ``abs`` (axis code -> ``(min, max)``).
    """
    stick = (-32768, 32767)
    return {
        "name": "Microsoft X-Box 360 pad",
        "bustype": "BUS_USB",
        "vendor": 0x045E,
        "product": 0x028E,
        "version": 0x0110,
        "keys": [
            "BTN_SOUTH", "BTN_EAST", "BTN_NORTH", "BTN_WEST",
            "BTN_TL", "BTN_TR",
            "BTN_SELECT", "BTN_START", "BTN_MODE",
            "BTN_THUMBL", "BTN_THUMBR",
        ],
        "abs": {
            "ABS_X": stick, "ABS_Y": stick,
            "ABS_RX": stick, "ABS_RY": stick,
            "ABS_Z": (0, 255), "ABS_RZ": (0, 255),
            "ABS_HAT0X": (-1, 1), "ABS_HAT0Y": (-1, 1),
        },
    }


def open_evdev_device(caps):
    """Open a real uinput device for ``caps`` (from ``xbox360_capabilities``)."""
    if not os.access(UINPUT_PATH, os.W_OK):
        raise PermissionError(13, "Permission denied", UINPUT_PATH)
    try:
        import evdev
    except ImportError as e:
        raise UinputError("python-evdev is not installed; run scripts/setup.sh (Linux only).") from e
    ec = evdev.ecodes.ecodes
    events = {
        ec["EV_KEY"]: [ec[k] for k in caps["keys"]],
        ec["EV_ABS"]: [
            (ec[code], evdev.AbsInfo(value=0, min=lo, max=hi, fuzz=0, flat=0, resolution=0))
            for code, (lo, hi) in caps["abs"].items()
        ],
    }
    try:
        return evdev.UInput(
            events=events, name=caps["name"], bustype=ec[caps["bustype"]],
            vendor=caps["vendor"], product=caps["product"], version=caps["version"],
        )
    except evdev.UInputError as e:  # evdev's own "cannot be opened for writing" check
        raise PermissionError(13, str(e), UINPUT_PATH) from e


class UinputBackend(InputBackend):
    """InputBackend that creates real Xbox 360 pads through /dev/uinput.

    ``open_device(caps)`` returns a device with ``write(type, code, value)``,
    ``syn()`` and ``close()``; it defaults to ``open_evdev_device`` and is
    injectable for tests.
    """

    def __init__(self, open_device=open_evdev_device):
        self._open_device = open_device
        self._pads = {}

    def create_pad(self, player):
        """Create ``player``'s pad; raises UinputError if /dev/uinput isn't writable."""
        if player in self._pads:
            raise ValueError(f"pad for player {player} already exists")
        try:
            self._pads[player] = self._open_device(xbox360_capabilities())
        except PermissionError as e:
            raise UinputError(f"Cannot write to {UINPUT_PATH} ({e}). {FIX_HINT}") from e

    def emit(self, player, events):
        """Write ``(type, code, value)`` events (code names) to ``player``'s pad."""
        from evdev.ecodes import ecodes

        device = self._pads[player]
        for type_, code, value in events:
            device.write(ecodes[type_], ecodes[code], value)

    def sync(self, player):
        """Emit ``SYN_REPORT`` on ``player``'s pad."""
        self._pads[player].syn()

    def destroy(self, player):
        """Close and forget ``player``'s pad."""
        self._pads.pop(player).close()

    def close(self):
        """Close every pad."""
        for player in list(self._pads):
            self.destroy(player)
