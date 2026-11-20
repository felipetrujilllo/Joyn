# Backlog

## Goal
Turn phones into game controllers for local split-screen co-op on a Steam Deck, fully offline. A phone
scans a QR code, opens a controller page served by the Deck, and appears to games as its own Xbox 360
pad. Source of truth for decisions: `CLAUDE.local.md`.

## Success criteria
- Each build step's pass condition in `CLAUDE.local.md` ("Build order") - steps gate each other; don't start the next until the previous passes.
- v1 done = step 6: Overcooked and Moving Out with 3 phones + Deck, no internet, 30+ minutes.
- Code someone else could read and run (small modules, docstrings, README) - matters for a possible open-source release.

## Vertical slice (MVP)
**Outcome:** One phone on home Wi-Fi scans a QR code printed in the Deck's terminal and plays Overcooked in Gaming Mode as player 2 with the full Xbox layout.

**End-to-end path:** phone camera scans terminal QR -> `GET /?k=<token>` serves `web/` -> `controller.js` turns touches into a state snapshot -> `/ws` (`server.py`, token check) -> `protocol.py` parse/clamp/seq check -> `PadManager.apply` -> `UinputBackend` emits evdev events -> Steam Input -> game.

**Out of scope for the slice:** host approval and trusted ids, multiple phones and slot numbering, the 250 ms / 60 s session timeouts (only neutral-on-disconnect), control API and admin page, hotspot and Join QR, systemd service and `setup.sh`, token rotation, RTT/debug overlay, haptics, Decky plugin.

## Tasks
Tracked as GitHub issues. Regenerate this snapshot with `gh issue list --state all`.

| Issue | Task | Owner | Size | Status |
|-------|------|-------|------|--------|
| #1 | Project skeleton, test runners and ## Checks | - | S | open |
| #2 | Virtual Xbox 360 pad backends (uinput + fake) | - | M | open |
| #3 | Pad smoke test script (build step 0) | - | S | open |
| #4 | Phone protocol: parse, validate and clamp snapshots | - | M | open |
| #5 | PadManager: apply snapshot to evdev events | - | M | open |
| #6 | Config file with a stable token | - | S | open |
| #7 | Server: serve the phone page and wire /ws to the pad | - | M | open |
| #8 | Startup: print the controller URL and a terminal QR | - | S | open |
| #9 | Phone page: layout and multi-touch to state | - | M | open |
| #10 | Phone WebSocket client: hello, rate-capped snapshots, reconnect | - | M | open |
| #11 | End-to-end smoke test and Gaming Mode run | - | S | open |

Critical path: #1 -> #2 -> #5 -> #7 -> #11. #4, #6 and #9 can run in parallel with #2.
