import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BAD_TOKEN_CLOSE, KEEPALIVE_MS, SEND_INTERVAL_MS, backoff, createReconnect, createSender, helloMessage, joinToken,
  phoneId, statusText, uuid,
} from "../../phonepad/web/net.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const state = (b, lx = 0) => ({ b, lx, ly: 0, rx: 0, ry: 0 });

/** In-memory Storage stand-in. */
function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}
const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };

/** Drive `sender` with 1 ms ticks from `from` to `to` (exclusive); returns [{at, msg}] of sends. */
function run(sender, from, to, changes = {}) {
  const sent = [];
  for (let t = from; t < to; t++) {
    if (changes[t]) sender.update(changes[t]);
    const m = sender.tick(t);
    if (m) sent.push({ at: t, msg: JSON.parse(m) });
  }
  return sent;
}

// hello, id, token

test("hello has t, id and token and fits in 1024 bytes", () => {
  const raw = helloMessage("abc", "tok");
  assert.deepEqual(JSON.parse(raw), { t: "hello", id: "abc", k: "tok" });
  assert.ok(new TextEncoder().encode(helloMessage(uuid(), "x".repeat(64))).length <= 1024);
});

test("generated ids are UUID-shaped and differ", () => {
  const a = uuid(), b = uuid();
  assert.match(a, UUID);
  assert.match(b, UUID);
  assert.notEqual(a, b);
});

test("phone id is created once and reused from the same storage", () => {
  const s = memStorage();
  const id = phoneId(s);
  assert.match(id, UUID);
  assert.equal(phoneId(s), id);
  assert.notEqual(phoneId(memStorage()), id);
});

test("a throwing or missing storage still yields a valid id", () => {
  assert.match(phoneId(throwing), UUID);
  assert.match(phoneId(null), UUID);
});

test("token is read from ?k= and remembered", () => {
  const s = memStorage();
  assert.equal(joinToken("?k=abc123", s), "abc123");
  assert.equal(joinToken("", s), "abc123"); // Android Home Screen launch: start_url has no ?k=
  assert.equal(joinToken("?k=new", s), "new"); // a new QR (rotated token) wins
  assert.equal(joinToken("?other=1", s), "new");
  assert.equal(joinToken("", memStorage()), "");
  assert.equal(joinToken("?k=xyz", throwing), "xyz");
  assert.equal(joinToken("", throwing), "");
});

// Sender timing

test("nothing is sent before the first state", () => {
  const s = createSender();
  assert.equal(s.tick(0), null);
  assert.equal(s.due(), Infinity);
});

test("throttle: second change is sent at the 16.7 ms window with the latest state", () => {
  const s = createSender();
  s.update(state(1));
  assert.equal(JSON.parse(s.tick(0)).b, 1); // first change goes out at once
  s.update(state(2));
  assert.equal(s.tick(5), null);
  s.update(state(3)); // intermediate state 2 is skipped
  assert.equal(s.tick(10), null);
  assert.equal(s.due(), SEND_INTERVAL_MS);
  assert.equal(s.tick(16), null);
  assert.equal(JSON.parse(s.tick(17)).b, 3); // final state is never lost
});

test("throttle: at most 60 sends in any 1 s of continuous changes", () => {
  const s = createSender();
  const changes = {};
  for (let t = 0; t < 3000; t++) changes[t] = state(t % 2, t);
  const at = run(s, 0, 3000, changes).map((x) => x.at);
  for (let i = 0; i + 60 < at.length; i++) assert.ok(at[i + 60] - at[i] >= 1000, `window at ${at[i]}`);
  assert.ok(at.length >= 170, `sent only ${at.length}`); // still close to 60/s
});

test("keepalive: idle resends the last state every 100 ms", () => {
  const s = createSender();
  const sent = run(s, 0, 501, { 0: state(5, 100) });
  assert.deepEqual(sent.map((x) => x.at), [0, 100, 200, 300, 400, 500]);
  for (const { msg } of sent) assert.equal(msg.b, 5);
  assert.equal(KEEPALIVE_MS, 100);
});

test("keepalive: none while changes flow faster than 100 ms", () => {
  const s = createSender();
  const changes = {};
  for (let t = 0; t < 1000; t += 50) changes[t] = state(1, t);
  const sent = run(s, 0, 1000, changes);
  assert.deepEqual(sent.map((x) => x.at), Object.keys(changes).map(Number));
  sent.forEach(({ at, msg }) => assert.equal(msg.lx, at)); // each is the change, not a resend
});

