# Joyn

Turn your phone into a game controller for your Steam Deck.

You scan a QR code, a controller shows up on your phone, and your games see it as a normal Xbox 360
controller. No app to install on the phone, no account, no internet needed. It's built for couch
co-op: one Deck, a few friends, and the phones already in their pockets.

> **Heads up: this is alpha software.** It works (I've played Overcooked with it and it feels really
> responsive), but it's early. Setup still involves the terminal, only one phone can join right now,
> and things will change. If something breaks, please open an issue.

**Platforms:** Steam Deck (SteamOS) today. **Windows support is coming soon.**

---

## What works right now

- Scan a QR code and your phone becomes **player 2**, with the Deck's own controls as player 1
- Full Xbox layout: two sticks, A/B/X/Y, bumpers, triggers, D-pad, Start/Back/Guide, L3/R3
- Multi-touch, so you can hold a stick and press buttons at the same time
- Low latency over your home Wi-Fi
- Reconnects on its own if your phone locks or the Wi-Fi blips
- A secret code in the QR, so random people on your network can't just join
- A layout switch button (more layouts are on the way)

## What's coming

- More than one phone at a time, with the Deck approving each new player
- A proper screen on the Deck for the QR code and the player list (no more terminal)
- A Decky plugin, so you can do all of that from the Quick Access menu without leaving your game
- An offline mode where the Deck makes its own Wi-Fi hotspot (for planes and road trips)
- A one-time setup so you don't need `sudo`
- Bigger buttons, a sliding D-pad and a Steam-Controller-style layout
- **Windows support**

---

## What you need

- A Steam Deck
- A phone with a web browser (iPhone or Android, anything from the last few years)
- Both on the **same Wi-Fi network**
- A few minutes in Desktop Mode

## Setup (Steam Deck)

Everything below happens in **Desktop Mode** in the **Konsole** terminal. If typing on the Deck is a
pain (it is), you can do it all from another computer over SSH; see [Tips](#tips) below.

**1. Set a password** (skip this if you already have one). You'll need it for `sudo`.

```bash
passwd
```

**2. Download Joyn and install what it needs.**

```bash
git clone https://github.com/felipetrujilllo/Joyn.git ~/Joyn
cd ~/Joyn
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

This keeps everything inside the `Joyn` folder. Nothing gets installed system-wide, which matters on
SteamOS because its system files are read-only.

**3. Start it.**

```bash
sudo systemd-run --unit=joyn --working-directory=/home/deck/Joyn/core /home/deck/Joyn/.venv/bin/python -m phonepad
```

This runs Joyn in the background, so it keeps going when you switch to Gaming Mode. It needs `sudo`
for now because creating a virtual controller needs special permission; that goes away once the setup
step lands.

**4. Get the QR code.**

```bash
sudo journalctl -u joyn -n 40 --no-pager
```

You'll see a link like `http://192.168.1.23:8642/?k=...` and a QR code made of blocks.

**5. Connect your phone.** Scan the QR code with your phone's camera (or type the link), then turn the
phone sideways. It should say **Player 2** at the top.

**6. Play.** Switch to Gaming Mode, start a game, and press A on your phone to join.

**To stop it:**

```bash
sudo systemctl stop joyn
```

### Want it on your phone's home screen?

Once the controller is open, use your browser's **Share → Add to Home Screen** (iPhone) or **⋮ → Add
to Home screen** (Android). It opens fullscreen like an app. Your Deck's address can change, so if the
icon stops working, just scan the QR again.

---

## Tips

**Join with the Deck first.** Most games number players in the order they press a button. Press a
button on the Deck first, then on your phone, and your phone becomes player 2.

**Typing on the Deck is annoying, so use SSH.** On the Deck, run `sudo systemctl start sshd` once.
Then from your computer:

```bash
ssh deck@steamdeck.local
```

Now you can paste the commands above from your computer's keyboard. (If `steamdeck.local` doesn't
work, run `ip -4 addr` on the Deck and use its `192.168.x.x` address.)

**Ctrl+C doesn't stop it.** Joyn runs as a background service, so stop it with
`sudo systemctl stop joyn`, run on the Deck, not on your own computer. If your SSH session dropped
because the Deck went to sleep, reconnect first.

---

## Troubleshooting

**The install fails with "Failed building wheel for evdev".**
Make sure `requirements.txt` says `evdev-binary` (the pre-built version). Plain `evdev` needs files
SteamOS doesn't ship. Run `git pull` to get the latest version, then install again.

**"Cannot write to /dev/uinput".**
Joyn needs `sudo` for now. Use the exact command from step 3, or the one the error message prints.

**My phone can't open the page.**
- Check the phone and the Deck are on the same Wi-Fi (not guest Wi-Fi, which often blocks devices
  from seeing each other).
- If the address in the link looks wrong, stop Joyn and start it again with `--ip <the Deck's address>`
  added to the end of the command in step 3.

**My phone says "Invalid code: scan the QR again".**
The code changed, or the link is old. Scan the QR code from step 4 again.

**My phone became player 1 and the Deck stopped responding.**
Join with the Deck first (see Tips). If Steam still orders them wrong, open the Quick Access menu (the
"…" button) and look for the option to reorder controllers.

**Random characters get typed on the Deck while Joyn runs in Desktop Mode.**
That's Steam turning controllers into a keyboard and mouse in Desktop Mode. It's harmless, and it
stops in Gaming Mode.

---

## Trying it without a Deck

You can run Joyn on any computer to see the phone controller. It won't control a game, but every
button press is checked like the real thing:

```bash
git clone https://github.com/felipetrujilllo/Joyn.git
cd Joyn
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
PYTHONPATH=core .venv/bin/python -m phonepad --backend fake
```

Open the printed link on your phone (same Wi-Fi), or in Chrome with the device toolbar turned on
(Cmd/Ctrl+Shift+M).

## For developers

```bash
.venv/bin/python -m pytest                     # Python tests
node --test 'core/tests/js/*.test.mjs'         # phone page tests (needs Node)
.venv/bin/python core/scripts/smoke_e2e.py     # end-to-end check: fake phone -> real server -> controller
```

How it fits together:

- `core/phonepad/` is the Deck side: the server, the message checks, and the virtual controller.
- `core/phonepad/web/` is the phone page: plain HTML, CSS and JavaScript, with no framework and no build step.
- The phone sends its button state over a WebSocket. The Deck checks it and passes it to a virtual
  Xbox 360 controller through Linux's `uinput`.

---

## A note on names

Joyn isn't affiliated with Valve, Microsoft or any controller maker. "Xbox 360 controller" just
describes what your games see.
