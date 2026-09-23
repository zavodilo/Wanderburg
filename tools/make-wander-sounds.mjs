// ============================================================================
//  Wanderburg — the whole soundtrack, synthesized from numbers
// ----------------------------------------------------------------------------
//  node tools/make-wander-sounds.mjs           writes assets/sounds/*
//  node tools/make-wander-sounds.mjs --check   exit 1 when a file differs from the generator
//
//  Nothing here is recorded and nothing has a licence: every file is an oscillator or noise
//  through an envelope, in the same spirit as the kit's tools/make-sounds.mjs. WAV PCM 16 bit
//  mono 22050 Hz — small enough for a browser game, and it decodes everywhere (no codec
//  surprises on Safari, which is why the music is WAV too and not MP3).
//
//  A LOOPED sound must not click at the seam: the noise and its envelope are periodic over the
//  loop and the filter runs one loop ahead of the part that is kept (see loopedNoise), so its
//  state at the end equals its state at the start.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'sounds');
const RATE = 22050;

// --- primitives -------------------------------------------------------------------
function noise(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x80000000 - 1; };
}
function lowpass(k) { let y = 0; return (x) => (y += k * (x - y)); }
function highpass(k) { let y = 0, prev = 0; return (x) => { const out = (1 - k) * (y + x - prev); prev = x; y = out; return out; }; }
function bandpass(f0, q) { let x1 = 0, x2 = 0, y1 = 0, y2 = 0; const w = 2 * Math.PI * f0 / RATE; const a = w / (2 * (q || 1));
    const b0 = a, b2 = -a, a0 = 1 + a + w * w / 4, a1 = 2 * (w * w / 4 - 1), a2 = 1 - a + w * w / 4;
    return (x) => { const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; }
const env = (t, a, d, hold) => {
    if (t < (hold || 0)) return Math.min(1, t / Math.max(1e-4, a));
    const tt = t - (hold || 0);
    return Math.exp(-tt / Math.max(1e-4, d));
};
const seconds = (s) => Math.round(RATE * s);
const buf = (s) => new Float64Array(seconds(s));

/** Mix several generated layers into one buffer (all the same length as the longest). */
function mix(layers) {
    let n = 0;
    for (const l of layers) n = Math.max(n, l.length);
    const out = new Float64Array(n);
    for (const l of layers) for (let i = 0; i < l.length; i++) out[i] += l[i];
    // keep it inside −1..1 without squashing the quiet parts
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0.98) for (let i = 0; i < n; i++) out[i] *= 0.98 / peak;
    return out;
}

/** A tone whose frequency slides f0 -> f1 (exponentially) over its length. */
function tone(sec, f0, f1, gain, shape, decay) {
    const n = seconds(sec), out = new Float64Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        const f = f0 * Math.pow(f1 / f0, t);
        ph += 2 * Math.PI * f / RATE;
        const s = shape === 'square' ? (Math.sin(ph) > 0 ? 1 : -1)
            : shape === 'saw' ? 2 * ((ph / (2 * Math.PI)) % 1) - 1
                : shape === 'tri' ? 2 * Math.abs(2 * ((ph / (2 * Math.PI)) % 1) - 1) - 1
                    : Math.sin(ph);
        out[i] = s * (gain == null ? 1 : gain) * Math.exp(-t * (decay == null ? 6 : decay));
    }
    return out;
}

/** Filtered noise with an exponential decay. */
function hiss(sec, cutoff, gain, seed, decay) {
    const n = seconds(sec), out = new Float64Array(n), rnd = noise(seed || 3), lp = lowpass(cutoff);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = lp(rnd()) * (gain == null ? 1 : gain) * Math.exp(-t * (decay == null ? 22 : decay));
    }
    return out;
}

/** A periodic noise loop for ambience (no click at the seam). */
function loopedNoise(sec, seed, cutoff, gain, swellHz) {
    const n = seconds(sec), out = new Float64Array(n), seq = new Float64Array(n);
    const rnd = noise(seed), lp = lowpass(cutoff);
    for (let i = 0; i < n; i++) seq[i] = rnd();
    for (let i = 0; i < 2 * n; i++) {
        const v = lp(seq[i % n]);
        if (i < n) continue;
        const t = (i - n) / RATE;
        const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * (swellHz || 0.5) * t);
        out[i - n] = v * swell * (gain == null ? 1 : gain);
    }
    return out;
}

