"""Tests for server.py (issue #7): phone page, /ws join, snapshots -> pad, neutral on close."""

import asyncio
import json

from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from phonepad.backends.fake import SYN, FakeBackend
from phonepad.pads import PadManager
from phonepad.protocol import bit
from phonepad.server import create_app

TOKEN = "secret-token"
NEUTRAL_TAIL = ("EV_ABS", "ABS_RY", 0)


def run(test, **config):
    """Run ``test(client, backend)`` against a fresh app; return the backend after cleanup."""
    backend = FakeBackend()

    async def main():
        app = create_app(dict({"token": TOKEN, "port": 0}, **config), PadManager(backend))
        async with TestClient(TestServer(app)) as client:
            await test(client, backend)
        return backend

    return asyncio.run(main())


async def join(client, pid="phone-1", token=TOKEN):
    ws = await client.ws_connect("/ws")
    await ws.send_str(json.dumps({"t": "hello", "id": pid, "k": token}))
    return ws


async def sync(ws, ts=1):
    """Ping and wait for the pong, so every message sent before it has been handled."""
    await ws.send_str(json.dumps({"t": "ping", "ts": ts}))
    assert await ws.receive_json(timeout=2) == {"t": "pong", "ts": ts}


def snap(q, b=0, lx=0):
    return json.dumps({"t": "s", "q": q, "b": b, "lx": lx, "ly": 0, "rx": 0, "ry": 0})


async def until(cond):
    for _ in range(200):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not met")


async def closed(ws):
    msg = await ws.receive(timeout=2)
    assert msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING)
    return ws.close_code


def test_serves_phone_page_and_static_files():
    async def t(client, backend):
        r = await client.get("/")
        assert r.status == 200
        assert '<div id="pad">' in await r.text()
        for path in ("/layout.json", "/client.js"):
            assert (await client.get(path)).status == 200

    run(t)


def test_wrong_token_closes_with_4003_and_creates_no_pad():
    async def t(client, backend):
        ws = await join(client, token="wrong")
        assert await closed(ws) == 4003
        assert backend.pads == []

    run(t)


def test_unencodable_token_closes_with_4003_not_a_crash():
    async def t(client, backend):
        ws = await client.ws_connect("/ws")
        await ws.send_str('{"t":"hello","id":"p","k":"\\ud800"}')  # valid JSON, lone surrogate
        assert await closed(ws) == 4003
        assert backend.pads == []

    run(t)


def test_valid_hello_gets_slot_2_and_pad_2():
    async def t(client, backend):
        ws = await join(client)
        assert await ws.receive_str(timeout=2) == '{"t":"slot","player":2}'
        assert backend.pads == [2]

    run(t)


def test_snapshot_moves_pad_and_stale_q_is_ignored():
    async def t(client, backend):
        ws = await join(client)
        await ws.receive_json(timeout=2)
        await ws.send_str(snap(5, b=bit("A")))
        await sync(ws)
        events = backend.events[2]
        assert ("EV_KEY", "BTN_SOUTH", 1) in events
        assert events.count(SYN) == 1 and events[-1] == SYN
        before = list(events)
        await ws.send_str(snap(5))  # duplicate q
        await ws.send_str(snap(3))  # older q
        await sync(ws, ts=2)
        assert backend.events[2] == before

    run(t)


def test_snapshot_before_hello_is_not_applied_and_closes():
    async def t(client, backend):
        ws = await client.ws_connect("/ws")
        await ws.send_str(snap(1, b=bit("A")))
        await closed(ws)
        assert backend.pads == [] and backend.events == {}

    run(t)


def test_close_sets_neutral_and_keeps_pad():
    async def t(client, backend):
        ws = await join(client)
        await ws.receive_json(timeout=2)
        await ws.send_str(snap(1, b=bit("A"), lx=1000))
        await sync(ws)
        count = len(backend.events[2])
        await ws.close()
        await until(lambda: len(backend.events[2]) > count)
        tail = backend.events[2][count:]
        assert ("EV_KEY", "BTN_SOUTH", 0) in tail and ("EV_ABS", "ABS_X", 0) in tail
        assert tail[-1] == SYN
        assert backend.pads == [2]

    run(t)


def test_reconnect_same_id_reuses_pad_and_accepts_q_from_zero():
    async def t(client, backend):
        ws = await join(client)
        await ws.receive_json(timeout=2)
        await ws.send_str(snap(50))
        await sync(ws)
        await ws.close()
        ws = await join(client)
        assert await ws.receive_json(timeout=2) == {"t": "slot", "player": 2}
        assert backend.pads == [2]  # no second create_pad (FakeBackend would raise)
        count = len(backend.events[2])
        await ws.send_str(snap(0, b=bit("B")))
        await sync(ws)
        assert ("EV_KEY", "BTN_EAST", 1) in backend.events[2][count:]

    run(t)


def test_second_phone_gets_full_and_is_closed():
    async def t(client, backend):
        first = await join(client, "phone-1")
        await first.receive_json(timeout=2)
        other = await join(client, "phone-2")
        assert await other.receive_json(timeout=2) == {"t": "full"}
        assert await closed(other) != 4003
        assert backend.pads == [2]

    run(t)


def test_ping_pong_and_snapshots_still_work():
    async def t(client, backend):
        ws = await join(client)
        await ws.receive_json(timeout=2)
        await sync(ws, ts=123456)
        await ws.send_str(json.dumps({"t": "ping", "ts": "nope"}))  # ignored, no reply
        await ws.send_str(snap(1, b=bit("X")))
        await sync(ws, ts=7)  # next reply is this pong, so the bad ping got none
        assert ("EV_KEY", "BTN_NORTH", 1) in backend.events[2]

    run(t)


def test_trusted_ids_denies_unknown_and_admits_listed():
    async def t(client, backend):
        ws = await join(client, "stranger")
        assert await ws.receive_json(timeout=2) == {"t": "denied"}
        await closed(ws)
        assert backend.pads == []
        ws = await join(client, "phone-1")
        assert await ws.receive_json(timeout=2) == {"t": "slot", "player": 2}

    run(t, trusted_ids=["phone-1"])


def test_trusted_ids_that_is_not_a_list_denies_instead_of_substring_matching():
    async def t(client, backend):
        ws = await join(client, "phone")  # a substring of "phone-1"
        assert await ws.receive_json(timeout=2) == {"t": "denied"}
        await closed(ws)
        assert backend.pads == []

    run(t, trusted_ids="phone-1")


def test_cleanup_neutralizes_and_destroys_pads():
    async def t(client, backend):
        ws = await join(client)
        await ws.receive_json(timeout=2)
        await ws.send_str(snap(1, b=bit("A")))
        await sync(ws)
        await ws.close()
        await until(lambda: backend.events[2].count(SYN) == 2)  # apply + neutral on close

    backend = run(t)
    assert backend.pads == []
    assert backend.events[2].count(SYN) == 3  # + neutral from pads.close() on cleanup
    assert backend.events[2][-2:] == [NEUTRAL_TAIL, SYN]
