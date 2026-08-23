#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Eshan Agarwal

"""Transparent touchpad proxy used by Whoosh for selective gesture suppression."""

import argparse
import math
import os
import re
import select
import shutil
import subprocess
import sys
import time

from evdev import InputDevice, UInput, ecodes

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

OBJECT_PATH = "/io/github/eshanagarwal05/Whoosh"
INTERFACE_NAME = "io.github.eshanagarwal05.Whoosh"

DIRECTION_MM = 1.5
DOMINANCE = 1.10
PINCH_IN_TRANSLATION_RATIO = 3.50
PINCH_OUT_TRANSLATION_RATIO = 1.50
FIRST_CONTACT_GRACE = 0.08
FIRST_CONTACT_MOVE_MM = 0.8
DECISION_TIMEOUT = 0.12
ARM_TTL = 0.25
VIRTUAL_SETTLE_SECONDS = 2.0
BACKEND_SETTLE_SECONDS = 0.35

SENSITIVITY_PRESETS = {
    "low": {
        "action_mm": 5.5,
        "corner_mm": 6.5,
        "pinch_in_mm": 5.0,
        "pinch_out_mm": 1.5,
    },
    "normal": {
        "action_mm": 4.5,
        "corner_mm": 5.5,
        "pinch_in_mm": 4.0,
        "pinch_out_mm": 1.2,
    },
    "high": {
        "action_mm": 3.5,
        "corner_mm": 4.5,
        "pinch_in_mm": 3.0,
        "pinch_out_mm": 0.9,
    },
}

CORNER_TIMING_PRESETS = {
    "short": 0.20,
    "normal": 0.30,
    "long": 0.45,
}

PHYSICAL_BUTTONS = {
    ecodes.BTN_LEFT,
    ecodes.BTN_RIGHT,
    ecodes.BTN_MIDDLE,
}


def discover_touchpad(libinput):
    output = subprocess.check_output(
        [libinput, "list-devices"],
        stderr=subprocess.STDOUT,
        text=True,
    )

    for block in re.split(r"\n\s*\n", output):
        name = re.search(r"^Device:\s+(.+)$", block, re.MULTILINE)
        kernel = re.search(r"^Kernel:\s+(\S+)$", block, re.MULTILINE)

        if (
            name
            and kernel
            and "touchpad" in name.group(1).lower()
            and "whoosh virtual" not in name.group(1).lower()
        ):
            return kernel.group(1)

    return None


class SuppressionState:
    def __init__(self, bus, log):
        self._armed = False
        self._updated = 0.0
        self._log = log
        self._signal_id = bus.signal_subscribe(
            None,
            INTERFACE_NAME,
            "Suppression",
            OBJECT_PATH,
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_signal,
        )

    @property
    def active(self):
        return (
            self._armed
            and time.monotonic() - self._updated <= ARM_TTL
        )

    def _on_signal(
        self,
        _connection,
        _sender,
        _object_path,
        _interface_name,
        _signal_name,
        parameters,
    ):
        armed = bool(parameters.unpack()[0])

        if armed != self._armed:
            self._log(
                f"suppression {'armed' if armed else 'disarmed'}"
            )

        self._armed = armed
        self._updated = time.monotonic()


class ConfigurationState:
    def __init__(self, bus, log):
        self.sensitivity = "normal"
        self.corner_timing = "normal"
        self._log = log
        self._forwarder = None
        self._signal_id = bus.signal_subscribe(
            None,
            INTERFACE_NAME,
            "Configuration",
            OBJECT_PATH,
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_signal,
        )

    @property
    def action_mm(self):
        return SENSITIVITY_PRESETS[self.sensitivity]["action_mm"]

    @property
    def corner_mm(self):
        return SENSITIVITY_PRESETS[self.sensitivity]["corner_mm"]

    @property
    def pinch_in_mm(self):
        return SENSITIVITY_PRESETS[self.sensitivity]["pinch_in_mm"]

    @property
    def pinch_out_mm(self):
        return SENSITIVITY_PRESETS[self.sensitivity]["pinch_out_mm"]

    @property
    def corner_timeout(self):
        return CORNER_TIMING_PRESETS[self.corner_timing]

    def set_forwarder(self, forwarder):
        self._forwarder = forwarder
        self._forward()

    def _forward(self):
        if self._forwarder is not None:
            self._forwarder(self.sensitivity, self.corner_timing)

    def _on_signal(
        self,
        _connection,
        _sender,
        _object_path,
        _interface_name,
        _signal_name,
        parameters,
    ):
        sensitivity, corner_timing = parameters.unpack()

        if sensitivity not in SENSITIVITY_PRESETS:
            return
        if corner_timing not in CORNER_TIMING_PRESETS:
            return

        changed = (
            sensitivity != self.sensitivity
            or corner_timing != self.corner_timing
        )
        if not changed:
            return

        self.sensitivity = sensitivity
        self.corner_timing = corner_timing
        self._log(
            f"configuration sensitivity={sensitivity} "
            f"corner_timing={corner_timing}"
        )
        self._forward()


