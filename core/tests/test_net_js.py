"""Messages produced by the phone's web/net.js must pass the Deck's protocol.parse (issue #10)."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from phonepad.protocol import Hello, Snapshot, parse

NET_JS = Path(__file__).resolve().parents[1] / "phonepad" / "web" / "net.js"

SCRIPT = """
const net = await import(process.argv[1]);
const s = net.createSender();
const out = [net.helloMessage(net.uuid(), "tok")];
s.update({ b: 0x1ffff, lx: -32767, ly: 32767, rx: 5, ry: -5 });
out.push(s.tick(0), s.tick(100));
s.reset();
out.push(s.tick(101));
console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_net_js_messages_parse_on_the_deck():
    run = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT, NET_JS.as_uri()],
        capture_output=True, text=True, check=True, timeout=30,
    )
    hello, *snaps = [parse(m) for m in json.loads(run.stdout)]
    assert isinstance(hello, Hello) and hello.token == "tok" and hello.id
    assert snaps == [Snapshot(q, 0x1FFFF, -32767, 32767, 5, -5) for q in (0, 1, 2)]
