// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CHOICES = {
    'mouse-button': [
        ['primary', 'Left (Primary)'],
        ['middle', 'Middle'],
        ['secondary', 'Right (Secondary)'],
        ['back', 'Back'],
        ['forward', 'Forward'],
    ],
    'mouse-sensitivity': [
        ['low', 'Low'],
        ['normal', 'Normal'],
        ['high', 'High'],
    ],
    'touchpad-sensitivity': [
        ['low', 'Low'],
        ['normal', 'Normal'],
        ['high', 'High'],
    ],
    'corner-timing': [
        ['short', 'Short'],
        ['normal', 'Normal'],
        ['long', 'Long'],
    ],
    'animation-speed': [
        ['fast', 'Fast'],
        ['normal', 'Normal'],
        ['relaxed', 'Relaxed'],
    ],
};

export default class WhooshPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.search_enabled = true;
        window.set_default_size(720, 720);

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const inputGroup = new Adw.PreferencesGroup({
            title: 'Input Methods',
            description: 'Choose which Whoosh gesture systems are active.',
        });
        page.add(inputGroup);

        const touchpadRow = this._switchRow(
            settings,
            'touchpad-enabled',
            'Touchpad Gestures',
            'Two-finger swipes and pinches over supported Whoosh targets'
        );
        inputGroup.add(touchpadRow);

        const mouseRow = this._switchRow(
            settings,
            'mouse-enabled',
            'Mouse Scroll Gestures',
            'Scroll over a title bar to tile, maximize, or minimize its window'
        );
        inputGroup.add(mouseRow);

        const mouseButtonEnabledRow = this._switchRow(
            settings,
            'mouse-button-enabled',
            'Mouse Button Gestures',
            'Hold a reserved mouse button and move over a title bar'
        );
        inputGroup.add(mouseButtonEnabledRow);

        const mouseButtonRow = this._choiceRow(
            settings,
            'mouse-button',
            'Gesture Button',
            'Reserved by Whoosh over title bars; native everywhere else'
        );
        inputGroup.add(mouseButtonRow);

        settings.bind(
            'mouse-button-enabled',
            mouseButtonRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );

        const touchscreenRow = this._switchRow(
            settings,
            'touchscreen-enabled',
            'Touchscreen Title-Bar Gestures',
            'Drag and throw windows using a finger on the title bar'
        );
        inputGroup.add(touchscreenRow);

        const fourFingerRow = this._switchRow(
            settings,
            'four-finger-touchscreen-enabled',
            'Four-Finger Touchscreen Gestures',
            'Pinch inward to close or spread outward to fullscreen'
        );
        inputGroup.add(fourFingerRow);

        const areasGroup = new Adw.PreferencesGroup({
            title: 'Gesture Areas',
            description: 'Control where touchpad gestures can trigger Whoosh actions.',
        });
        page.add(areasGroup);

        const overviewRow = this._switchRow(
            settings,
            'overview-enabled',
            'GNOME Overview',
            'Use Whoosh gestures over window previews in Overview'
        );
        areasGroup.add(overviewRow);

        const dashRow = this._switchRow(
            settings,
            'dash-enabled',
            'Dash and Dash to Dock',
            'Use Whoosh gestures over application icons in the Dash'
        );
        areasGroup.add(dashRow);

        const cornerRow = this._switchRow(
            settings,
            'corner-tiling-enabled',
            'Corner Tiling',
            'Chain horizontal and vertical movement to tile into screen corners'
        );
        areasGroup.add(cornerRow);

        settings.bind(
            'touchpad-enabled',
            overviewRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );
        settings.bind(
            'touchpad-enabled',
            dashRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );

        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Behavior',
            description: 'Adjust gesture recognition and window movement.',
        });
        page.add(behaviorGroup);

        const sensitivityRow = this._choiceRow(
            settings,
            'touchpad-sensitivity',
            'Touchpad Sensitivity',
            'How much movement is required before a gesture is recognized'
        );
        behaviorGroup.add(sensitivityRow);

        const mouseSensitivityRow = this._choiceRow(
            settings,
            'mouse-sensitivity',
            'Mouse Button Sensitivity',
            'How far the pointer moves before the gesture activates'
        );
        behaviorGroup.add(mouseSensitivityRow);

        settings.bind(
            'mouse-button-enabled',
            mouseSensitivityRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );

        const cornerTimingRow = this._choiceRow(
            settings,
            'corner-timing',
            'Corner Gesture Timing',
            'How quickly the vertical turn must follow the horizontal gesture'
        );
        behaviorGroup.add(cornerTimingRow);

        settings.bind(
            'touchpad-enabled',
            sensitivityRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );
        settings.bind(
            'touchpad-enabled',
            cornerTimingRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );

        const animationsRow = this._switchRow(
            settings,
            'animations-enabled',
            'Window Animations',
            'Animate Whoosh half-screen and corner tile operations'
        );
        behaviorGroup.add(animationsRow);

        const animationSpeedRow = this._choiceRow(
            settings,
            'animation-speed',
            'Animation Speed',
            'Choose how quickly Whoosh tile animations complete'
        );
        behaviorGroup.add(animationSpeedRow);

        settings.bind(
            'animations-enabled',
            animationSpeedRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );

        const resetGroup = new Adw.PreferencesGroup();
        page.add(resetGroup);

        const resetRow = new Adw.ActionRow({
            title: 'Reset Settings',
            subtitle: 'Restore every Whoosh preference to its default value',
        });
        resetGroup.add(resetRow);

        const resetButton = new Gtk.Button({
            label: 'Reset to Defaults',
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            for (const key of settings.list_keys())
                settings.reset(key);
        });
        resetRow.add_suffix(resetButton);
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(
            key,
            row,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        return row;
    }

    _choiceRow(settings, key, title, subtitle) {
        const choices = CHOICES[key];
        const values = choices.map(([value]) => value);
        const labels = choices.map(([, label]) => label);
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(labels),
        });

        const syncFromSettings = () => {
            const selected = values.indexOf(settings.get_string(key));
            row.selected = selected >= 0 ? selected : 0;
        };

        syncFromSettings();

        row.connect('notify::selected', () => {
            const value = values[row.selected];
            if (value && settings.get_string(key) !== value)
                settings.set_string(key, value);
        });

        settings.connect(`changed::${key}`, syncFromSettings);
        return row;
    }
}
