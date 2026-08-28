#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Eshan Agarwal

"""Reserved-button mouse gesture proxy for Whoosh."""

import os
import select
import threading
import time

import gi
from evdev import InputDevice, UInput, ecodes, list_devices

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

BUS_NAME = "io.github.eshanagarwal05.Whoosh.Mouse"
OBJECT_PATH = "/io/github/eshanagarwal05/Whoosh"
INTERFACE_NAME = "io.github.eshanagarwal05.Whoosh"

CONFIG_TTL = 3.0
SUPPRESSION_TTL = 0.25
VIRTUAL_SETTLE_SECONDS = 1.0
RETRY_SECONDS = 1.0
DIRECTION_DOMINANCE = 1.15
CORNER_THRESHOLD_RATIO = 0.85

BUTTON_CODES = {
    "primary": (ecodes.BTN_LEFT,),
    "middle": (ecodes.BTN_MIDDLE,),
    "secondary": (ecodes.BTN_RIGHT,),
    "back": (ecodes.BTN_SIDE, ecodes.BTN_BACK),
    "forward": (ecodes.BTN_EXTRA, ecodes.BTN_FORWARD),
}

SENSITIVITY_THRESHOLDS = {
    "low": 96,
    "normal": 72,
    "high": 48,
}

IGNORED_DEVICE_NAMES = (
    "openlogi",
    "touchpad",
    "virtual",
    "whoosh",
    "xwaykeyz",
)


def log(message):
    print(f"[whoosh-mouse] {message}", flush=True)


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
        raise RuntimeError(
            f"Could not own D-Bus name {BUS_NAME}: result={result}"
        )

    return connection


