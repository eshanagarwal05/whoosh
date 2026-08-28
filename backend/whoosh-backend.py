#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Eshan Agarwal

"""libinput backend for Whoosh."""

import argparse
import os
import re
import select
import shutil
import subprocess
import sys
import threading
import time

import gi
from evdev import InputDevice, ecodes, list_devices

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

BUS_NAME = "io.github.eshanagarwal05.Whoosh"
OBJECT_PATH = "/io/github/eshanagarwal05/Whoosh"
INTERFACE_NAME = "io.github.eshanagarwal05.Whoosh"

AXIS_DOMINANCE = 1.25
SCROLL_STREAM_GAP = 0.18
OPENLOGI_DEVICE_NAME = "OpenLogi action injector"
IGNORED_MOUSE_DEVICE_NAMES = {
    "Whoosh Virtual Touchpad",
}
MOUSE_SCROLL_AXES = {
    ecodes.REL_WHEEL,
    ecodes.REL_HWHEEL,
}
MOUSE_SCROLL_DEDUP_SECONDS = 0.06

SENSITIVITY_PRESETS = {
    "low": {
        "scroll_threshold": 80.0,
        "corner_vertical_threshold": 65.0,
        "pinch_in_threshold": 0.62,
        "pinch_out_threshold": 1.38,
    },
    "normal": {
        "scroll_threshold": 65.0,
        "corner_vertical_threshold": 50.0,
        "pinch_in_threshold": 0.70,
        "pinch_out_threshold": 1.28,
    },
    "high": {
        "scroll_threshold": 50.0,
        "corner_vertical_threshold": 38.0,
        "pinch_in_threshold": 0.78,
        "pinch_out_threshold": 1.20,
    },
}

CORNER_TIMING_PRESETS = {
    "short": 0.20,
    "normal": 0.30,
    "long": 0.45,
}

PROXY_ACTIONS = {
    "gesture_claim_begin",
    "gesture_claim_end",
    "pinch_begin",
    "pinch_in",
    "pinch_out",
    "scroll_begin",
    "left",
    "right",
    "up",
    "down",
    "corner_left_up",
    "corner_left_down",
    "corner_right_up",
    "corner_right_down",
}

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
        self.corner_armed_at = 0.0
        self.corner_y = 0.0
        self.corner_triggered = False
        self.pinch_active = False
        self.pinch_scale = 1.0
        self.pinch_triggered = False
        self.sensitivity = "normal"
        self.corner_timing = "normal"
        self.apply_configuration("normal", "normal", log=False)

    def log(self, message):
        if self.verbose:
            print(f"[whoosh] {message}", flush=True)

    def apply_configuration(self, sensitivity, corner_timing, log=True):
        if sensitivity not in SENSITIVITY_PRESETS:
            return False
        if corner_timing not in CORNER_TIMING_PRESETS:
            return False

        preset = SENSITIVITY_PRESETS[sensitivity]
        self.sensitivity = sensitivity
        self.corner_timing = corner_timing
        self.scroll_threshold = preset["scroll_threshold"]
        self.corner_vertical_threshold = preset["corner_vertical_threshold"]
        self.pinch_in_threshold = preset["pinch_in_threshold"]
        self.pinch_out_threshold = preset["pinch_out_threshold"]
        self.corner_chain_timeout = CORNER_TIMING_PRESETS[corner_timing]
        self.reset_scroll()
        self.pinch_active = False
        self.pinch_scale = 1.0
        self.pinch_triggered = False

        if log:
            self.log(
                f"configuration sensitivity={sensitivity} "
                f"corner_timing={corner_timing}"
            )

        return True

    def reset_scroll(self, now=None):
        self.scroll_x = 0.0
        self.scroll_y = 0.0
        self.scroll_last_time = now or 0.0
        self.scroll_triggered = False
        self.corner_arm = None
        self.corner_armed_at = 0.0
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
        new_stream = (
            not self.scroll_last_time
            or now - self.scroll_last_time > SCROLL_STREAM_GAP
        )

        if new_stream:
            self.reset_scroll(now)

        self.scroll_last_time = now

        if dx == 0.0 and dy == 0.0:
            return

        if new_stream:
            self.emit("scroll_begin")

        if self.corner_arm and not self.corner_triggered:
            if now - self.corner_armed_at > self.corner_chain_timeout:
                self.corner_arm = None
                self.corner_armed_at = 0.0
                self.corner_y = 0.0
            else:
                self.corner_y += dy
                if abs(self.corner_y) >= self.corner_vertical_threshold:
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

        if ax >= self.scroll_threshold and ax >= ay * AXIS_DOMINANCE:
            side = "left" if self.scroll_x < 0 else "right"
            self.scroll_triggered = True
            self.corner_arm = side
            self.corner_armed_at = now
            self.corner_y = 0.0
            self.emit(side)
            return

        if ay >= self.scroll_threshold and ay >= ax * AXIS_DOMINANCE:
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
                self.pinch_triggered = False
                self.emit("pinch_begin")
            return

        match = PINCH_UPDATE_RE.search(line)
        if match and self.pinch_active:
            if int(match.group(1)) == 2:
                self.pinch_scale = float(match.group(2))

                if not self.pinch_triggered:
                    if self.pinch_scale <= self.pinch_in_threshold:
                        self.pinch_triggered = True
                        self.emit("pinch_in")
                    elif self.pinch_scale >= self.pinch_out_threshold:
                        self.pinch_triggered = True
                        self.emit("pinch_out")
            return

        match = PINCH_END_RE.search(line)
        if match and self.pinch_active:
            fingers = int(match.group(1))
            scale = self.pinch_scale
            triggered = self.pinch_triggered
            self.pinch_active = False
            self.pinch_scale = 1.0
            self.pinch_triggered = False

            if fingers != 2 or triggered:
                return

            if scale <= self.pinch_in_threshold:
                self.emit("pinch_in")
            elif scale >= self.pinch_out_threshold:
                self.emit("pinch_out")


