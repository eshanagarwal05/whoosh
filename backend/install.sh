#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

missing=()
command -v libinput >/dev/null 2>&1 || missing+=("libinput")
command -v stdbuf >/dev/null 2>&1 || missing+=("stdbuf")
python3 -c 'import gi; gi.require_version("Gio","2.0"); from gi.repository import Gio' \
    >/dev/null 2>&1 || missing+=("python3-gobject")
python3 -c 'import evdev' >/dev/null 2>&1 || missing+=("python3-evdev")

if ((${#missing[@]})); then
    echo "Missing dependencies: ${missing[*]}"
    if command -v dnf >/dev/null 2>&1; then
        echo "On Fedora, install them with:"
        echo "  sudo dnf install libinput-utils python3-gobject coreutils python3-evdev"
    fi
    exit 1
fi

sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 \
    "$HERE/whoosh-backend.py" \
    /usr/local/libexec/whoosh-backend.py
sudo install -m 0755 \
    "$HERE/whoosh-input-proxy.py" \
    /usr/local/libexec/whoosh-input-proxy.py

sudo install -m 0644 \
    "$HERE/io.github.eshanagarwal05.Whoosh.conf" \
    /etc/dbus-1/system.d/io.github.eshanagarwal05.Whoosh.conf

sudo install -m 0644 \
    "$HERE/whoosh-backend.service" \
    /etc/systemd/system/whoosh-backend.service

sudo systemctl daemon-reload
sudo systemctl enable whoosh-backend.service
sudo systemctl restart whoosh-backend.service

echo "Whoosh proxy/backend installed and running."
