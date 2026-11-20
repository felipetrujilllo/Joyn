"""Controller URL, the LAN IP it points at, and a terminal QR of it."""

import io
import socket
from urllib.parse import quote

import qrcode

# UDP connect() only picks a route; no packet is sent. The public IP finds the LAN
# interface when there's a default route; 10.42.0.2 is a host on the Deck hotspot's own
# subnet (NetworkManager shared mode, Deck = 10.42.0.1), which has no default route.
# Never probe a broadcast address (.255): Linux refuses connect() to it with EACCES.
PROBES = ("8.8.8.8", "10.42.0.2")
FALLBACK_IP = "127.0.0.1"


def controller_url(ip, port, token):
    """Return ``http://<ip>:<port>/?k=<token>`` with the token percent-encoded."""
    return f"http://{ip}:{port}/?k={quote(token, safe='')}"


def lan_ip(override=None, make_socket=None):
    """Return ``(ip, warning)``: the LAN address phones should use, and a warning or None.

    ``override`` wins when given. Otherwise each probe in ``PROBES`` is tried in order;
    if none yields a non-loopback address, returns ``FALLBACK_IP`` with a warning.
    ``make_socket`` (default: a UDP socket) is injectable for tests.
    """
    if override:
        return override, None
    make_socket = make_socket or (lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
    for probe in PROBES:
        try:
            with make_socket() as s:
                s.connect((probe, 9))
                ip = s.getsockname()[0]
        except OSError:
            continue
        if not ip.startswith("127.") and ip != "0.0.0.0":
            return ip, None
    return FALLBACK_IP, (
        "Warning: no LAN address found, using {}; phones can't reach that. "
        "Join a network or start the hotspot, or pass --ip <address>.".format(FALLBACK_IP)
    )


def ascii_qr(text):
    """Return ``text`` as a QR code drawn with block characters, for a dark terminal."""
    qr = qrcode.QRCode(border=4)  # the QR spec's quiet zone; phone cameras need the margin
    qr.add_data(text)
    qr.make(fit=True)
    out = io.StringIO()
    qr.print_ascii(out=out, invert=True)  # invert: light blocks on a dark background scan right
    return out.getvalue()
