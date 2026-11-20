# Backlog

## Goal
Turn phones into game controllers for local split-screen co-op on a Steam Deck, fully offline. A phone
scans a QR code, opens a controller page served by the Deck, and appears to games as its own Xbox 360
pad. Source of truth for decisions: `CLAUDE.local.md`.

## Success criteria
- Each build step's pass condition in `CLAUDE.local.md` ("Build order") - steps gate each other; don't start the next until the previous passes.
- v1 done = step 6: Overcooked and Moving Out with 3 phones + Deck, no internet, 30+ minutes.
- Code someone else could read and run (small modules, docstrings, README) - matters for a possible open-source release.

## Current slice: controller looks and profiles
**Outcome:** On the phone you can switch between two controller looks: a restyled "Xbox" profile and a new Steam-Controller-style profile with round trackpads. Both work in a real game without reconnecting.

**End-to-end path:** phone opens the page -> picks a profile (button on screen, remembered on the phone, or `?layout=` in the link) -> `controller.js` loads that profile's layout file and style -> touches (buttons, sticks, trackpads) become the same snapshot as today -> `/ws` -> Deck -> game. The Deck side doesn't change at all.

**Out of scope for this slice:** a layout editor, custom skins or colours chosen by the user, gyro/motion aiming (needs HTTPS), back grip buttons as *new* buttons (the Deck only has a virtual Xbox 360 pad), haptics, Valve logos or artwork, any server or Deck-side change.

## Tasks
Tracked as GitHub issues. Regenerate this snapshot with `gh issue list --state all`.

| Issue | Task | Owner | Size | Status |
|-------|------|-------|------|--------|
| #12 | Let the phone have more than one controller layout | - | M | open |
| #13 | Add a button to switch layouts on the phone | - | M | open |
| #14 | Give each layout its own colours and shapes | - | S | open |
| #15 | Give the Xbox layout its new look (needs Felipe's description) | - | M | open |
| #16 | Add a trackpad control that works like a stick | - | M | open |
| #17 | Add the Steam-Controller-style layout | - | M | open |

Order: #12 first. Then #13, #14 and #16 in any order. #17 after #14 and #16; #15 after #14.

## Done: MVP slice (issues #1-#11, finished 2026-11-20)
One phone on home Wi-Fi scans a QR code and plays Overcooked in Gaming Mode as player 2 with the full Xbox layout. Path: QR -> `GET /?k=<token>` -> phone page -> `/ws` (token check) -> `protocol.py` -> `PadManager` -> `UinputBackend` -> Steam Input -> game. Played on the real Deck ("feels very responsive"); `core/scripts/smoke_e2e.py` checks the path automatically.
