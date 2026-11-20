// WebSocket glue: hello, rate-capped snapshots from `padstate` events, reconnect, status line.
import { BAD_TOKEN_CLOSE, createReconnect, createSender, helloMessage, joinToken, phoneId, statusText } from "./net.js";

const store = (() => { try { return localStorage; } catch { return null; } })(); // can throw when disabled
const id = phoneId(store);
const token = joinToken(location.search, store);
const sender = createSender();
const reconnect = createReconnect();
const status = document.getElementById("status");
let ws = null, timer = 0, keepStatus = false;

/** Send whatever the sender has due and schedule the next check. */
function flush() {
  clearTimeout(timer);
  if (ws?.readyState !== WebSocket.OPEN) return;
  const msg = sender.tick(performance.now());
  if (msg) ws.send(msg);
  const wait = sender.due() - performance.now();
  if (wait < Infinity) timer = setTimeout(flush, Math.max(0, wait));
}

/** Open the socket to the host that served this page; retry with backoff when it closes. */
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(helloMessage(id, token));
    sender.reset();
    flush();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const text = msg && statusText(msg);
    if (!text) return;
    status.textContent = text;
    keepStatus = msg.t === "full" || msg.t === "denied";
    if (msg.t === "slot") reconnect.admitted();
    if (msg.t === "denied") reconnect.stop(); // retrying would only ask the host again
  };
  ws.onclose = (e) => {
    clearTimeout(timer);
    if (e.code === BAD_TOKEN_CLOSE) {
      reconnect.stop();
      status.textContent = "Invalid code: scan the QR again";
      return;
    }
    const delay = reconnect.nextDelay();
    if (delay === null) return;
    if (!keepStatus) status.textContent = "Connecting…";
    setTimeout(connect, delay);
  };
}

document.addEventListener("padstate", (e) => { sender.update(e.detail); flush(); });
connect();
