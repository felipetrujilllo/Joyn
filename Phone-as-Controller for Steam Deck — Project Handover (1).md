# Phone-as-Controller for Steam Deck — Project Handover

Nov 19, 2026 · @pipe

## Summary

A Steam Deck app that turns any phone into a game controller for local multiplayer: scan a QR code, get on-screen buttons and a joystick, and the game sees a new Xbox controller. It works offline, including on a plane, because the Deck can host its own Wi-Fi network.

- **Two halves, one install.** The Deck app is the only thing installed. It carries the phone controller page inside it and serves it when a phone scans the code.
- **No phone app.** The controller is a web page (a light PWA), so it works on iPhone and Android with nothing downloaded.
- **Target for v1:** Steam Deck (SteamOS / Linux), 2 to 4 phones, standard Xbox-style layout.
- **Inspiration:** "QR Controller" on Steam ($7.99), which uses the same scan-and-play idea.

## User experience

From a player's point of view it is scan, then play. The only difference between home and a plane is who provides the Wi-Fi.

**At home, or anywhere with shared Wi-Fi (or an iPhone hotspot with signal)**

1. Open the controller app on the Deck. It shows a QR code.
2. Scan it with the phone camera. The controller page opens with buttons and a joystick.
3. The game sees a new controller ("Player 2 connected").
4. Friends scan the same code to become players 3 and 4.

**On a plane, or anywhere without Wi-Fi**

