# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve the captured pointer against the target window after Shell focuses it.

Runs outside Shell so accessibility providers cannot block GNOME. Prefer a tab's
close action; otherwise verify selection before requesting a keyboard shortcut.
"""
import json
import select
import sys
import time


def children(node):
    return (node.get_child_at_index(i) for i in range(node.get_child_count()))


def is_tab(node, api, app_class=''):
    if node.get_role() == api.Role.PAGE_TAB:
        return True
    # Obsidian uses custom HTML divs rather than ARIA tab roles.
    if 'obsidian' in app_class.lower():
        classes = node.get_attributes().get('class', '').split()
        if 'workspace-tab-header' not in classes:
            return False
        parent = node.get_parent()
        for _ in range(12):
            if parent is None:
                break
            if 'mod-sidedock' in parent.get_attributes().get('class', '').split():
                return False
            parent = parent.get_parent()
        return True
    return False


def contains_point(rect, x, y):
    return rect.width > 0 and rect.height > 0 and rect.x <= x < rect.x + rect.width and rect.y <= y < rect.y + rect.height


def find_tab(root, x, y, api, include_documents=False, app_class='', document_scale=1):
    stack = [(root, False)]
    budget = 2048
    while stack:
        budget -= 1
        if budget < 0:
            raise RuntimeError('Accessibility tree exceeded search limit')
        node, in_document = stack.pop()
        role = node.get_role()
        in_document = in_document or role in (api.Role.DOCUMENT_WEB, api.Role.DOCUMENT_FRAME)
        px, py = (x * document_scale, y * document_scale) if in_document else (x, y)
        # Web content can itself contain ARIA tabs; those are not browser tabs.
        if not include_documents and role in (api.Role.DOCUMENT_WEB, api.Role.DOCUMENT_FRAME):
            continue
        component = node.get_component_iface()
        if node != root and component:
            r = component.get_extents(api.CoordType.WINDOW)
            if r.width > 0 and r.height > 0 and not contains_point(r, px, py):
                continue
        if is_tab(node, api, app_class):
            state = node.get_state_set()
            if (state.contains(api.StateType.SHOWING) and
                    contains_point(node.get_component_iface().get_extents(api.CoordType.WINDOW), px, py)):
                return node
        stack.extend((child, in_document) for child in children(node) if child is not None)
    return None


def close_tab(tab, api):
    # A failed action must never cause a fallback to closing the window.
    action = tab.get_action_iface()
    if action:
        for i in range(action.get_n_actions()):
            if action.get_action_name(i).lower() in ('close', 'dismiss'):
                return bool(action.do_action(i))
    stack = list(children(tab))
    # libadwaita puts the close button beside the page-tab, inside a
    # per-tab grouping. Never search a shared tab bar or window toolbar.
    parent = tab.get_parent()
    if parent and parent.get_role() in (api.Role.GROUPING, api.Role.PANEL):
        siblings = list(children(parent))
        peer_tabs = [n for n in siblings if n.get_role() == api.Role.PAGE_TAB]
        if len(peer_tabs) == 1 and peer_tabs[0] == tab:
            stack.extend(n for n in siblings if n != tab)
    budget = 64
    while stack and budget:
        budget -= 1
        child = stack.pop()
        if child is None:
            continue
        # Only a close button belonging to this exact tab is eligible.
        classes = child.get_attributes().get('class', '').split()
        if child.get_role() == api.Role.PUSH_BUTTON or 'workspace-tab-header-inner-close-button' in classes:
            name = child.get_name().strip().lower()
            if name == 'close' or name.startswith('close tab'):
                action = child.get_action_iface()
                if action:
                    for i in range(action.get_n_actions()):
                        if action.get_action_name(i).lower() in ('press', 'click', 'activate', 'dodefault'):
                            return bool(action.do_action(i))
        stack.extend(children(child))
    return False


def visible(node, api):
    return node.get_state_set().contains(api.StateType.SHOWING)


def select_tab(tab, api, app_class=''):
    """Select only the captured tab; never send an unfocused keyboard shortcut."""
    parent = tab.get_parent()
    selection = parent.get_selection_iface() if parent else None
    if selection:
        selection.select_child(tab.get_index_in_parent())
    else:
        action = tab.get_action_iface()
        if not action:
            return False
        for i in range(action.get_n_actions()):
            if action.get_action_name(i).lower() in ('activate', 'press', 'click', 'dodefault', 'switch'):
                if not action.do_action(i):
                    return False
                break
        else:
            return False
    for _ in range(10):
        tab.clear_cache()
        selected = tab.get_state_set().contains(api.StateType.SELECTED)
        if 'obsidian' in app_class.lower():
            selected = 'is-active' in tab.get_attributes().get('class', '').split()
        if selected:
            return True
        time.sleep(0.02)
    return False


def choose_window(candidates, title, api, bounds=None, require_active=False):
    frames = [n for n in candidates if visible(n, api) and
              n.get_role() in (api.Role.FRAME, api.Role.WINDOW, api.Role.DIALOG)]
    # Focus is supplied by Shell immediately before a close. On Wayland,
    # some providers report all screen origins as (0, 0), so position alone
    # cannot distinguish equally sized windows or Chrome profiles.
    matches = [n for n in frames if n.get_name() == title]
    if not matches:
        matches = [n for n in frames if n.get_name().startswith(title + ' - ')]
    if require_active:
        active = [n for n in matches if n.get_state_set().contains(api.StateType.ACTIVE)]
        if len(active) == 1:
            return active[0]
    if bounds and len(matches) != 1:
        sized = []
        for node in matches or frames:
            r = node.get_component_iface().get_extents(api.CoordType.WINDOW)
            if any(abs(r.width - b['width']) <= 2 and abs(r.height - b['height']) <= 2
                   for b in bounds):
                sized.append(node)
        matches = sized
    if len(matches) != 1:
        raise RuntimeError('Cannot uniquely identify the target window')
    return matches[0]


def resolve(pid, title, x, y, api, bounds=None, require_active=False, include_documents=False, app_class="", document_scale=1):
    desktop = api.get_desktop(0)
    apps = []
    for app in children(desktop):
        try:
            if app.get_process_id() == pid:
                apps.append(app)
        except Exception:
            continue  # An unrelated stale app must not break the gesture.
    if not apps:
        raise RuntimeError('Application accessibility is unavailable')
    candidates = [node for app in apps for node in children(app)]
    root = choose_window(candidates, title, api, bounds, require_active)
    if bounds:
        r = root.get_component_iface().get_extents(api.CoordType.WINDOW)
        # GTK often excludes shadows; Chromium includes them. Shell provides
        # both rectangles so coordinates use the matching coordinate space.
        choices = [b for b in bounds if abs(r.width - b['width']) <= 2 and
                   abs(r.height - b['height']) <= 2]
        if not choices:
            raise RuntimeError('Accessibility and window geometry disagree')
        x, y = x - choices[0]['x'], y - choices[0]['y']
    return find_tab(root, x, y, api, include_documents, app_class, document_scale)


def no_tab_outcome(target):
    if isinstance(target, list):
        # Legacy protocol had no frame geometry: never guess a window close.
        return 'closed'
    if 'allowWindowClose' in target:
        return 'window' if target['allowWindowClose'] else 'ignored'
    # The already-running revision-2 Shell uses this protocol until logout.
    # Match its existing title-bar zone and use its no-op success response
    # outside it, applying the safety fix immediately without a Shell reload.
    frame = target['bounds'][-1]
    on_titlebar = (frame['x'] <= target['x'] < frame['x'] + frame['width'] and
                   frame['y'] <= target['y'] < frame['y'] + min(56, frame['height']))
    return 'window' if on_titlebar else 'closed'


def main():
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    Atspi.set_timeout(300, 1000)
    if sys.argv[1] == '--prepared':
        # Establish the accessibility connection while idle, before the pinch.
        Atspi.get_desktop(0)
        line = sys.stdin.readline()
        if not line:
            return
        target = json.loads(line)
    else:
        target = json.loads(sys.argv[1])
    if sys.argv[1] != '--prepared' and not select.select([sys.stdin], [], [], 15)[0]:
        return
    if sys.stdin.readline().strip() != 'close':
        return
    if isinstance(target, list):  # Compatible with the previously loaded Shell module.
        tab = resolve(*target, Atspi)
    else:
        tab = resolve(target['pid'], target['title'], target['x'], target['y'], Atspi,
                      target['bounds'], True, target['includeDocuments'], target.get('appClass', ''), target.get('documentScale', 1))
    if tab is None:
        print(no_tab_outcome(target), flush=True)
    elif close_tab(tab, Atspi):
        print('closed', flush=True)
    elif isinstance(target, dict) and select_tab(tab, Atspi, target.get('appClass', '')):
        print('closed' if close_tab(tab, Atspi) else 'shortcut', flush=True)
    else:
        print('tab-unavailable', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('unavailable', flush=True)
        print(f'Whoosh tab lookup: {error}', file=sys.stderr)