// --- the effects --------------------------------------------------------------------
const S = {};

S['shot_small.wav'] = () => mix([
    tone(0.16, 190, 46, 0.85, 'sine', 22),
    hiss(0.13, 0.34, 0.55, 11, 34),
    tone(0.05, 900, 300, 0.16, 'square', 60)
]);
S['shot_big.wav'] = () => mix([
    tone(0.34, 140, 34, 0.95, 'sine', 12),
    hiss(0.26, 0.24, 0.6, 23, 18),
    tone(0.09, 620, 180, 0.18, 'square', 40)
]);
S['shot_rapid.wav'] = () => mix([
    tone(0.05, 420, 180, 0.5, 'square', 70),
    hiss(0.045, 0.5, 0.4, 31, 90)
]);
S['shot_arcane.wav'] = () => {
    const a = tone(0.3, 520, 1180, 0.34, 'sine', 9);
    const b = tone(0.3, 523.7, 1191, 0.3, 'sine', 9);       // a beat frequency: it "shimmers"
    const c = tone(0.18, 1560, 2400, 0.1, 'tri', 16);
    return mix([a, b, c, hiss(0.12, 0.7, 0.1, 41, 40)]);
};
S['shot_mortar.wav'] = () => mix([
    tone(0.42, 96, 30, 1, 'sine', 8),
    hiss(0.4, 0.16, 0.5, 53, 9),
    tone(0.12, 300, 90, 0.2, 'tri', 30)
]);
S['shot_flame.wav'] = () => {
    const n = seconds(0.36), out = new Float64Array(n), rnd = noise(61), bp = bandpass(900, 0.8);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = bp(rnd()) * Math.min(1, t / 0.05) * Math.exp(-t * 7) * 0.8;
    }
    return mix([out, hiss(0.3, 0.1, 0.2, 67, 12)]);
};
S['shot_tesla.wav'] = () => {
    const n = seconds(0.26), out = new Float64Array(n), rnd = noise(71);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        ph += 2 * Math.PI * (2400 - t * 5200 + rnd() * 700) / RATE;
        out[i] = (Math.sin(ph) * 0.4 + (rnd() > 0.86 ? (rnd() - 0.5) * 1.4 : 0)) * Math.exp(-t * 16) * 0.7;
    }
    return mix([out, hiss(0.16, 0.85, 0.22, 73, 30)]);
};
S['impact.wav'] = () => mix([tone(0.09, 240, 90, 0.5, 'sine', 40), hiss(0.07, 0.4, 0.3, 83, 60)]);
S['boom_small.wav'] = () => mix([
    tone(0.34, 150, 34, 0.9, 'sine', 12),
    hiss(0.3, 0.3, 0.7, 97, 14),
    tone(0.12, 400, 120, 0.2, 'square', 30)
]);
S['boom_big.wav'] = () => {
    const n = seconds(0.85), out = new Float64Array(n), rnd = noise(101), lp = lowpass(0.09);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = lp(rnd()) * Math.exp(-t * 4.2) * 0.9;
    }
    return mix([out, tone(0.7, 84, 24, 1, 'sine', 5), hiss(0.4, 0.35, 0.5, 103, 12)]);
};
S['ram.wav'] = () => {
    // a metallic clang: inharmonic partials dying at different rates
    const n = seconds(0.5), out = new Float64Array(n);
    const partials = [[1, 1], [2.31, 0.6], [3.72, 0.42], [5.11, 0.28], [7.03, 0.16]];
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        let v = 0;
        for (const [m, g] of partials) v += Math.sin(2 * Math.PI * 168 * m * t) * g * Math.exp(-t * (5 + m * 2.4));
        out[i] = v * 0.5;
    }
    return mix([out, tone(0.24, 110, 42, 0.8, 'sine', 16), hiss(0.16, 0.5, 0.35, 107, 26)]);
};
S['gulp.wav'] = () => mix([tone(0.14, 90, 260, 0.5, 'sine', 18), tone(0.1, 300, 120, 0.2, 'tri', 30)]);
S['chew.wav'] = () => {
    const n = seconds(0.18), out = new Float64Array(n), rnd = noise(109), lp = lowpass(0.12);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = lp(rnd()) * Math.exp(-t * 22) * 0.7 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 26 * t));
    }
    return out;
};
S['crumble.wav'] = () => {
    const n = seconds(0.75), out = new Float64Array(n), rnd = noise(113), lp = lowpass(0.2);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const grain = rnd() > 0.965 ? 1 : 0.25;
        out[i] = lp(rnd()) * grain * Math.exp(-t * 3.4) * 0.85;
    }
    return mix([out, tone(0.6, 70, 30, 0.5, 'sine', 5)]);
};
S['scream.wav'] = () => {
    const n = seconds(0.5), out = new Float64Array(n), rnd = noise(127), bp = bandpass(1100, 3);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const wobble = 1 + 0.22 * Math.sin(2 * Math.PI * 13 * t) + 0.1 * Math.sin(2 * Math.PI * 5.3 * t);
        out[i] = bp(rnd() * wobble) * Math.min(1, t / 0.06) * Math.exp(-t * 5) * 0.6;
    }
    return out;
};
S['knight.wav'] = () => mix([
    tone(0.22, 1500, 900, 0.24, 'tri', 18),
    tone(0.18, 2260, 1400, 0.14, 'sine', 24),
    hiss(0.1, 0.6, 0.2, 131, 40)
]);
S['hurt.wav'] = () => mix([tone(0.22, 130, 58, 0.7, 'sine', 14), hiss(0.18, 0.18, 0.3, 137, 20)]);
S['repair.wav'] = () => mix([
    tone(0.07, 900, 700, 0.3, 'square', 60),
    tone(0.05, 1500, 1100, 0.16, 'tri', 80),
    hiss(0.05, 0.6, 0.2, 139, 90)
]);
S['steam.wav'] = () => loopedNoise(2.0, 149, 0.55, 0.5, 1.3);
S['rumble.wav'] = () => {
    const base = loopedNoise(1.6, 151, 0.07, 1.0, 2.1);
    const thump = new Float64Array(base.length);
    const per = Math.round(RATE * 0.4);
    for (let i = 0; i < base.length; i++) {
        const t = (i % per) / RATE;
        thump[i] = Math.sin(2 * Math.PI * (58 - t * 30) * t) * Math.exp(-t * 22) * 0.6;
    }
    return mix([base, thump]);
};
S['tier_up.wav'] = () => {
    const notes = [261.6, 329.6, 392, 523.3];
    const layers = notes.map((f, i) => {
        const t0 = i * 0.09;
        const n = seconds(0.9), out = new Float64Array(n);
        let ph = 0;
        for (let k = 0; k < n; k++) {
            const t = k / RATE - t0;
            if (t < 0) continue;
            ph += 2 * Math.PI * f / RATE;
            out[k] = (Math.sin(ph) * 0.4 + Math.sin(ph * 2) * 0.16) * Math.min(1, t / 0.01) * Math.exp(-t * 4);
        }
        return out;
    });
    return mix(layers);
};
S['draft.wav'] = () => mix([hiss(0.34, 0.35, 0.3, 157, 10), tone(0.3, 420, 900, 0.2, 'sine', 10)]);
S['take.wav'] = () => mix([tone(0.3, 700, 1050, 0.3, 'sine', 9), tone(0.24, 1400, 2100, 0.12, 'tri', 14)]);
S['deny.wav'] = () => mix([tone(0.18, 220, 150, 0.4, 'square', 16), tone(0.16, 110, 78, 0.3, 'sine', 18)]);
S['horn.wav'] = () => {
    const n = seconds(1.5), out = new Float64Array(n);
    const f = 116, partials = [[1, 1], [2, 0.62], [3, 0.4], [4, 0.2], [5, 0.1]];
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const vib = 1 + 0.008 * Math.sin(2 * Math.PI * 5.4 * t);
        let v = 0;
        for (const [m, g] of partials) v += Math.sin(2 * Math.PI * f * m * vib * t) * g;
        const a = Math.min(1, t / 0.12) * Math.exp(-Math.max(0, t - 1.0) * 6);
        out[i] = v * 0.2 * a;
    }
    return mix([out, hiss(1.2, 0.06, 0.12, 163, 2)]);
};
S['clear.wav'] = () => {
    const notes = [392, 523.3, 659.3, 784];
    return mix(notes.map((f, i) => {
        const n = seconds(1.4), out = new Float64Array(n);
        let ph = 0;
        for (let k = 0; k < n; k++) {
            const t = k / RATE - i * 0.13;
            if (t < 0) continue;
            ph += 2 * Math.PI * f / RATE;
            out[k] = (Math.sin(ph) * 0.34 + Math.sin(ph * 2) * 0.12) * Math.min(1, t / 0.02) * Math.exp(-t * 2.6);
        }
        return out;
    }));
};
S['victory.wav'] = () => {
    const chord = [[523.3, 659.3, 784, 1046.5], [587.3, 740, 880, 1174.7]];
    const layers = [];
    chord.forEach((c, ci) => c.forEach((f, i) => {
        const n = seconds(3.2), out = new Float64Array(n);
        let ph = 0;
        for (let k = 0; k < n; k++) {
            const t = k / RATE - ci * 0.9 - i * 0.06;
            if (t < 0) continue;
            ph += 2 * Math.PI * f / RATE;
            out[k] = (Math.sin(ph) * 0.3 + Math.sin(ph * 2) * 0.1) * Math.min(1, t / 0.05) * Math.exp(-t * 1.2);
        }
        layers.push(out);
    }));
    return mix(layers);
};
S['death.wav'] = () => {
    const n = seconds(2.6), out = new Float64Array(n);
    const partials = [[1, 1], [1.5, 0.5], [2.02, 0.36], [2.7, 0.2]];
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const f = 174 * Math.exp(-t * 0.5);
        let v = 0;
        for (const [m, g] of partials) v += Math.sin(2 * Math.PI * f * m * t) * g;
        out[i] = v * 0.22 * Math.min(1, t / 0.05) * Math.exp(-t * 1.1);
    }
    return mix([out, tone(2.2, 90, 32, 0.5, 'sine', 1.4), hiss(1.6, 0.08, 0.24, 167, 2)]);
};
S['ui_click.wav'] = () => mix([tone(0.05, 1200, 900, 0.24, 'sine', 90), hiss(0.03, 0.7, 0.14, 173, 140)]);
S['ui_buy.wav'] = () => mix([tone(0.09, 880, 1320, 0.26, 'sine', 40), tone(0.14, 1320, 1760, 0.18, 'sine', 26)]);
S['ui_error.wav'] = () => mix([tone(0.16, 180, 120, 0.34, 'square', 22), hiss(0.1, 0.2, 0.14, 179, 40)]);