1. Phones go into airplane mode with Wi-Fi turned back on.
2. On the Deck, press "Start hotspot". The Deck creates its own network (for example "DeckPlay").
3. The app shows two QR codes side by side: **Join** (joins the Deck's Wi-Fi) and **Play** (opens the controller).
4. Phones may say "No Internet Connection". That is expected; stay connected.
5. Scan, scan, play.

**Returning players.** "Add to Home Screen" gives the controller its own icon that opens fullscreen. On the Deck hotspot the address is usually fixed (`10.42.0.1`), so the icon works every trip: join DeckPlay, tap the icon.

## Architecture

&#91;embedded content: architecture · phone page, Deck app, virtual pads\]

The phone only sends touches; everything else (serving the page, player slots, virtual pads, the optional hotspot) lives in one Deck app.

## Key decisions

| Decision | Chosen | Why | Rejected alternative |
| --- | --- | --- | --- |
| Phone side | Web page served by the Deck (light PWA) | Nothing to install; works on iPhone and Android; friends join instantly | Native phone app (App Store friction, two codebases) |
| Connection | Wi-Fi + WebSocket | Works with any phone browser; about 10 to 30 ms on decent Wi-Fi | Bluetooth: browsers cannot act as Bluetooth controllers, and iPhones cannot at all |
| Offline network | Deck hosts its own hotspot (NetworkManager) | Works on a plane with no signal; fixed address `10.42.0.1` | iPhone Personal Hotspot: needs a cellular connection, so it fails in airplane mode or at altitude |
| HTTPS | None; plain HTTP on the local network | Self-signed certificates show a scary warning every friend must click through | Full PWA with service worker (needs HTTPS; offline caching adds little, since the controller is useless without the Deck anyway) |
| Assets | Everything bundled in the Deck app | Any file loaded from the internet would break on a plane | CDN fonts, icon packs or libraries |
| Game-facing input | Virtual Xbox controller per phone via Linux uinput | Games and Steam already understand Xbox pads | Keyboard emulation (no analog sticks, no per-player separation) |

## MVP scope

The MVP is a working version in about a day of build-and-test; polish is weeks.

**In v1**

- [ ] Deck app starts a local web server and shows a QR code with its address
- [ ] "Start hotspot" button that runs the NetworkManager hotspot command and shows a Wi-Fi join QR code
- [ ] Phone controller page: D-pad, left stick, A/B/X/Y, LB/RB, Start/Select
- [ ] Landscape lock, no zoom or scroll, "Add to Home Screen" fullscreen (manifest + meta tags)
- [ ] One virtual Xbox controller per connected phone, 2 to 4 players
- [ ] Player number shown on each phone
- [ ] Automatic reconnect when a phone screen locks or the network blips
- [ ] Clean removal of a player's virtual pad on disconnect

**Out of scope for v1**

- Layout editor, custom skins, extra controller types
- Right stick, analog triggers and gyro (candidates for v1.1)
- Windows support (ViGEmBus driver) and other platforms
- Installer, auto-update, store release
- WebRTC transport, rumble or vibration feedback

## Tech stack and protocol

Python on the Deck and plain HTML/JS on the phone keep v1 small and easy to run in Desktop Mode.

| Part | Choice | Notes |
| --- | --- | --- |
| Deck server | Python 3 + `aiohttp` (HTTP + WebSocket in one) | Installed per user (`pip install --user`) since SteamOS's system files are read-only |
| Virtual gamepads | `python-evdev` + `/dev/uinput` | Expose an Xbox 360-style pad (standard button and axis codes) so Steam and games map it |
| QR codes | `qrcode` (Python) | One for the controller URL, one in the Wi-Fi join format `WIFI:T:WPA;S:<name>;P:<password>;;` |
| Hotspot | `nmcli device wifi hotspot ssid <name> password <pw>` | Add `band bg` for 2.4 GHz if phones cannot see it; stop with `nmcli connection down Hotspot` |
| Deck UI | A small local window or a browser page on the Deck showing the QR codes and players | Must work in Desktop Mode; Gaming Mode is a stretch goal |
| Phone page | Vanilla HTML/CSS/JS, touch events, no frameworks | All files bundled; manifest + `apple-mobile-web-app-capable` for fullscreen |

**Suggested layout**

```
phonepad/
  server.py          # HTTP + WebSocket server, player slots
  gamepad.py         # uinput virtual Xbox pad per player
  hotspot.py         # start/stop the Deck hotspot via nmcli
  qr.py              # controller URL + Wi-Fi join QR codes
  web/
    index.html       # controller page
    controller.js    # touch handling, WebSocket, reconnect
    style.css
    manifest.json
    icon-192.png
  setup.sh           # uinput permission (udev rule), pip deps
  run.sh             # start everything
```

**Message protocol (phone to Deck, JSON over WebSocket)**

- `{"t":"hello","id":"<random per phone>"}`: joins or rejoins; the Deck replies `{"t":"slot","player":2}`
- `{"t":"btn","b":"A","v":1}`: button press (`v`: 1 down, 0 up)
- `{"t":"axis","a":"LX","v":-0.42}`: stick axis from -1.0 to 1.0, sent at most about 60 times a second
- `{"t":"ping"}` every 2 s: the Deck drops a player after about 6 s of silence

The random phone id lets a phone that reconnects keep its player number.

## Risks and gotchas

The riskiest part is getting games to see the virtual pads on SteamOS; test that first.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `/dev/uinput` permission on SteamOS | No virtual controllers at all | One-time `setup.sh` adds a udev rule (or run with `sudo` for the first test) |
| Steam Input grabs or remaps the new pads | Wrong buttons, or a pad not seen in-game | Use standard Xbox codes; document per-game Steam Input settings |
| Gaming Mode (gamescope) window handling | App UI may not show in Gaming Mode | Target Desktop Mode for v1; the hotspot and server keep running after switching modes |
| iPhone Safari limits | No vibration; fullscreen only via "Add to Home Screen" | Prompt users to add to Home Screen; skip rumble in v1 |
| "No internet" behavior on phones | iPhone may warn, or briefly prefer cellular | Auto-reconnect on the page; tell users to stay on DeckPlay |
| Latency on a busy hotspot | Laggy sticks | Throttle axis messages, send only changes, consider WebRTC later |
| Screen lock or app switch | Player drops mid-game | Reconnect with the same phone id to keep the slot; optional Wake Lock where supported |
| Hotspot does not persist into Gaming Mode | Phones lose the network | Test before a trip; fall back to starting it from Desktop Mode |

Airline note: most airlines allow Wi-Fi and Bluetooth in airplane mode, but a few have rules about hotspots.

## Build plan and open questions

Build in this order, so the riskiest piece (games seeing the pad) is proven before any UI work.

1. **Virtual pad test.** A script creates one uinput Xbox pad and presses A in a loop; confirm Steam and one game see it.
2. **Server + controller page.** One phone, buttons only, over home Wi-Fi.
3. **Sticks and multiple players.** Left stick and D-pad, player slots 1 to 4, reconnect with the same id.
4. **QR codes + Deck UI.** Controller URL QR and the player list.
5. **Hotspot mode.** "Start hotspot" button, Wi-Fi join QR, test with phones in airplane mode.
6. **Polish for v1.** Fullscreen and Home Screen icon, landscape lock, setup.sh, a short README.
7. **Real test.** Two or more phones in a local multiplayer game, then a dry run with no internet.

**Open questions**

- [ ] Project name (ideas: PadPocket, ScanPad, PhonePad, Joyn)
- [ ] Which local multiplayer games to use as the test set?
- [ ] Deck UI: a small native window, or a browser page on the Deck?
- [ ] Is right stick and triggers needed in v1 for the games you play?
- [ ] Personal tool only, or a public release later (affects Windows support and installer)?

**Where to build:** Claude Code on the Deck (Desktop Mode) is the best fit, since it can run the server and test with a phone immediately.