class ConfigurationState:
    def __init__(self, bus):
        self._lock = threading.Lock()
        self._enabled = False
        self._button = "middle"
        self._sensitivity = "normal"
        self._updated = 0.0
        self._signal_id = bus.signal_subscribe(
            None,
            INTERFACE_NAME,
            "MouseConfiguration",
            OBJECT_PATH,
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_signal,
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
        enabled, button, sensitivity = parameters.unpack()
        if button not in BUTTON_CODES:
            return
        if sensitivity not in SENSITIVITY_THRESHOLDS:
            return

        with self._lock:
            changed = (
                bool(enabled) != self._enabled
                or button != self._button
                or sensitivity != self._sensitivity
            )
            self._enabled = bool(enabled)
            self._button = button
            self._sensitivity = sensitivity
            self._updated = time.monotonic()

        if changed:
            log(
                f"configuration enabled={bool(enabled)} "
                f"button={button} sensitivity={sensitivity}"
            )

    def snapshot(self):
        with self._lock:
            enabled = (
                self._enabled
                and time.monotonic() - self._updated <= CONFIG_TTL
            )
            return enabled, self._button, self._sensitivity


class SuppressionState:
    def __init__(self, bus):
        self._lock = threading.Lock()
        self._armed = False
        self._updated = 0.0
        self._signal_id = bus.signal_subscribe(
            None,
            INTERFACE_NAME,
            "MouseSuppression",
            OBJECT_PATH,
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_signal,
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
        with self._lock:
            changed = armed != self._armed
            self._armed = armed
            self._updated = time.monotonic()

        if changed:
            log(f"suppression {'armed' if armed else 'disarmed'}")

    @property
    def active(self):
        with self._lock:
            return (
                self._armed
                and time.monotonic() - self._updated <= SUPPRESSION_TTL
            )


class GestureEmitter:
    def __init__(self, bus):
        self._bus = bus

    def emit(self, direction):
        self._bus.emit_signal(
            None,
            OBJECT_PATH,
            INTERFACE_NAME,
            "MouseGesture",
            GLib.Variant("(s)", (direction,)),
        )
        self._bus.flush_sync(None)
        log(f"ACTION {direction}")


def discover_mouse(selected_buttons):
    candidates = []

    for path in list_devices():
        try:
            device = InputDevice(path)
            capabilities = device.capabilities()
            relative = set(capabilities.get(ecodes.EV_REL, []))
            keys = set(capabilities.get(ecodes.EV_KEY, []))
        except OSError:
            continue

        name = device.name or ""
        lowered = name.lower()
        supported = (
            ecodes.REL_X in relative
            and ecodes.REL_Y in relative
            and any(button in keys for button in selected_buttons)
            and not any(token in lowered for token in IGNORED_DEVICE_NAMES)
        )

        if not supported:
            device.close()
            continue

        score = 0
        if "logitech" in lowered:
            score += 4
        if "mouse" in lowered:
            score += 2
        if ecodes.BTN_SIDE in keys and ecodes.BTN_EXTRA in keys:
            score += 1

        selected_button = next(
            button for button in selected_buttons if button in keys
        )
        candidates.append((score, path, device, selected_button))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    selected_device = candidates[0][2]
    selected_button = candidates[0][3]

    for _score, _path, device, _button in candidates[1:]:
        device.close()

    return selected_device, selected_button


class ButtonGestureProxy:
    def __init__(
        self,
        device,
        virtual_device,
        selected_button,
        configuration,
        suppression,
        emitter,
    ):
        self.device = device
        self.virtual_device = virtual_device
        self.selected_button = selected_button
        self.configuration = configuration
        self.suppression = suppression
        self.emitter = emitter
        self.packet = []
        self.active = False
        self.dx = 0
        self.dy = 0
        self.phase = "pending"
        self.side = None
        self.corner_origin_y = 0

    def _reset_gesture(self):
        self.active = False
        self.dx = 0
        self.dy = 0
        self.phase = "pending"
        self.side = None
        self.corner_origin_y = 0

    def _threshold(self):
        _enabled, _button, sensitivity = self.configuration.snapshot()
        return SENSITIVITY_THRESHOLDS.get(sensitivity, 72)

    def _recognize(self):
        threshold = self._threshold()
        abs_x = abs(self.dx)
        abs_y = abs(self.dy)

        if self.phase == "pending":
            if (
                abs_x >= threshold
                and abs_x >= abs_y * DIRECTION_DOMINANCE
            ):
                self.side = "left" if self.dx < 0 else "right"
                self.phase = "horizontal"
                self.corner_origin_y = self.dy
                self.emitter.emit(self.side)
            elif (
                abs_y >= threshold
                and abs_y >= abs_x * DIRECTION_DOMINANCE
            ):
                self.phase = "complete"
                self.emitter.emit("up" if self.dy < 0 else "down")
            return

        if self.phase != "horizontal":
            return

        corner_dy = self.dy - self.corner_origin_y
        if abs(corner_dy) < threshold * CORNER_THRESHOLD_RATIO:
            return

        self.phase = "complete"
        self.emitter.emit("up" if corner_dy < 0 else "down")

    def _handle_packet(self, events):
        forwarded = []
        released = False

        for event in events:
            selected_event = (
                event.type == ecodes.EV_KEY
                and event.code == self.selected_button
            )

            if selected_event and event.value == 1:
                if not self.active and self.suppression.active:
                    self.active = True
                    self.dx = 0
                    self.dy = 0
                    self.phase = "pending"
                    self.side = None
                    self.corner_origin_y = 0
                    log("reserved button pressed")
                    continue

            if selected_event and self.active:
                if event.value == 0:
                    released = True
                continue

            forwarded.append(event)

            if self.active and event.type == ecodes.EV_REL:
                if event.code == ecodes.REL_X:
                    self.dx += event.value
                elif event.code == ecodes.REL_Y:
                    self.dy += event.value

        if self.active:
            self._recognize()

        for event in forwarded:
            self.virtual_device.write_event(event)

        if released:
            log("reserved button released")
            self._reset_gesture()

    def handle_event(self, event):
        self.packet.append(event)
        if (
            event.type == ecodes.EV_SYN
            and event.code == ecodes.SYN_REPORT
        ):
            packet = self.packet
            self.packet = []
            self._handle_packet(packet)


class MouseProxyManager:
    def __init__(self, configuration, suppression, emitter):
        self.configuration = configuration
        self.suppression = suppression
        self.emitter = emitter

    def run(self):
        while True:
            enabled, button, _sensitivity = self.configuration.snapshot()
            if not enabled:
                time.sleep(0.1)
                continue

            selected = discover_mouse(BUTTON_CODES[button])
            if selected is None:
                log(f"no physical mouse supports button={button}; retrying")
                time.sleep(RETRY_SECONDS)
                continue

            device, selected_button = selected

            try:
                self._run_device(device, button, selected_button)
            except Exception as error:
                log(f"device session failed: {error}")
                time.sleep(RETRY_SECONDS)

    def _run_device(self, device, button, selected_button):
        virtual_device = None
        grabbed = False

        try:
            virtual_device = UInput.from_device(
                device,
                name="Whoosh Virtual Mouse",
                vendor=device.info.vendor,
                product=device.info.product,
                version=device.info.version,
                bustype=device.info.bustype,
                phys="whoosh/virtual-mouse",
                input_props=device.input_props(),
            )

            if virtual_device.device is None:
                raise RuntimeError("Could not open virtual mouse event device")

            log(
                f"physical={device.name!r} ({device.path}) "
                f"virtual={virtual_device.device.path} button={button}"
            )
            time.sleep(VIRTUAL_SETTLE_SECONDS)

            enabled, current_button, _sensitivity = (
                self.configuration.snapshot()
            )
            if not enabled or current_button != button:
                return

            device.grab()
            grabbed = True
            log("reserved-button proxy active")

            proxy = ButtonGestureProxy(
                device,
                virtual_device,
                selected_button,
                self.configuration,
                self.suppression,
                self.emitter,
            )

            while True:
                enabled, current_button, _sensitivity = (
                    self.configuration.snapshot()
                )
                if not enabled or current_button != button:
                    break

                readable, _, _ = select.select(
                    [device.fd],
                    [],
                    [],
                    0.05,
                )
                if readable:
                    for event in device.read():
                        proxy.handle_event(event)
        finally:
            if grabbed:
                try:
                    device.ungrab()
                except OSError:
                    pass

            if virtual_device is not None:
                virtual_device.close()
            device.close()
            log("reserved-button proxy stopped")


def main():
    if os.geteuid() != 0:
        print("Whoosh mouse proxy must run as root.", flush=True)
        return 2

    bus = connect_system_bus()
    configuration = ConfigurationState(bus)
    suppression = SuppressionState(bus)
    emitter = GestureEmitter(bus)
    manager = MouseProxyManager(configuration, suppression, emitter)
    thread = threading.Thread(
        target=manager.run,
        daemon=True,
        name="whoosh-mouse-proxy",
    )
    thread.start()

    log("started; waiting for GNOME Shell configuration")
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