class TouchpadProxy:
    def __init__(
        self,
        dev,
        ui,
        suppression,
        configuration,
        send_action,
        log,
    ):
        self.dev = dev
        self.ui = ui
        self.suppression = suppression
        self.configuration = configuration
        self.send_action = send_action
        self.log = log

        xinfo = dev.absinfo(ecodes.ABS_MT_POSITION_X)
        yinfo = dev.absinfo(ecodes.ABS_MT_POSITION_Y)

        self.xres = (xinfo.resolution if xinfo else 0) or 10
        self.yres = (yinfo.resolution if yinfo else 0) or 10

        self.current_slot = 0
        self.slots = {}
        self.packet = []
        self.forward_slot = 0

        self.priming = False
        self.prime_started = 0.0
        self.prime_point = None

        self.candidate = False
        self.candidate_started = 0.0
        self.base_centroid = None
        self.base_distance = None
        self.buffered_packets = []

        self.passthrough_until_release = False

        self.suppressed = False
        self.suppression_kind = None
        self.action_emitted = False
        self.action_side = None
        self.action_time = 0.0
        self.action_y = 0.0
        self.corner_emitted = False
        self.gesture_claimed = False

    def _active_points(self):
        points = []

        for slot in self.slots.values():
            if (
                slot.get("tracking_id", -1) >= 0
                and slot.get("x") is not None
                and slot.get("y") is not None
            ):
                points.append(
                    (
                        slot["x"] / self.xres,
                        slot["y"] / self.yres,
                    )
                )

        return points

    def _active_slot_ids(self):
        return {
            slot_id
            for slot_id, slot in self.slots.items()
            if slot.get("tracking_id", -1) >= 0
        }

    def _single_point(self):
        points = self._active_points()
        return points[0] if len(points) == 1 else None

    def _geometry(self):
        points = self._active_points()

        if len(points) != 2:
            return None, None

        (x1, y1), (x2, y2) = points
        centroid = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)
        distance = math.hypot(x2 - x1, y2 - y1)
        return centroid, distance

    def _apply_state(self, events):
        for event in events:
            if event.type != ecodes.EV_ABS:
                continue

            if event.code == ecodes.ABS_MT_SLOT:
                self.current_slot = event.value
                continue

            slot = self.slots.setdefault(
                self.current_slot,
                {"tracking_id": -1, "x": None, "y": None},
            )

            if event.code == ecodes.ABS_MT_TRACKING_ID:
                slot["tracking_id"] = event.value

                if event.value < 0:
                    slot["x"] = None
                    slot["y"] = None

            elif event.code == ecodes.ABS_MT_POSITION_X:
                slot["x"] = event.value

            elif event.code == ecodes.ABS_MT_POSITION_Y:
                slot["y"] = event.value

    def _forward_packet(self, events):
        for event in events:
            if (
                event.type == ecodes.EV_ABS
                and event.code == ecodes.ABS_MT_SLOT
            ):
                self.forward_slot = event.value

            self.ui.write_event(event)

    def _replay_buffer(self):
        for events in self.buffered_packets:
            self._forward_packet(events)

        self.buffered_packets = []

    @staticmethod
    def _has_physical_button_press(events):
        return any(
            event.type == ecodes.EV_KEY
            and event.code in PHYSICAL_BUTTONS
            and event.value == 1
            for event in events
        )

    def _reset_detection(self):
        self.priming = False
        self.prime_started = 0.0
        self.prime_point = None
        self.candidate = False
        self.candidate_started = 0.0
        self.base_centroid = None
        self.base_distance = None
        self.buffered_packets = []

    def _reset_suppression(self):
        self.suppressed = False
        self.suppression_kind = None
        self.action_emitted = False
        self.action_side = None
        self.action_time = 0.0
        self.action_y = 0.0
        self.corner_emitted = False
        self._reset_detection()

    def _begin_gesture_claim(self):
        if self.gesture_claimed:
            return

        self.gesture_claimed = True
        self.send_action("gesture_claim_begin")

    def _end_gesture_claim(self):
        if not self.gesture_claimed:
            return

        self.send_action("gesture_claim_end")
        self.gesture_claimed = False

    def _fall_back_to_native(self, count):
        self._replay_buffer()
        self._reset_detection()
        self.passthrough_until_release = count > 0

    def _maybe_emit_action(self, centroid):
        if self.base_centroid is None:
            return

        now = time.monotonic()
        dx = centroid[0] - self.base_centroid[0]
        dy = centroid[1] - self.base_centroid[1]
        ax = abs(dx)
        ay = abs(dy)
        action_mm = self.configuration.action_mm

        if not self.action_emitted:
            if ax >= action_mm and ax >= ay * DOMINANCE:
                side = "left" if dx < 0 else "right"
                self.action_emitted = True
                self.action_side = side
                self.action_time = now
                self.action_y = centroid[1]

                self.send_action("scroll_begin")
                self.send_action(side)
                self.log(f"suppressed horizontal action {side}")
                return

            if ay >= action_mm and ay >= ax * DOMINANCE:
                vertical = "up" if dy < 0 else "down"
                self.action_emitted = True
                self.corner_emitted = True
                self.action_time = now

                self.send_action("scroll_begin")
                self.send_action(vertical)
                self.log(f"suppressed vertical action {vertical}")

            return

        if self.corner_emitted:
            return

        if now - self.action_time > self.configuration.corner_timeout:
            return

        corner_dy = centroid[1] - self.action_y

        if abs(corner_dy) >= self.configuration.corner_mm:
            vertical = "up" if corner_dy < 0 else "down"
            self.corner_emitted = True
            action = f"corner_{self.action_side}_{vertical}"
            self.send_action(action)
            self.log(f"suppressed corner action {action}")

    def _start_candidate(self):
        centroid, distance = self._geometry()

        if centroid is None or distance is None:
            return False

        self.priming = False
        self.prime_started = 0.0
        self.prime_point = None
        self.candidate = True
        self.candidate_started = time.monotonic()
        self.base_centroid = centroid
        self.base_distance = distance
        return True

    def _handle_candidate(self, events, count):
        self.buffered_packets.append(events)

        if count != 2:
            self._fall_back_to_native(count)
            return

        if self._has_physical_button_press(events):
            self._fall_back_to_native(count)
            return

        centroid, distance = self._geometry()

        if centroid is None or distance is None:
            self._fall_back_to_native(count)
            return

        dx = centroid[0] - self.base_centroid[0]
        dy = centroid[1] - self.base_centroid[1]
        ax = abs(dx)
        ay = abs(dy)
        pinch_change = distance - self.base_distance
        pinch_delta = abs(pinch_change)
        major_move = max(ax, ay)

        pinch_threshold = (
            self.configuration.pinch_out_mm
            if pinch_change > 0
            else self.configuration.pinch_in_mm
        )
        pinch_translation_ratio = (
            PINCH_OUT_TRANSLATION_RATIO
            if pinch_change > 0
            else PINCH_IN_TRANSLATION_RATIO
        )
        pinch_is_genuine = (
            pinch_delta >= pinch_threshold
            and pinch_delta >= major_move * pinch_translation_ratio
        )

        if pinch_is_genuine:
            action = "pinch_out" if pinch_change > 0 else "pinch_in"
            self.buffered_packets = []
            self.candidate = False
            self.suppressed = True
            self.suppression_kind = "pinch"
            self._begin_gesture_claim()
            self.send_action("pinch_begin")
            self.send_action(action)
            return

        action_mm = self.configuration.action_mm
        directional_action = (
            (ax >= action_mm and ax >= ay * DOMINANCE)
            or (ay >= action_mm and ay >= ax * DOMINANCE)
        )

        if directional_action:
            self.buffered_packets = []
            self.candidate = False
            self.suppressed = True
            self.suppression_kind = "swipe"
            self._begin_gesture_claim()
            self._maybe_emit_action(centroid)
            return

        if (
            not self.suppression.active
            or time.monotonic() - self.candidate_started > DECISION_TIMEOUT
        ):
            self._fall_back_to_native(count)

    def _handle_priming(self, events, count):
        self.buffered_packets.append(events)

        if self._has_physical_button_press(events):
            self._fall_back_to_native(count)
            return

        if count >= 2:
            if count == 2 and self._start_candidate():
                return

            self._fall_back_to_native(count)
            return

        if count == 0:
            self._fall_back_to_native(count)
            return

        point = self._single_point()
        moved = False

        if point is not None and self.prime_point is not None:
            moved = math.hypot(
                point[0] - self.prime_point[0],
                point[1] - self.prime_point[1],
            ) >= FIRST_CONTACT_MOVE_MM

        if (
            moved
            or not self.suppression.active
            or time.monotonic() - self.prime_started > FIRST_CONTACT_GRACE
        ):
            self._fall_back_to_native(count)

    def _handle_packet(self, events):
        previous_count = len(self._active_slot_ids())
        self._apply_state(events)
        count = len(self._active_slot_ids())

        if self.suppressed:
            if count == 0:
                self._reset_suppression()
                self._end_gesture_claim()
            elif self.suppression_kind != "pinch":
                centroid, _distance = self._geometry()
                if centroid is not None:
                    self._maybe_emit_action(centroid)
            return

        if self.passthrough_until_release:
            self._forward_packet(events)
            if count == 0:
                self.passthrough_until_release = False
            return

        if self.candidate:
            self._handle_candidate(events, count)
            return

        if self.priming:
            self._handle_priming(events, count)
            return

        if self.suppression.active and previous_count == 0:
            if count == 1:
                self.priming = True
                self.prime_started = time.monotonic()
                self.prime_point = self._single_point()
                self.buffered_packets = [events]
                return

            if count == 2:
                self.buffered_packets = [events]
                if self._start_candidate():
                    return
                self._fall_back_to_native(count)
                return

        self._forward_packet(events)

    def handle_event(self, event):
        self.packet.append(event)

        if (
            event.type == ecodes.EV_SYN
            and event.code == ecodes.SYN_REPORT
        ):
            events = self.packet
            self.packet = []
            self._handle_packet(events)

    def flush(self):
        if self.buffered_packets and not self.suppressed:
            self._replay_buffer()

        self.buffered_packets = []


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=None)
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()

    if os.geteuid() != 0:
        print("Whoosh input proxy must run as root.", file=sys.stderr)
        return 2

    libinput = shutil.which("libinput")

    if not libinput:
        print("Required command: libinput.", file=sys.stderr)
        return 2

    backend_path = "/usr/local/libexec/whoosh-backend.py"

    if not os.path.exists(backend_path):
        print(f"Missing backend: {backend_path}", file=sys.stderr)
        return 2

    device_path = args.device or discover_touchpad(libinput)

    if not device_path:
        print("Could not identify a real touchpad.", file=sys.stderr)
        return 3

    def log(message):
        if not args.quiet:
            print(f"[whoosh-proxy] {message}", flush=True)

    bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    suppression = SuppressionState(bus, log)
    configuration = ConfigurationState(bus, log)

    dev = InputDevice(device_path)
    ui = None
    backend = None
    grabbed = False

    try:
        ui = UInput.from_device(
            dev,
            name="Whoosh Virtual Touchpad",
            vendor=dev.info.vendor,
            product=dev.info.product,
            version=dev.info.version,
            bustype=dev.info.bustype,
            phys="whoosh/virtual-touchpad",
            input_props=dev.input_props(),
        )

        if ui.device is None:
            raise RuntimeError("Could not open virtual touchpad event device")

        virtual_path = ui.device.path
        log(f"real={device_path} virtual={virtual_path}")

        time.sleep(VIRTUAL_SETTLE_SECONDS)

        backend_command = [
            backend_path,
            "--device",
            virtual_path,
            "--proxy-actions-stdin",
        ]

        if args.quiet:
            backend_command.append("--quiet")

        backend = subprocess.Popen(
            backend_command,
            stdin=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        time.sleep(BACKEND_SETTLE_SECONDS)

        if backend.poll() is not None:
            raise RuntimeError(
                f"Whoosh gesture backend exited with {backend.returncode}"
            )

        def send_action(action):
            if backend.poll() is not None:
                raise RuntimeError("Whoosh gesture backend is not running")

            backend.stdin.write(action + "\n")
            backend.stdin.flush()

        def send_configuration(sensitivity, corner_timing):
            send_action(f"config {sensitivity} {corner_timing}")

        configuration.set_forwarder(send_configuration)

        dev.grab()
        grabbed = True

        proxy = TouchpadProxy(
            dev,
            ui,
            suppression,
            configuration,
            send_action,
            log,
        )

        log("transparent touchpad proxy active")
        context = GLib.MainContext.default()

        while True:
            while context.pending():
                context.iteration(False)

            if backend.poll() is not None:
                raise RuntimeError(
                    f"Whoosh gesture backend exited with {backend.returncode}"
                )

            readable, _, _ = select.select(
                [dev.fd],
                [],
                [],
                0.03,
            )

            if readable:
                for event in dev.read():
                    proxy.handle_event(event)

    except KeyboardInterrupt:
        pass
    finally:
        try:
            if "proxy" in locals():
                proxy.flush()
        except Exception:
            pass

        if grabbed:
            try:
                dev.ungrab()
            except OSError:
                pass

        if backend is not None and backend.poll() is None:
            backend.terminate()
            try:
                backend.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                backend.kill()

        if ui is not None:
            ui.close()

        dev.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
