// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Keep one idle process ready. Every gesture still gets an isolated helper,
// so cancelling a gesture can kill it without leaving queued close requests.
let helperPath = null;
let spareProcess = null;

function prepareSpare() {
    if (!helperPath || spareProcess)
        return;
    try {
        spareProcess = Gio.Subprocess.new([
            'python3', `${helperPath}/tab-target.py`, '--prepared',
        ], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE);
    } catch (error) {
        console.error(`Whoosh helper preparation failed: ${error}`);
    }
}

export function startTabHelper(path) {
    helperPath = path;
    prepareSpare();
}

export function stopTabHelper() {
    helperPath = null;
    spareProcess?.force_exit();
    spareProcess = null;
}

export class TabTarget {
    constructor(path, win, x, y, allowWindowClose = false) {
        this.allowWindowClose = allowWindowClose;
        const rect = win.get_buffer_rect();
        this._startRect = rect;
        const frame = win.get_frame_rect();
        const wmClass = win.get_wm_class() ?? '';
        const includeDocuments = !/chrome|chromium|firefox|brave|vivaldi|microsoft-edge|helium/i.test(wmClass);
        this._target = JSON.stringify({pid: win.get_pid(), title: win.get_title(), x, y,
            bounds: [rect, frame].map(r => ({x: r.x, y: r.y, width: r.width, height: r.height})),
            includeDocuments, appClass: wmClass, allowWindowClose,
            documentScale: global.display.get_monitor_scale(win.get_monitor())});
        // Taking the spare does no process creation on the gesture path.
        prepareSpare();
        this._process = spareProcess;
        spareProcess = null;
        if (!this._process)
            throw new Error('Whoosh accessibility helper is unavailable');
        this._cancelled = false;
        this._timeout = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 16000,
            () => { this._timeout = 0; this.cancel(); });
    }

    matchesWindow(win) {
        const rect = win.get_buffer_rect();
        return ['x', 'y', 'width', 'height'].every(key => rect[key] === this._startRect[key]);
    }

    close(callback) {
        if (this._cancelled)
            return;
        this._process.communicate_utf8_async(`${this._target}\nclose\n`, null, (process, result) => {
            if (this._cancelled)
                return;
            let outcome = 'unavailable';
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(result);
                if (stderr && stdout.trim() === 'unavailable')
                    console.error(stderr.trim());
                if (process.get_successful())
                    outcome = stdout.trim();
            } catch (error) {
                console.error(`Whoosh tab close failed: ${error}`);
            }
            try {
                callback(outcome);
            } finally {
                this.cancel();
            }
        });
    }

    cancel() {
        if (this._cancelled)
            return;
        this._cancelled = true;
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        this._process.force_exit();
        prepareSpare();
    }
}
