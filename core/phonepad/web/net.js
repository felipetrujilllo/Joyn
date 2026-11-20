// Pure networking logic for the phone: messages, send timing, backoff, id and token.
// No DOM or WebSocket here; times are passed in as `now` (ms) so tests are deterministic.

export const SEND_INTERVAL_MS = 1000 / 60;
export const KEEPALIVE_MS = 100;
const ID_KEY = "phonepad.id";
const TOKEN_KEY = "phonepad.token";

/** Return the `hello` message for phone `id` and join `token`, as a JSON string. */
export function helloMessage(id, token) {
  return JSON.stringify({ t: "hello", id, k: token });
}

/**
 * Create a snapshot sender. `update(state)` records the latest pad state ({b, lx, ly, rx, ry});
 * `tick(now)` returns the snapshot JSON to send now, or null. A change is sent at most once per
 * SEND_INTERVAL_MS (always the latest state, so the final one is never lost); with no change the
 * last state is resent every KEEPALIVE_MS. `q` keeps increasing for the sender's whole life.
 */
export function createSender() {
  let q = 0, state = null, dirty = false, lastSent = -Infinity;
  return {
    update(s) { state = s; dirty = true; },
    /** Time (ms) when `tick` will next have something to send, or Infinity before any state. */
    due() { return state ? lastSent + (dirty ? SEND_INTERVAL_MS : KEEPALIVE_MS) : Infinity; },
    tick(now) {
      if (now < this.due()) return null;
      lastSent = now;
      dirty = false;
      const { b, lx, ly, rx, ry } = state;
      return JSON.stringify({ t: "s", q: q++, b, lx, ly, rx, ry });
    },
    /** Make the next tick send immediately (call on a new connection). */
    reset() { lastSent = -Infinity; },
  };
}

/** Reconnect delay (ms) for the 0-based `attempt`: 250 ms doubling, capped at 5 s. */
export function backoff(attempt) {
  return Math.min(250 * 2 ** attempt, 5000);
}

/** WebSocket close code the Deck uses for a wrong or rotated token; retrying can't fix it. */
export const BAD_TOKEN_CLOSE = 4003;

/**
 * Reconnect policy. The socket opening proves nothing (the Deck checks the token after `hello`
 * and may close right away), so the delay only resets once the Deck gives the phone a slot.
 * `nextDelay()` returns the ms to wait before reconnecting, or null once stopped.
 */
export function createReconnect() {
  let attempt = 0, stopped = false;
  return {
    /** The Deck accepted the phone (`slot`): start over at the shortest delay. */
    admitted() { attempt = 0; },
    /** Stop reconnecting (denied, or a bad token). */
    stop() { stopped = true; },
    nextDelay() { return stopped ? null : backoff(attempt++); },
  };
}

/** Return a random v4 UUID. Uses getRandomValues: randomUUID is missing over plain HTTP. */
export function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Get the phone id from `storage`, creating it once; if storage throws, a fresh id is returned. */
export function phoneId(storage) {
  try {
    let id = storage.getItem(ID_KEY);
    if (!id) storage.setItem(ID_KEY, (id = uuid()));
    return id;
  } catch {
    return uuid();
  }
}

/**
 * Return the token from the `?k=` in `search` and remember it in `storage`; without one, return
 * the remembered token (Android Home Screen launches use the static manifest start_url) or "".
 */
export function joinToken(search, storage) {
  const k = new URLSearchParams(search).get("k");
  try {
    if (k) storage.setItem(TOKEN_KEY, k);
    else return storage.getItem(TOKEN_KEY) ?? "";
  } catch { /* storage unavailable: use the URL only */ }
  return k ?? "";
}

/** Status text for a Deck -> phone message, or null if the message doesn't change the status. */
export function statusText(msg) {
  switch (msg.t) {
    case "pending": return "Waiting for approval";
    case "slot": return `Player ${msg.player}`;
    case "denied": return "Denied";
    case "full": return "Game full";
    default: return null;
  }
}
