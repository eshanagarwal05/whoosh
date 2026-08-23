# Whoosh

Whoosh brings two-finger window and GNOME dash gestures to GNOME Shell 50.

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

### GNOME dash and Dash to Dock

| Gesture over a dash app | Action |
|---|---|
| Two-finger swipe up | Maximize the preferred app window |
| Two-finger swipe down | Minimize all app windows |
| Pinch in | Quit the app; force quit if it was not the active app |
| Pinch out | Open a new window in a new workspace |

Swipe up chooses a window in this order: focused, non-focused, minimized, then
a new window. Within each category, the most recently used window wins.

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

When tiling begins from a maximized or fullscreen window, Whoosh briefly guards
the requested geometry while the window's startup state settles. This prevents
a delayed maximize/configure cycle from overriding an explicit half- or
quarter-tile gesture.

## Requirements

Whoosh currently targets:

- Linux
- GNOME Shell 50
- systemd
- D-Bus
- a touchpad exposed through libinput
- Python 3 with PyGObject/Gio and `evdev`
- the `libinput` command-line tools
- GNU coreutils (`stdbuf`)

For building the extension locally, you also need Git, Make, and `zip`.

The extension metadata currently declares GNOME Shell 50 only. Other GNOME
Shell versions are not supported unless they are explicitly added and tested.

## Installation

### 1. Clone Whoosh

```bash
git clone https://github.com/eshanagarwal05/whoosh.git
cd whoosh
```

### 2. Install dependencies

Choose the command for your distribution family.

#### Fedora

```bash
sudo dnf install git make zip libinput-utils python3-gobject python3-evdev coreutils
```

#### Arch Linux, CachyOS, Manjaro, and other Arch-based distributions

```bash
sudo pacman -S --needed git make zip libinput-tools python-gobject python-evdev coreutils
```

Some Arch-based installations do not create `/etc/dbus-1/system.d` by default.
If that directory is missing, create it before running the backend installer:

```bash
sudo install -d -m 0755 /etc/dbus-1/system.d
```

#### Debian, Ubuntu, and other Debian-based distributions

```bash
sudo apt update
sudo apt install git make zip libinput-tools python3-gi python3-evdev coreutils
```

Package names vary on other distributions. The backend checks for the actual
runtime requirements before installing and reports anything that is missing.

### 3. Install the backend

From the repository root:

```bash
cd backend
./install.sh
cd ..
```

The installer copies the backend and input proxy into `/usr/local/libexec`,
installs the system D-Bus policy and systemd service, enables the service, and
starts it immediately.

Verify that the backend is running:

```bash
systemctl status whoosh-backend.service
```

For recent logs:

```bash
journalctl -u whoosh-backend.service -b --no-pager
```

### 4. Build the GNOME extension

```bash
make extension-zip
```

This creates:

```text
dist/whoosh@eshanagarwal05.github.io.zip
```

### 5. Install the extension locally

```bash
gnome-extensions install --force dist/whoosh@eshanagarwal05.github.io.zip
```

Log out and back in, then enable Whoosh:

```bash
gnome-extensions enable 'whoosh@eshanagarwal05.github.io'
```

You can confirm that GNOME sees the extension with:

```bash
gnome-extensions info 'whoosh@eshanagarwal05.github.io'
```

## Distribution support

| Platform | Support status | Notes |
|---|---|---|
| Fedora with GNOME Shell 50 | Primary supported platform | Fedora package names are also shown by the backend installer when dependencies are missing. |
| Arch Linux / CachyOS / Manjaro with GNOME Shell 50 | Supported installation path | Uses Arch package names. Some systems may need the D-Bus policy directory created first. |
| Debian / Ubuntu with GNOME Shell 50 | Best-effort support | The required packages are available under Debian-style package names, but this path may receive less testing than Fedora/Arch. |
| Other systemd distributions with GNOME Shell 50 | Best effort / community support | Should be portable when the required commands and Python modules are available. Package names and filesystem defaults may differ. |
| GNOME Shell versions other than 50 | Not currently supported | The extension metadata currently declares Shell 50 only. |
| KDE Plasma, Hyprland, COSMIC, and other non-GNOME desktops | Not supported by the GNOME extension | The backend architecture may be reusable, but the current frontend depends on GNOME Shell APIs. |

Whoosh is intentionally distribution-light: the gesture backend depends on
standard Linux components rather than Fedora-specific APIs. Distribution
support mostly comes down to package names, systemd/D-Bus layout, GNOME Shell
version, and the touchpad being visible to libinput.

## Troubleshooting and support

If Whoosh does not respond to gestures, check the backend first:

```bash
systemctl status whoosh-backend.service
journalctl -u whoosh-backend.service -b --no-pager
```

Then confirm that the extension is installed and enabled:

```bash
gnome-extensions info 'whoosh@eshanagarwal05.github.io'
```

If you open a GitHub issue, please include:

- distribution and version
- GNOME Shell version (`gnome-shell --version`)
- session type (`echo $XDG_SESSION_TYPE`)
- Whoosh version or commit
- touchpad model if known
- output from `systemctl status whoosh-backend.service`
- relevant lines from `journalctl -u whoosh-backend.service -b`
- a description of the gesture you performed and what happened instead

Issues and compatibility reports are welcome at:

https://github.com/eshanagarwal05/whoosh/issues

## Updating

From your existing clone:

```bash
git pull
cd backend
./install.sh
cd ..
make extension-zip
gnome-extensions install --force dist/whoosh@eshanagarwal05.github.io.zip
```

Log out and back in after reinstalling the extension, then enable it again if
necessary:

```bash
gnome-extensions enable 'whoosh@eshanagarwal05.github.io'
```

## Uninstalling

Remove the backend:

```bash
cd backend
./uninstall.sh
cd ..
```

Remove the GNOME extension:

```bash
gnome-extensions uninstall 'whoosh@eshanagarwal05.github.io'
```

Log out and back in after removing the extension.

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
