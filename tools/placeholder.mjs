// ============================================================================
//  ArcEngine — generated placeholder assets (zero dependencies)
// ----------------------------------------------------------------------------
//  A migration must never fail because production art is missing: the fallback chain ends
//  in a GENERATED placeholder. In the browser js/engine/Sprite2D.js draws one on a canvas;
//  on disk this module writes a real PNG (node:zlib only — the kit has no dependencies, and
//  neither do its tools).
//
//      writePlaceholderPng('assets/visual/2d/player.png', { color: '#d0603f', label: 'player' })
//
//  The card is a solid color with a darker border and a diagonal hatch, so a generated
//  placeholder is unmistakable in a screenshot and in the editor: replacing it with real art
//  is the last step of a migration, never a blocker for it.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// --- CRC32 (PNG chunks) -------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** '#rrggbb' | 0xrrggbb -> [r, g, b] */
export function parseColor(c) {
    if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0];
    const n = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);
    const v = Number.isFinite(n) ? n : 0x888888;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const mix = (a, b, t) => Math.round(a + (b - a) * t);
const shade = (rgb, k) => [Math.max(0, Math.min(255, mix(rgb[0], k < 0 ? 0 : 255, Math.abs(k)))),
    Math.max(0, Math.min(255, mix(rgb[1], k < 0 ? 0 : 255, Math.abs(k)))),
    Math.max(0, Math.min(255, mix(rgb[2], k < 0 ? 0 : 255, Math.abs(k))))];

/**
 * The pixels of a placeholder card.
 * opts — { width, height, color, hatch (0..1), border (px), checker (px) }
 * @returns {{ width: number, height: number, data: Buffer }} RGBA, row-major, top row first
 */
export function placeholderPixels(opts = {}) {
    const w = Math.max(8, Math.min(512, Math.round(opts.width || 64)));
    const h = Math.max(8, Math.min(512, Math.round(opts.height || 64)));
    const base = parseColor(opts.color || '#8a8f98');
    const border = Math.max(1, Math.round(opts.border != null ? opts.border : Math.min(w, h) / 16));
    const hatch = opts.hatch != null ? opts.hatch : 0.35;
    const checker = Math.max(2, Math.round(opts.checker || Math.min(w, h) / 8));
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const edge = x < border || y < border || x >= w - border || y >= h - border;
            let rgb = edge ? shade(base, -0.45) : base;
            if (!edge) {
                // a diagonal hatch: reads as "generated", not as finished art
                if (hatch > 0 && ((x + y) % 8) < Math.round(8 * hatch * 0.4)) rgb = shade(base, -0.18);
                // a checker corner, like the runtime canvas placeholder
                if (x < checker * 2 && y < checker * 2 && ((Math.floor(x / checker) + Math.floor(y / checker)) % 2 === 0)) rgb = shade(base, -0.3);
            }
            data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
            data[i + 3] = 255;
        }
    }
    return { width: w, height: h, data };
}

/** Encode RGBA pixels as a PNG buffer (no color profile, no interlace). */
export function encodePng({ width, height, data }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;      // bit depth
    ihdr[9] = 6;      // color type: RGBA
    ihdr[10] = 0;     // compression
    ihdr[11] = 0;     // filter
    ihdr[12] = 0;     // interlace
    // raw scanlines, each prefixed by its filter byte (0 — none)
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/** Write a placeholder PNG (creating the folder). Returns the relative path written. */
export function writePlaceholderPng(root, rel, opts = {}) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const png = encodePng(placeholderPixels(opts));
    fs.writeFileSync(abs, png);
    return { path: rel.split(path.sep).join('/'), bytes: png.length, width: opts.width || 64, height: opts.height || 64 };
}
