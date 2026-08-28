// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Eshan Agarwal

import Clutter from 'gi://Clutter';

import BaseWhooshExtension from './extension-main.js';

export default class WhooshExtension extends BaseWhooshExtension {
    _getWindowUnderPointer(px, py) {
        const sceneWindow = this._getSceneWindowAt(px, py);

        if (sceneWindow)
            return sceneWindow;

        return super._getWindowUnderPointer(px, py);
    }

    _getSceneWindowAt(px, py) {
        let actor = null;

        try {
            actor = global.stage.get_actor_at_pos(
                Clutter.PickMode.ALL,
                px,
                py
            );
        } catch (_) {
            return null;
        }

        while (actor) {
            let win = null;

            try {
                win = actor.get_meta_window?.() ??
                    actor.meta_window ??
                    actor.metaWindow ??
                    actor._delegate?.metaWindow ??
                    actor._delegate?.meta_window ??
                    null;
            } catch (_) {
                win = null;
            }

            if (win &&
                typeof win.get_frame_rect === 'function' &&
                !win.is_override_redirect()) {
                const rect = win.get_frame_rect();

                if (px >= rect.x &&
                    px < rect.x + rect.width &&
                    py >= rect.y &&
                    py < rect.y + rect.height) {
                    return win;
                }
            }

            actor = actor.get_parent?.() ?? null;
        }

        return null;
    }
}
