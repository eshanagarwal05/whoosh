// SPDX-License-Identifier: GPL-3.0-or-later
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function centeredRect(r, edge, dx, dy, limits) {
    const width = edge.x ? clamp(r.width + 2 * edge.x * dx,
        limits.minWidth, limits.maxWidth) : r.width;
    const height = edge.y ? clamp(r.height + 2 * edge.y * dy,
        limits.minHeight, limits.maxHeight) : r.height;
    return {x: Math.round(r.x + (r.width - width) / 2),
        y: Math.round(r.y + (r.height - height) / 2), width, height};
}

export function sharedEdge(a, b, tolerance = 2) {
    for (const vertical of [true, false]) {
        const pos = vertical ? 'x' : 'y';
        const size = vertical ? 'width' : 'height';
        const cross = vertical ? 'y' : 'x';
        const span = vertical ? 'height' : 'width';
        const start = Math.max(a[cross], b[cross]);
        const end = Math.min(a[cross] + a[span], b[cross] + b[span]);
        if (end - start < 40)
            continue;
        for (const reverse of [false, true]) {
            const [first, second] = reverse ? [b, a] : [a, b];
            if (Math.abs(first[pos] + first[size] - second[pos]) <= tolerance)
                return {vertical, reverse, seam: (first[pos] + first[size] + second[pos]) / 2,
                    middle: (start + end) / 2};
        }
    }
    return null;
}

export function pairedRects(a, b, vertical, delta, al, bl) {
    const pos = vertical ? 'x' : 'y';
    const size = vertical ? 'width' : 'height';
    const min = vertical ? 'minWidth' : 'minHeight';
    const max = vertical ? 'maxWidth' : 'maxHeight';
    const low = Math.max(al[min] - a[size], b[size] - bl[max]);
    const high = Math.min(al[max] - a[size], b[size] - bl[min]);
    if (low > high)
        return [a, b];
    const d = Math.round(clamp(delta, low, high));
    return [{...a, [size]: a[size] + d},
        {...b, [pos]: b[pos] + d, [size]: b[size] - d}];
}

// Subtract occluding windows so an Alt input strip never covers another app.
export function visibleBorderRects(r, covered, area, pad = 8) {
    let regions = [
        {x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: 2 * pad},
        {x: r.x - pad, y: r.y + r.height - pad, width: r.width + 2 * pad, height: 2 * pad},
        {x: r.x - pad, y: r.y + pad, width: 2 * pad, height: Math.max(0, r.height - 2 * pad)},
        {x: r.x + r.width - pad, y: r.y + pad, width: 2 * pad, height: Math.max(0, r.height - 2 * pad)},
    ].map(b => {
        const x = Math.max(b.x, area.x), y = Math.max(b.y, area.y);
        return {x, y, width: Math.min(b.x + b.width, area.x + area.width) - x,
            height: Math.min(b.y + b.height, area.y + area.height) - y};
    }).filter(b => b.width > 0 && b.height > 0);
    for (const c of covered) {
        regions = regions.flatMap(b => {
            const x1 = Math.max(b.x, c.x), y1 = Math.max(b.y, c.y);
            const x2 = Math.min(b.x + b.width, c.x + c.width);
            const y2 = Math.min(b.y + b.height, c.y + c.height);
            if (x1 >= x2 || y1 >= y2)
                return [b];
            return [
                {x: b.x, y: b.y, width: b.width, height: y1 - b.y},
                {x: b.x, y: y2, width: b.width, height: b.y + b.height - y2},
                {x: b.x, y: y1, width: x1 - b.x, height: y2 - y1},
                {x: x2, y: y1, width: b.x + b.width - x2, height: y2 - y1},
            ].filter(part => part.width > 0 && part.height > 0);
        });
    }
    return regions;
}