test("q strictly increases across changes, keepalives and a reconnect", () => {
  const s = createSender();
  const qs = run(s, 0, 300, { 0: state(1), 5: state(2), 40: state(3) }).map((x) => x.msg.q);
  s.reset(); // new connection: send at once, but keep counting
  const after = JSON.parse(s.tick(301)).q;
  qs.push(after, ...run(s, 302, 600, { 350: state(4) }).map((x) => x.msg.q));
  assert.ok(qs.length > 6);
  qs.forEach((q, i) => i && assert.ok(q > qs[i - 1], `q ${q} after ${qs[i - 1]}`));
  assert.equal(qs[0], 0);
});

test("every snapshot is valid for the Deck: t/q/b/axes, ints only", () => {
  const s = createSender();
  s.update({ b: 0x1ffff, lx: -32767, ly: 32767, rx: 0, ry: 1 });
  const raw = s.tick(0);
  const msg = JSON.parse(raw);
  assert.deepEqual(Object.keys(msg).sort(), ["b", "lx", "ly", "q", "rx", "ry", "t"]);
  assert.equal(msg.t, "s");
  for (const k of ["q", "b", "lx", "ly", "rx", "ry"]) assert.ok(Number.isInteger(msg[k]), k);
  assert.ok(new TextEncoder().encode(raw).length <= 1024);
});

// Backoff and status

test("backoff doubles from 250 ms up to a 5 s cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(backoff), [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
});

test("reconnect: open-then-close keeps backing off; only a slot resets it", () => {
  const r = createReconnect();
  // The Deck accepts the socket, then closes it (bad token, full) over and over: no reset on open.
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => r.nextDelay()), [250, 500, 1000, 2000, 4000, 5000]);
  r.admitted(); // got a slot
  assert.equal(r.nextDelay(), 250);
  assert.equal(r.nextDelay(), 500);
});

test("reconnect: stopping ends retries for good", () => {
  const r = createReconnect();
  r.nextDelay();
  r.stop();
  assert.equal(r.nextDelay(), null);
  r.admitted();
  assert.equal(r.nextDelay(), null);
  assert.equal(BAD_TOKEN_CLOSE, 4003);
});

test("client uses the reconnect policy: reset on slot, stop on denied or bad token, never reset on open", () => {
  const js = read("client.js");
  const onopen = js.slice(js.indexOf("ws.onopen"), js.indexOf("ws.onmessage"));
  assert.doesNotMatch(onopen, /admitted|attempt/);
  assert.match(js, /if \(msg\.t === "slot"\) reconnect\.admitted\(\);/);
  assert.match(js, /if \(msg\.t === "denied"\) reconnect\.stop\(\);/);
  assert.match(js, /if \(e\.code === BAD_TOKEN_CLOSE\) \{\s*reconnect\.stop\(\);/);
  assert.match(js, /const delay = reconnect\.nextDelay\(\);\s*if \(delay === null\) return;/);
  assert.match(js, /setTimeout\(connect, delay\)/);
});

test("status text for the Deck's replies", () => {
  assert.equal(statusText({ t: "pending" }), "Waiting for approval");
  assert.equal(statusText({ t: "slot", player: 2 }), "Player 2");
  assert.equal(statusText({ t: "denied" }), "Denied");
  assert.equal(statusText({ t: "full" }), "Game full");
  assert.equal(statusText({ t: "pong", ts: 1 }), null);
});

// Static page checks

test("page has the manifest link and Home Screen meta tags and loads client.js", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="manifest" href="manifest.json">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style"/);
  assert.match(html, /<script type="module" src="client.js">/);
  assert.match(html, /id="status"/);
  assert.ok(html.indexOf("client.js") < html.indexOf("controller.js"), "client.js must hear the first padstate");
});

test("manifest is fullscreen landscape with a relative start_url", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.equal(m.display, "fullscreen");
  assert.equal(m.orientation, "landscape");
  assert.ok(m.name && m.short_name);
  assert.ok(!/^[a-z]+:|^\//i.test(m.start_url), m.start_url);
});

test("client connects to the serving host, never a hard-coded one", () => {
  const js = read("client.js");
  assert.ok(js.includes("new WebSocket(`ws://${location.host}/ws`)"));
  assert.ok(!js.includes("randomUUID"));
});