class MouseScrollMonitor:
    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.devices = {}
        self.skipped_paths = set()
        self.last_direction = None
        self.last_direction_time = 0.0

    def log(self, message):
        self.recognizer.log(f"mouse monitor {message}")

    def _discover_devices(self):
        current_paths = set(list_devices())

        for fd, device in list(self.devices.items()):
            if device.path not in current_paths:
                self._remove_device(fd)

        self.skipped_paths.intersection_update(current_paths)
        known_paths = {device.path for device in self.devices.values()}

        for path in current_paths:
            if path in known_paths or path in self.skipped_paths:
                continue

            try:
                device = InputDevice(path)
                relative_axes = set(
                    device.capabilities().get(ecodes.EV_REL, [])
                )
            except OSError:
                continue

            if (
                device.name in IGNORED_MOUSE_DEVICE_NAMES
                or "touchpad" in device.name.lower()
                or not relative_axes.intersection(MOUSE_SCROLL_AXES)
            ):
                self.skipped_paths.add(path)
                device.close()
                continue

            self.devices[device.fd] = device
            self.log(f"watching {device.name!r} ({path})")

    def _remove_device(self, fd):
        device = self.devices.pop(fd, None)
        if device is None:
            return

        self.log(f"stopped watching {device.name!r}")
        try:
            device.close()
        except OSError:
            pass

    def _emit_scroll(self, device, event):
        if event.type != ecodes.EV_REL or event.value == 0:
            return

        if event.code == ecodes.REL_WHEEL:
            direction = "up" if event.value > 0 else "down"
        elif event.code == ecodes.REL_HWHEEL:
            direction = "right" if event.value > 0 else "left"
        else:
            return

        now = time.monotonic()
        if (
            direction == self.last_direction
            and now - self.last_direction_time <= MOUSE_SCROLL_DEDUP_SECONDS
        ):
            return

        self.last_direction = direction
        self.last_direction_time = now

        source = (
            "openlogi"
            if device.name == OPENLOGI_DEVICE_NAME
            else "mouse"
        )
        self.recognizer.emit(f"{source}_scroll_{direction}")

    def run(self):
        while True:
            self._discover_devices()

            if not self.devices:
                time.sleep(1.0)
                continue

            try:
                readable, _, _ = select.select(
                    list(self.devices),
                    [],
                    [],
                    1.0,
                )
            except (OSError, ValueError):
                for fd, device in list(self.devices.items()):
                    if not os.path.exists(device.path):
                        self._remove_device(fd)
                continue

            for fd in readable:
                device = self.devices.get(fd)
                if device is None:
                    continue

                try:
                    for event in device.read():
                        self._emit_scroll(device, event)
                except BlockingIOError:
                    continue
                except OSError:
                    self._remove_device(fd)


def start_mouse_scroll_monitor(recognizer):
    monitor = MouseScrollMonitor(recognizer)
    thread = threading.Thread(
        target=monitor.run,
        daemon=True,
        name="whoosh-mouse-scroll",
    )
    thread.start()
    return thread


def _proxy_action_reader(recognizer):
    for line in sys.stdin:
        raw = line.strip()

        if raw.startswith("config "):
            parts = raw.split()
            if len(parts) == 3:
                recognizer.apply_configuration(parts[1], parts[2])
            continue

        action = raw
        if action not in PROXY_ACTIONS:
            continue

        recognizer.emit(action)


def start_proxy_action_reader(recognizer):
    thread = threading.Thread(
        target=_proxy_action_reader,
        args=(recognizer,),
        daemon=True,
        name="whoosh-proxy-actions",
    )
    thread.start()
    return thread


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=None)
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--proxy-actions-stdin", action="store_true")
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
    start_mouse_scroll_monitor(recognizer)

    if args.proxy_actions_stdin:
        start_proxy_action_reader(recognizer)
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
