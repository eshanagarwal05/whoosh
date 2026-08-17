#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Eshan Agarwal

"""Transparent touchpad proxy used by Whoosh for selective scroll suppression."""

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
ACTION_MM = 4.5
CORNER_MM = 4.0
DOMINANCE = 1.10
PINCH_MM = 1.2
PINCH_TRANSLATION_RATIO = 0.80
DECISION_TIMEOUT = 0.12
CORNER_TIMEOUT = 0.30
ARM_TTL = 0.25
VIRTUAL_SETTLE_SECONDS = 2.0
BACKEND_SETTLE_SECONDS = 0.35


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


class TouchpadProxy:
    def __init__(self, dev, ui, suppression, send_action, log):
        self.dev = dev
        self.ui = ui
        self.suppression = suppression
        self.send_action = send_action
        self.log = log

        xinfo = dev.absinfo(ecodes.ABS_MT_POSITION_X)
        yinfo = dev.absinfo(ecodes.ABS_MT_POSITION_Y)

        self.xres = (xinfo.resolution if xinfo else 0) or 10
        self.yres = (yinfo.resolution if yinfo else 0) or 10

        self.current_slot = 0
        self.slots = {}
        self.packet = []

        self.candidate = False
        self.candidate_started = 0.0
        self.intent_committed = False
        self.base_centroid = None
        self.base_distance = None
        self.buffered_packets = []
        self.hidden_slots = set()
        self.forward_slot = 0

        self.suppressed = False
        self.suppression_kind = None
        self.action_emitted = False
        self.action_side = None
        self.action_time = 0.0
        self.action_y = 0.0
        self.corner_emitted = False

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

    def _forward_packet_excluding_slots(self, events, hidden_slots):
        logical_slot = self.forward_slot
        emitted_slot = self.forward_slot

        for event in events:
            if (
                event.type == ecodes.EV_ABS
                and event.code == ecodes.ABS_MT_SLOT
            ):
                logical_slot = event.value
                continue

            is_mt_slot_data = (
                event.type == ecodes.EV_ABS
                and ecodes.ABS_MT_TOUCH_MAJOR
                    <= event.code
                    <= ecodes.ABS_MT_TOOL_Y
            )

            if is_mt_slot_data:
                if logical_slot in hidden_slots:
                    continue

                if emitted_slot != logical_slot:
                    self.ui.write(
                        ecodes.EV_ABS,
                        ecodes.ABS_MT_SLOT,
                        logical_slot,
                    )
                    emitted_slot = logical_slot
                    self.forward_slot = logical_slot

            self.ui.write_event(event)

    def _replay_buffer(self):
        for events in self.buffered_packets:
            self._forward_packet(events)

        self.buffered_packets = []

    def _reset_candidate(self, clear_base=True):
        self.candidate = False
        self.candidate_started = 0.0
        self.intent_committed = False
        self.buffered_packets = []
        self.hidden_slots = set()

        if clear_base:
            self.base_centroid = None
            self.base_distance = None

    def _reset_suppression(self):
        self.suppressed = False
        self.suppression_kind = None
        self.action_emitted = False
        self.action_side = None
        self.action_time = 0.0
        self.action_y = 0.0
        self.corner_emitted = False
        self.base_centroid = None
        self.base_distance = None
        self._reset_candidate(clear_base=False)

    def _maybe_emit_action(self, centroid):
        if self.base_centroid is None:
            return

        now = time.monotonic()
        dx = centroid[0] - self.base_centroid[0]
        dy = centroid[1] - self.base_centroid[1]
        ax = abs(dx)
        ay = abs(dy)

        if not self.action_emitted:
            if ax >= ACTION_MM and ax >= ay * DOMINANCE:
                side = "left" if dx < 0 else "right"
                self.action_emitted = True
                self.action_side = side
                self.action_time = now
                self.action_y = centroid[1]

                self.send_action("scroll_begin")
                self.send_action(side)
                self.log(f"suppressed horizontal action {side}")
                return

            if ay >= ACTION_MM and ay >= ax * DOMINANCE:
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

        if now - self.action_time > CORNER_TIMEOUT:
            return

        corner_dy = centroid[1] - self.action_y

        if abs(corner_dy) >= CORNER_MM:
            vertical = "up" if corner_dy < 0 else "down"
            self.corner_emitted = True
            action = f"corner_{self.action_side}_{vertical}"
            self.send_action(action)
            self.log(f"suppressed corner action {action}")

    def _handle_packet(self, events):
        previous_slots = self._active_slot_ids()
        previous_count = len(previous_slots)

        self._apply_state(events)

        current_slots = self._active_slot_ids()
        count = len(current_slots)

        if self.suppressed:
            if count < 2:
                self._forward_packet_excluding_slots(
                    events,
                    self.hidden_slots,
                )
                self._reset_suppression()
                return

            centroid, _distance = self._geometry()

            if (
                centroid is not None
                and self.suppression_kind != "pinch"
            ):
                self._maybe_emit_action(centroid)

            return

        if self.candidate:
            self.buffered_packets.append(events)

            if not self.suppression.active:
                self._replay_buffer()
                self._reset_candidate()
                return

            if count != 2:
                self._replay_buffer()
                self._reset_candidate()
                return

            centroid, distance = self._geometry()

            if centroid is None or distance is None:
                self._replay_buffer()
                self._reset_candidate()
                return

            dx = centroid[0] - self.base_centroid[0]
            dy = centroid[1] - self.base_centroid[1]
            ax = abs(dx)
            ay = abs(dy)
            pinch_change = distance - self.base_distance
            pinch_delta = abs(pinch_change)

            directional_now = (
                (ax >= DIRECTION_MM and ax >= ay * DOMINANCE) or
                (ay >= DIRECTION_MM and ay >= ax * DOMINANCE)
            )
            directional_intent = self.intent_committed or directional_now
            major_move = max(ax, ay)

            pinch_is_genuine = (
                pinch_delta >= PINCH_MM
                and (
                    not directional_intent
                    or pinch_delta >= major_move * PINCH_TRANSLATION_RATIO
                )
            )

            if pinch_is_genuine:
                action = (
                    "pinch_out"
                    if pinch_change > 0
                    else "pinch_in"
                )

                self.buffered_packets = []
                self.candidate = False
                self.suppressed = True
                self.suppression_kind = "pinch"

                self.send_action("gesture_claim_begin")
                self.send_action("pinch_begin")
                self.send_action(action)
                return

            if directional_now:
                self.intent_committed = True

            if (
                (ax >= ACTION_MM and ax >= ay * DOMINANCE) or
                (ay >= ACTION_MM and ay >= ax * DOMINANCE)
            ):
                self.buffered_packets = []
                self.candidate = False
                self.suppressed = True
                self.suppression_kind = "swipe"
                self._maybe_emit_action(centroid)
                return

            return

        if (
            self.suppression.active
            and previous_count < 2
            and count == 2
        ):
            centroid, distance = self._geometry()

            if centroid is not None and distance is not None:
                self.candidate = True
                self.candidate_started = time.monotonic()
                self.base_centroid = centroid
                self.base_distance = distance
                self.hidden_slots = current_slots - previous_slots
                self.buffered_packets = [events]
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

        dev.grab()
        grabbed = True

        proxy = TouchpadProxy(
            dev,
            ui,
            suppression,
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
