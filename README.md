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
| Pinch out | Move to an empty/new workspace and follow |
| Left → Up | Top-left quarter |
| Left → Down | Bottom-left quarter |
| Right → Up | Top-right quarter |
| Right → Down | Bottom-right quarter |

Whoosh targets the topmost visible window under the pointer, even if it is not
focused. Actions that leave the window visible focus it afterward. Minimize and
close do not focus the window first.

## Architecture

libinput exposes two-finger movement as smooth scrolling rather than as a
two-finger swipe gesture. The Whoosh backend reads only the detected touchpad,
recognizes gestures, and emits action names over the system D-Bus. The GNOME
Shell extension performs the actual window operations.

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
