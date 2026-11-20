"""End-to-end smoke test: a fake phone drives the real server over a real local socket.

Usage, from the repo root (no PYTHONPATH needed, no hardware, never touches ~/.config):

    .venv/bin/python core/scripts/smoke_e2e.py

Steps: fresh temp config -> server on 127.0.0.1 (FakeBackend) -> phone page -> wrong token
closed with 4003 -> hello gets player 2 -> snapshots (made by the phone's real web/net.js
when node is installed) become the right FakeBackend events -> a stale q adds nothing ->
closing the socket leaves pad 2 neutral but alive -> shutdown neutralizes and destroys it.
Prints one PASS line per step; exits 0 on success, 1 with a one-line FAIL otherwise.
"""

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # find phonepad without PYTHONPATH

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402

from phonepad import config as config_mod  # noqa: E402
from phonepad.backends.fake import SYN, FakeBackend  # noqa: E402
from phonepad.pads import PadManager  # noqa: E402
from phonepad.protocol import bit  # noqa: E402
from phonepad.qr import controller_url  # noqa: E402
from phonepad.server import create_app  # noqa: E402

NET_JS = Path(__file__).resolve().parents[1] / "phonepad" / "web" / "net.js"
PHONE_ID = "smoke-phone"
# What the phone (web/net.js) expects, written out here rather than imported from the server,
# so the smoke fails if the server ever drifts from the phone's contract.
BAD_TOKEN_CLOSE = 4003
PLAYER = 2
EVENTS_PER_REPORT = 20  # 11 keys + 8 axes + SYN_REPORT; pads.py writes the full state each time
# Every code a full report must contain, exactly once (the Xbox 360 pad from the brief's table).
EXPECTED_CODES = {
    "BTN_SOUTH", "BTN_EAST", "BTN_NORTH", "BTN_WEST", "BTN_TL", "BTN_TR",
    "BTN_SELECT", "BTN_START", "BTN_MODE", "BTN_THUMBL", "BTN_THUMBR",
    "ABS_X", "ABS_Y", "ABS_RX", "ABS_RY", "ABS_Z", "ABS_RZ", "ABS_HAT0X", "ABS_HAT0Y",
}
TIMEOUT = 5

# The three pad states the phone sends, in order.
STATES = [
    {"b": bit("A"), "lx": 0, "ly": -32767, "rx": 0, "ry": 0},  # A + left stick full up
    {"b": bit("Up") | bit("LT"), "lx": 0, "ly": 0, "rx": 32767, "ry": 0},  # D-pad up + LT + right stick
    {"b": 0, "lx": 0, "ly": 0, "rx": 0, "ry": 0},  # all released
]
# Expected non-zero values per state; every other code must be 0.
EXPECTED = [
    {"BTN_SOUTH": 1, "ABS_Y": -32767},
    {"ABS_HAT0Y": -1, "ABS_Z": 255, "ABS_RX": 32767},
    {},
]

# Runs the phone's real message builders: hello, one snapshot per state, then q=1 again (stale).
NODE_SCRIPT = """
const net = await import(process.argv[1]);
const states = JSON.parse(process.argv[2]);
const s = net.createSender();
const out = [net.helloMessage(process.argv[3], process.argv[4])];
states.forEach((st, i) => { s.update(st); out.push(s.tick(i * 1000)); });
out.push(out[2]);
console.log(JSON.stringify(out));
"""


class Failure(Exception):
    """A smoke step failed; the message is the one-line reason."""


def check(ok, message):
    """Raise ``Failure(message)`` unless ``ok``."""
    if not ok:
        raise Failure(message)


def phone_messages(token):
    """Return ``(source, [hello, snap q0, snap q1, snap q2, stale q1])`` as JSON strings."""
    if shutil.which("node"):
        run = subprocess.run(
            ["node", "--input-type=module", "-e", NODE_SCRIPT, NET_JS.as_uri(),
             json.dumps(STATES), PHONE_ID, token],
            capture_output=True, text=True, timeout=30,
        )
        check(run.returncode == 0, "node could not run web/net.js: " + run.stderr.strip()[-200:])
        return "web/net.js", json.loads(run.stdout)
    snaps = [json.dumps(dict(st, t="s", q=q)) for q, st in enumerate(STATES)]
    hello = json.dumps({"t": "hello", "id": PHONE_ID, "k": token})
    return "hand-written JSON (node not found)", [hello] + snaps + [snaps[1]]


def report_values(report, label):
    """Check ``report`` is one full state ending in a single SYN; return ``{code: value}``."""
    check(len(report) == EVENTS_PER_REPORT and report[-1] == SYN and SYN not in report[:-1],
          "{}: expected {} events ending in one SYN_REPORT, got {}".format(label, EVENTS_PER_REPORT, report))
    codes = [code for _, code, _ in report[:-1]]
    # a wrong mapping onto another control's code would duplicate one code and drop another
    check(len(codes) == len(set(codes)) and set(codes) == EXPECTED_CODES,
          "{}: codes must be each of the pad's 19 codes exactly once; missing {}, duplicated {}".format(
              label, sorted(EXPECTED_CODES - set(codes)), sorted({c for c in codes if codes.count(c) > 1})))
    return {code: value for _, code, value in report[:-1]}


def check_report(report, nonzero, label):
    """Check ``report`` sets exactly the codes in ``nonzero`` and zeroes the rest."""
    values = report_values(report, label)
    wrong = {c: v for c, v in values.items() if v != nonzero.get(c, 0)}
    check(not wrong, "{}: wrong values {} (expected non-zero {})".format(label, wrong, nonzero))


