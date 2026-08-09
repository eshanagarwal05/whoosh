#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Eshan Agarwal

"""libinput backend for Whoosh."""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

BUS_NAME = "io.github.eshanagarwal05.Whoosh"
OBJECT_PATH = "/io/github/eshanagarwal05/Whoosh"
INTERFACE_NAME = "io.github.eshanagarwal05.Whoosh"

SCROLL_THRESHOLD = 65.0
AXIS_DOMINANCE = 1.25
SCROLL_STREAM_GAP = 0.18
CORNER_VERTICAL_THRESHOLD = 50.0
PINCH_IN_THRESHOLD = 0.78
PINCH_OUT_THRESHOLD = 1.35

SCROLL_RE = re.compile(
    r"POINTER_SCROLL_FINGER.*?"
    r"vert\s+(-?\d+(?:\.\d+)?)/[^\s]*\*?\s+"
    r"horiz\s+(-?\d+(?:\.\d+)?)/"
)
PINCH_BEGIN_RE = re.compile(r"GESTURE_PINCH_BEGIN.*?\s(\d+)\s*$")
PINCH_END_RE = re.compile(r"GESTURE_PINCH_END.*?\s(\d+)(?:\s+cancelled)?\s*$")
PINCH_UPDATE_RE = re.compile(
    r"GESTURE_PINCH_UPDATE"
    r"(?:\s+\d+)?"
    r"\s+\+\S+"
    r"\s+(\d+)"
    r"\s+.*?\)"
    r"\s+([0-9]+(?:\.[0-9]+)?)"
    r"\s+@"
)


def discover_touchpad(libinput):
    output = subprocess.check_output(
        [libinput, "list-devices"],
        stderr=subprocess.STDOUT,
        text=True,
    )
    blocks = re.split(r"\n\s*\n", output)

    for block in blocks:
        device = re.search(r"^Device:\s+(.+)$", block, re.MULTILINE)
        kernel = re.search(r"^Kernel:\s+(\S+)$", block, re.MULTILINE)
        if device and kernel and "touchpad" in device.group(1).lower():
            return kernel.group(1)

    for block in blocks:
        kernel = re.search(r"^Kernel:\s+(\S+)$", block, re.MULTILINE)
        capabilities = re.search(r"^Capabilities:\s+(.+)$", block, re.MULTILINE)
        if (
            kernel
            and capabilities
            and "pointer" in capabilities.group(1)
            and "gesture" in capabilities.group(1)
            and re.search(r"^Tap-to-click:", block, re.MULTILINE)
        ):
            return kernel.group(1)

    return None


def connect_system_bus():
    connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    reply = connection.call_sync(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "RequestName",
        GLib.Variant("(su)", (BUS_NAME, 0)),
        GLib.VariantType("(u)"),
        Gio.DBusCallFlags.NONE,
        -1,
        None,
    )
    result = reply.unpack()[0]

    if result not in (1, 4):
        raise RuntimeError(f"Could not own D-Bus name {BUS_NAME}: result={result}")

    return connection


class GestureRecognizer:
    def __init__(self, bus, verbose=True):
        self.bus = bus
        self.verbose = verbose
        self.scroll_x = 0.0
        self.scroll_y = 0.0
        self.scroll_last_time = 0.0
        self.scroll_triggered = False
        self.corner_arm = None
        self.corner_y = 0.0
        self.corner_triggered = False
        self.pinch_active = False
        self.pinch_scale = 1.0

    def log(self, message):
        if self.verbose:
            print(f"[whoosh] {message}", flush=True)

    def reset_scroll(self, now=None):
        self.scroll_x = 0.0
        self.scroll_y = 0.0
        self.scroll_last_time = now or 0.0
        self.scroll_triggered = False
        self.corner_arm = None
        self.corner_y = 0.0
        self.corner_triggered = False

    def emit(self, action):
        self.bus.emit_signal(
            None,
            OBJECT_PATH,
            INTERFACE_NAME,
            "Gesture",
            GLib.Variant("(s)", (action,)),
        )
        self.log(f"ACTION {action}")

    def handle_scroll(self, dx, dy):
        now = time.monotonic()

        if self.scroll_last_time and now - self.scroll_last_time > SCROLL_STREAM_GAP:
            self.reset_scroll(now)

        self.scroll_last_time = now

        if dx == 0.0 and dy == 0.0:
            return

        if self.corner_arm and not self.corner_triggered:
            self.corner_y += dy
            if abs(self.corner_y) >= CORNER_VERTICAL_THRESHOLD:
                vertical = "up" if self.corner_y < 0 else "down"
                self.corner_triggered = True
                self.emit(f"corner_{self.corner_arm}_{vertical}")
            return

        if self.scroll_triggered:
            return

        self.scroll_x += dx
        self.scroll_y += dy
        ax = abs(self.scroll_x)
        ay = abs(self.scroll_y)

        if ax >= SCROLL_THRESHOLD and ax >= ay * AXIS_DOMINANCE:
            side = "left" if self.scroll_x < 0 else "right"
            self.scroll_triggered = True
            self.corner_arm = side
            self.corner_y = 0.0
            self.emit(side)
            return

        if ay >= SCROLL_THRESHOLD and ay >= ax * AXIS_DOMINANCE:
            self.scroll_triggered = True
            self.emit("up" if self.scroll_y < 0 else "down")

    def handle_line(self, line):
        match = SCROLL_RE.search(line)
        if match:
            self.handle_scroll(float(match.group(2)), float(match.group(1)))
            return

        match = PINCH_BEGIN_RE.search(line)
        if match:
            if int(match.group(1)) == 2:
                self.pinch_active = True
                self.pinch_scale = 1.0
                self.emit("pinch_begin")
            return

        match = PINCH_UPDATE_RE.search(line)
        if match and self.pinch_active:
            if int(match.group(1)) == 2:
                self.pinch_scale = float(match.group(2))
            return

        match = PINCH_END_RE.search(line)
        if match and self.pinch_active:
            fingers = int(match.group(1))
            scale = self.pinch_scale
            self.pinch_active = False
            self.pinch_scale = 1.0

            if fingers != 2:
                return

            if scale <= PINCH_IN_THRESHOLD:
                self.emit("pinch_in")
            elif scale >= PINCH_OUT_THRESHOLD:
                self.emit("pinch_out")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=None)
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()

    if os.geteuid() != 0:
        print("Whoosh backend must run as root.", file=sys.stderr)
        return 2

    libinput = shutil.which("libinput")
    stdbuf = shutil.which("stdbuf")

    if not libinput or not stdbuf:
        print("Required commands: libinput and stdbuf.", file=sys.stderr)
        return 2

    device = args.device or discover_touchpad(libinput)
    if not device:
        print("Could not identify a touchpad.", file=sys.stderr)
        return 3

    bus = connect_system_bus()
    recognizer = GestureRecognizer(bus, verbose=not args.quiet)
    recognizer.log(f"started device={device}")

    process = subprocess.Popen(
        [stdbuf, "-oL", "-eL", libinput, "debug-events", "--device", device],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    try:
        for line in process.stdout:
            recognizer.handle_line(line)
    except KeyboardInterrupt:
        pass
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                process.kill()

    return process.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())