// --- the music ----------------------------------------------------------------------
// Four short loops: a modal drone, a plucked figure and a drum. Minor and sparse — it must
// survive an hour of repetition behind cannon fire.
const SCALES = {
    march: [0, 3, 5, 7, 10, 12, 15, 10, 7, 5, 3, 0],      // D minor pentatonic-ish
    steppe: [0, 2, 3, 7, 8, 10, 8, 7, 3, 2, 0, -2],
    frost: [0, 5, 7, 12, 10, 7, 5, 3, 5, 7, 12, 14],
    boss: [0, 1, 6, 7, 12, 13, 12, 7, 6, 1, 0, -5],
    menu: [0, 7, 12, 10, 7, 3, 5, 7, 3, 0, -2, 0]
};

function pluck(freq, sec, gain, seed) {
    const n = seconds(sec), out = new Float64Array(n), rnd = noise(seed);
    // Karplus-Strong: a burst of noise through a delay line — a plucked string, cheap and warm
    const delay = Math.max(2, Math.round(RATE / freq));
    const line = new Float64Array(delay);
    for (let i = 0; i < delay; i++) line[i] = rnd();
    for (let i = 0; i < n; i++) {
        const idx = i % delay;
        const next = (i + 1) % delay;
        line[idx] = 0.496 * (line[idx] + line[next]);
        out[i] = line[idx] * (gain == null ? 0.5 : gain) * Math.exp(-(i / RATE) * 1.6);
    }
    return out;
}

