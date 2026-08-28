#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

sudo systemctl disable --now whoosh-backend.service 2>/dev/null || true
sudo systemctl disable --now whoosh-mouse-proxy.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/whoosh-backend.service
sudo rm -f /etc/systemd/system/whoosh-mouse-proxy.service
sudo rm -f /usr/local/libexec/whoosh-backend.py
sudo rm -f /usr/local/libexec/whoosh-input-proxy.py
sudo rm -f /usr/local/libexec/whoosh-mouse-proxy.py
sudo rm -f /etc/dbus-1/system.d/io.github.eshanagarwal05.Whoosh.conf
sudo systemctl daemon-reload

echo "Whoosh backend and mouse proxy removed."