async def wait_until(cond, what):
    """Yield to the event loop until ``cond()`` is true; fail after ``TIMEOUT`` seconds."""
    async def poll():
        while not cond():
            await asyncio.sleep(0.005)
    try:
        await asyncio.wait_for(poll(), TIMEOUT)
    except asyncio.TimeoutError:
        raise Failure("timed out waiting for " + what)


async def barrier(ws, ts):
    """Ping and wait for the matching pong: every message sent before it has been handled."""
    await ws.send_str(json.dumps({"t": "ping", "ts": ts}))
    reply = await ws.receive_json(timeout=TIMEOUT)
    check(reply == {"t": "pong", "ts": ts}, "expected pong {}, got {}".format(ts, reply))


async def smoke(tmp):
    """Run every step against a server on a real socket; raises ``Failure`` on the first miss."""
    cfg = config_mod.load(Path(tmp) / "config.json")
    token = cfg["token"]
    source, msgs = phone_messages(token)
    hello, snaps, stale = msgs[0], msgs[1:4], msgs[4]
    print("PASS config: fresh temp config with a token; phone messages from " + source)

    fake = FakeBackend()
    runner = web.AppRunner(create_app(cfg, PadManager(fake)))
    await runner.setup()
    cleaned = False
    try:
        site = web.TCPSite(runner, "127.0.0.1", 0)  # port 0: the OS picks a free one
        await site.start()
        port = runner.addresses[0][1]
        base = "http://127.0.0.1:{}".format(port)
        print("PASS server: listening on {} (FakeBackend)".format(base))

        timeout = aiohttp.ClientTimeout(total=TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.get(controller_url("127.0.0.1", port, token)) as r:
                page = await r.text()
                check(r.status == 200 and 'id="pad"' in page, "GET /?k= -> {}, no pad".format(r.status))
            async with http.get(base + "/client.js") as r:
                check(r.status == 200, "GET /client.js -> {}".format(r.status))
            print("PASS page: controller URL serves the pad page and client.js")

            async with http.ws_connect(base + "/ws") as ws:
                await ws.send_str(json.dumps({"t": "hello", "id": "intruder", "k": token + "x"}))
                msg = await ws.receive(timeout=TIMEOUT)
                check(msg.type == aiohttp.WSMsgType.CLOSE and ws.close_code == BAD_TOKEN_CLOSE,
                      "wrong token: expected close {}, got {} {}".format(BAD_TOKEN_CLOSE, msg.type, ws.close_code))
            check(fake.pads == [], "wrong token created a pad: {}".format(fake.pads))
            print("PASS wrong token: closed with {}, no pad created".format(BAD_TOKEN_CLOSE))

            ws = await http.ws_connect(base + "/ws")
            await ws.send_str(hello)
            reply = await ws.receive_json(timeout=TIMEOUT)
            check(reply == {"t": "slot", "player": PLAYER}, "hello: expected slot 2, got {}".format(reply))
            check(fake.pads == [PLAYER], "hello: expected pad 2, pads are {}".format(fake.pads))
            print("PASS hello: player 2, pad 2 created")

            events = fake.events[PLAYER]
            check(events == [], "pad 2 had events before any snapshot: {}".format(events))
            for i, (snap, nonzero) in enumerate(zip(snaps, EXPECTED)):
                await ws.send_str(snap)
                await barrier(ws, i)
                check(len(events) == EVENTS_PER_REPORT * (i + 1),
                      "snapshot q={}: expected one report, have {} events".format(i, len(events)))
                check_report(events[-EVENTS_PER_REPORT:], nonzero, "snapshot q={}".format(i))
                print("PASS snapshot q={}: {} then SYN_REPORT".format(i, nonzero or "all released"))

            before = len(events)
            await ws.send_str(stale)
            await barrier(ws, 99)
            check(len(events) == before, "stale q=1 added {} events".format(len(events) - before))
            print("PASS stale snapshot: q=1 after q=2 added nothing")

            await ws.close()
            await wait_until(lambda: len(events) == before + EVENTS_PER_REPORT, "the neutral report on close")
            check_report(events[-EVENTS_PER_REPORT:], {}, "neutral on close")
            check(fake.pads == [PLAYER], "pad 2 was removed on disconnect: {}".format(fake.pads))
            print("PASS disconnect: pad 2 set neutral and kept")

        before = len(events)
        await runner.cleanup()
        cleaned = True
        check(len(events) == before + EVENTS_PER_REPORT, "shutdown: expected one neutral report")
        check_report(events[-EVENTS_PER_REPORT:], {}, "neutral on shutdown")
        check(fake.pads == [], "shutdown left pads: {}".format(fake.pads))
        print("PASS shutdown: pads neutralized and destroyed")
    finally:
        if not cleaned:
            await runner.cleanup()


def main():
    """Run the smoke test; return the exit code (0 pass, 1 fail)."""
    with tempfile.TemporaryDirectory() as tmp:
        try:
            asyncio.run(asyncio.wait_for(smoke(tmp), 60))
        except Failure as e:
            print("FAIL " + str(e))
            return 1
        except Exception as e:  # anything unexpected is still a one-line failure
            print("FAIL unexpected {}: {}".format(type(e).__name__, e))
            return 1
    print("PASS end-to-end smoke test")
    return 0


if __name__ == "__main__":
    sys.exit(main())