function drum(sec, freq, gain, seed) {
    const n = seconds(sec), out = new Float64Array(n), rnd = noise(seed), lp = lowpass(0.3);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = (Math.sin(2 * Math.PI * freq * Math.exp(-t * 6) * t) * 0.9 + lp(rnd()) * 0.25) *
            Math.exp(-t * 9) * (gain == null ? 0.6 : gain);
    }
    return out;
}

function drone(freq, sec, gain) {
    const n = seconds(sec), out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const swell = 0.72 + 0.28 * Math.sin(2 * Math.PI * t / sec);     // periodic over the loop
        out[i] = (Math.sin(2 * Math.PI * freq * t) * 0.5 +
            Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.22 +
            Math.sin(2 * Math.PI * freq * 2.003 * t) * 0.16) * swell * (gain == null ? 0.16 : gain);
    }
    return out;
}

function music(kind) {
    const sec = 12;
    const n = seconds(sec);
    const root = kind === 'boss' ? 73.4 : kind === 'frost' ? 87.3 : kind === 'steppe' ? 82.4 : 98;
    const scale = SCALES[kind] || SCALES.march;
    const layers = [];
    layers.push(drone(root, sec, kind === 'boss' ? 0.2 : 0.14));
    layers.push(drone(root * 1.5, sec, 0.07));
    // the plucked figure: one note per beat, from the scale, wrapped over the loop
    const beats = 32;
    for (let b = 0; b < beats; b++) {
        const step = scale[b % scale.length];
        const f = root * 2 * Math.pow(2, step / 12);
        const t0 = (b / beats) * sec;
        const note = pluck(f, 1.6, kind === 'boss' ? 0.3 : 0.26, 1000 + b * 17);
        const track = new Float64Array(n);
        const off = Math.round(t0 * RATE);
        for (let i = 0; i < note.length && off + i < n; i++) track[off + i] += note[i];
        layers.push(track);
    }
    // percussion: a drum on every 4th beat, harder in the boss theme
    const hits = kind === 'boss' ? 2 : 4;
    for (let b = 0; b < beats; b += hits) {
        const t0 = (b / beats) * sec;
        const d = drum(0.5, kind === 'boss' ? 62 : 78, kind === 'boss' ? 0.55 : 0.34, 2000 + b);
        const track = new Float64Array(n);
        const off = Math.round(t0 * RATE);
        for (let i = 0; i < d.length && off + i < n; i++) track[off + i] += d[i];
        layers.push(track);
    }
    // a wind bed under the whole loop (periodic, so it loops without a click)
    layers.push(loopedNoise(sec, kind === 'frost' ? 7 : 5, kind === 'boss' ? 0.05 : 0.09, kind === 'boss' ? 0.34 : 0.2, 1 / sec * 2));
    return mix(layers);
}

