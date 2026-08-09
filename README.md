# Whoosh

Whoosh brings two-finger, title-bar-first window gestures to GNOME Shell 50.

## Gestures

| Gesture over the title bar | Action |
|---|---|
| Two-finger swipe left | Tile left half |
| Two-finger swipe right | Tile right half |
| Two-finger swipe up | Maximize |
| Two-finger swipe down | Minimize |
| Pinch in | Close |
| Pinch out | Fullscreen |
| Left → Up | Top-left quarter |
| Left → Down | Bottom-left quarter |
| Right → Up | Top-right quarter |
| Right → Down | Bottom-right quarter |

Whoosh targets the topmost visible window under the pointer, even if it is not
focused. Actions that leave the window visible focus it afterward. Minimize and
close do not focus the window first.

Corner chaining is intentionally short: the vertical turn must begin within
300 ms of the horizontal tile recognition. This keeps ordinary up/down swipes
from being mistaken for quarter tiling.

## Architecture

libinput exposes two-finger movement as smooth scrolling rather than as a
two-finger swipe gesture. The Whoosh backend reads only the detected touchpad,
recognizes gestures, and emits action names over the system D-Bus. The GNOME
Shell extension performs the actual window operations.

Half and quarter tiling keep Mutter's `move_resize_frame()` call as the source
of truth and add a compositor-only visual overlay inspired by GNOME Shell's
native size-change animation. The overlay never freezes or owns window
geometry, and animation setup failures fall back to direct tiling.

## Install the backend

On Fedora:

```bash
sudo dnf install libinput-utils python3-gobject coreutils
cd backend
./install.sh
```

Verify:

```bash
systemctl status whoosh-backend.service
```

## Install the extension locally

```bash
gnome-extensions install --force dist/whoosh@eshanagarwal05.github.io.zip
```

Log out and back in, then:

```bash
gnome-extensions enable 'whoosh@eshanagarwal05.github.io'
```

## Updating

```bash
cd ~/Downloads/whoosh
git pull
cd backend
./install.sh
cd ..
make extension-zip
```

Then reinstall the generated extension ZIP and log out/in.

## GNOME Extensions submission

Upload only:

```text
dist/whoosh@eshanagarwal05.github.io.zip
```

That archive intentionally contains only the reviewable GNOME Shell extension.
The privileged backend is distributed separately from this repository.

## Repository

https://github.com/eshanagarwal05/whoosh

## License

GPL-3.0-or-later. See `LICENSE`.
