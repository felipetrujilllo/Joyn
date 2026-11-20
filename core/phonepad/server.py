"""aiohttp app: serves the phone page (``web/``) and the phones' ``/ws`` endpoint.

Slice rule for slots: one phone is player 2. Slot 2 belongs to the first phone
id admitted, for the server's lifetime; that id gets its pad back on reconnect,
and any other id gets ``{"t":"full"}``. (Sessions, approval and more slots
come later.) aiohttp turns ``TCP_NODELAY`` on for every connection itself.
"""

import hmac
import json
from pathlib import Path

from aiohttp import WSMsgType, web

from phonepad.protocol import Hello, SeqTracker, Snapshot, parse

WEB_DIR = Path(__file__).resolve().parent / "web"
PLAYER = 2
BAD_TOKEN_CLOSE = 4003  # the phone stops retrying on this code
MAX_WS_MSG = 4096


def create_app(config, pads):
    """Build the app for ``config`` (needs ``token``; optional ``trusted_ids``) on ``pads``.

    ``pads`` is a ``PadManager``; on app cleanup every pad is neutralized and destroyed.
    """
    app = web.Application()
    owner = []  # the phone id holding slot 2, once one is admitted

    async def index(request):
        return web.FileResponse(WEB_DIR / "index.html")

    async def ws(request):
        return await _ws(request, config, pads, owner)

    async def cleanup(app):
        pads.close()

    app.router.add_get("/", index)
    app.router.add_get("/ws", ws)
    app.router.add_static("/", WEB_DIR)
    app.on_cleanup.append(cleanup)
    return app


async def _admit(config, pads, owner, ws, hello):
    """Send the join reply for ``hello``; return True if it got slot 2."""
    # surrogatepass: a JSON-escaped lone surrogate in the token must compare as wrong, not crash
    given = hello.token.encode("utf-8", "surrogatepass")
    if not hmac.compare_digest(given, config["token"].encode("utf-8", "surrogatepass")):
        await ws.close(code=BAD_TOKEN_CLOSE)
        return False
    trusted = config.get("trusted_ids")
    # a non-list value (e.g. a string from a hand-edited config) denies everyone instead of substring-matching
    if trusted is not None and (not isinstance(trusted, list) or hello.id not in trusted):
        await ws.send_str('{"t":"denied"}')
        await ws.close()
        return False
    if not owner:
        owner.append(hello.id)
        pads.add(PLAYER)  # pads outlive connections: created once, reused on reconnect
    elif owner[0] != hello.id:
        await ws.send_str('{"t":"full"}')
        await ws.close()
        return False
    await ws.send_str('{"t":"slot","player":2}')
    return True


def _pong(raw):
    """Return the pong reply for a ping message, or None if ``raw`` isn't a ping with an int ts."""
    if '"ping"' not in raw:  # cheap pre-check keeps json.loads off the snapshot path
        return None
    try:
        msg = json.loads(raw)
    except ValueError:
        return None
    if type(msg) is dict and msg.get("t") == "ping" and type(msg.get("ts")) is int:
        return json.dumps({"t": "pong", "ts": msg["ts"]})
    return None


async def _ws(request, config, pads, owner):
    """Phone WebSocket: a valid hello first, then snapshots and pings."""
    ws = web.WebSocketResponse(max_msg_size=MAX_WS_MSG)
    await ws.prepare(request)
    first = await ws.receive()
    hello = parse(first.data) if first.type == WSMsgType.TEXT else None
    if not isinstance(hello, Hello):
        await ws.close()
        return ws
    if not await _admit(config, pads, owner, ws, hello):
        return ws
    seq = SeqTracker()  # per connection: q restarts at 0 on page reload
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            snap = parse(msg.data)
            if isinstance(snap, Snapshot):
                if seq.accept(snap.q):
                    pads.apply(PLAYER, snap)
                continue
            pong = _pong(msg.data)
            if pong is not None:
                await ws.send_str(pong)
    finally:
        if PLAYER in pads.players:  # may already be gone if shutdown cleanup ran first
            pads.neutral(PLAYER)  # nothing stays held, however the connection ended
    return ws