S['music_menu.wav'] = () => music('menu');
S['music_march.wav'] = () => music('march');
S['music_steppe.wav'] = () => music('steppe');
S['music_frost.wav'] = () => music('frost');
S['music_boss.wav'] = () => music('boss');

// --- WAV container ------------------------------------------------------------------
function writeWav(samples) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8, 'latin1');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);           // PCM
    head.writeUInt16LE(1, 22);           // mono
    head.writeUInt32LE(RATE, 24);
    head.writeUInt32LE(RATE * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'latin1');
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
}

/** File name -> bytes. Only what this tool owns; other files in assets/sounds are left alone. */
export function buildSounds() {
    const out = {};
    for (const [name, gen] of Object.entries(S)) out[name] = writeWav(gen());
    return out;
}

export { OUT_DIR, RATE, S };

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
    const sounds = buildSounds(), check = process.argv.includes('--check');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let differs = false, total = 0;
    for (const [name, bytes] of Object.entries(sounds)) {
        const file = path.join(OUT_DIR, name);
        total += bytes.length;
        if (check) {
            const same = fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
            if (!same) { console.log(name + ' differs from the generator'); differs = true; }
        } else {
            fs.writeFileSync(file, bytes);
            console.log(`  ${name.padEnd(22)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KB  ${(((bytes.length - 44) / 2 / RATE)).toFixed(2)} s`);
        }
    }
    if (check) {
        console.log(differs ? 'make-wander-sounds: files differ — re-run the tool' : 'make-wander-sounds: ok (' + Object.keys(sounds).length + ' files)');
        process.exit(differs ? 1 : 0);
    }
    console.log('make-wander-sounds: ' + Object.keys(sounds).length + ' files, ' + (total / 1048576).toFixed(2) + ' MB');
}
