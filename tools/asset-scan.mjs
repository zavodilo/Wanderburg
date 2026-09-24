// ============================================================================
//  Asset reference scanner. Single source of truth for dev-server and build.
// ----------------------------------------------------------------------------
//  The project has no build step and no manifest: asset paths live as string
//  literals in .js and in the CSS inside index.html. The scanner collects them all,
//  checks them against the disk and also shows what lies on disk as dead weight.
//
//  IMPORTANT: a path assembled from pieces ('assets/' + key + '.png') will NOT be
//  seen by the scanner. Add such places to EXTRA_REFS below by hand.
//
//  A reference to a FOLDER does not count as an asset: the code assembles the files
//  inside it from pieces. Such references are returned separately (dirs) and produce
//  neither "missing asset" nor "used".
// ============================================================================
import fsp from 'node:fs/promises';
import path from 'node:path';

// Paths that cannot be picked up as a literal. Empty for now — all references are literal.
export const EXTRA_REFS = [];

// Files needed in the build that are not "assets". A new <script> in
// index.html = a new line here, otherwise the file will not get into the archive.
export const CODE_FILES = [
  'index.html',
  // keep in sync with the <script> order in index.html
  'js/Constants.js', 'js/GameSpec.js', 'js/Objects.js', 'js/UILayout.js',
  'js/engine/Sound3D.js', 'js/engine/World3D.js', 'js/engine/Terrain3D.js', 'js/engine/CameraControl.js',
  'js/engine/Model3D.js', 'js/engine/Gltf3D.js', 'js/engine/Location3D.js', 'js/engine/Procedural3D.js',
  'js/engine/Debug3D.js', 'js/engine/Sprite2D.js', 'js/engine/Camera3D.js', 'js/engine/Lighting3D.js',
  'js/engine/Visual3D.js',
  'js/core/SceneSchema.js', 'js/presentation/RenderProfiles.js', 'js/presentation/Variants.js',
  'js/core/Coords.js', 'js/core/Entity.js', 'js/core/World.js', 'js/core/GameModel.js',
  'js/core/Input.js', 'js/core/GameAudio.js', 'js/core/Save.js',
  'js/presentation/AssetRegistry.js', 'js/presentation/Variant.js', 'js/presentation/RenderProfile.js',
  'js/presentation/Camera.js', 'js/presentation/Lighting.js', 'js/presentation/Animation.js',
  'js/presentation/VisualEntity.js', 'js/presentation/Migration.js', 'js/presentation/Runtime.js',
  'js/profiles/2d/profile.js', 'js/profiles/2.5d/profile.js', 'js/profiles/isometric3d/profile.js',
  'js/profiles/lowpoly3d/profile.js', 'js/profiles/full3d/profile.js',
  'js/UI.js', 'js/core/SceneAPI.js', 'js/Game.js', 'js/main.js',
  'libs/simplex-noise.js', 'libs/playcanvas.min.js',
];

// What definitely does not go into the build.
export const BUILD_EXCLUDE = [
  'tools', 'build', 'dist', '.git', '.claude', 'claude', '_utils', 'tests',
  'CLAUDE.md', 'run.bat', 'build.bat', 'check.bat', 'upload.bat', 'editor.bat', 'README.md', 'tsconfig.json', 'globals.d.ts',
  'scaffold', 'package.json', 'NOTICE', 'ROADMAP.md', 'STARTER.md',
];

const SCAN_EXT = new Set(['.js', '.html', '.css']);

// Asset literals are CODE, not prose: a path inside a comment is a documentation example, and
// counting it as a reference drags dead art into every player archive (the kit's own header
// example Scene.spawn('assets/models/mill.fbx', …) shipped mill.fbx — 338 KB — with every
// scaffolded game that never loads a model). String-aware stripper: quotes win over slashes,
// so 'https://…' inside a literal survives and a quoted path inside a comment does not.
function stripComments(text) {
  let out = '', i = 0, quote = null, line = null;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (line === 'block') {
      if (c === '*' && d === '/') { line = null; i += 2; } else i++;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += d || ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { line = 'block'; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

async function walk(dir, root, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (BUILD_EXCLUDE.includes(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * @returns {{refs:string[], missing:string[], onDisk:string[], unused:string[]}}
 *   refs    — assets/... paths referenced by the code (normalized, without ?v=)
 *   missing — those of refs that are not on disk  (future 404s)
 *   onDisk  — everything physically present in assets/
 *   unused  — is on disk, but no reference leads to it  (dead weight of the archive)
 */
export async function collectRefs(root) {
  const all = await walk(root, root);

  // 1) extract the literals
  const refs = new Set(EXTRA_REFS);
  const rx = /['"`]\s*(assets\/[^'"`)\s]+?)\s*['"`)]/g;
  for (const rel of all) {
    if (!SCAN_EXT.has(path.extname(rel).toLowerCase())) continue;
    if (rel.startsWith('libs/')) continue;           // third-party libraries are left alone
    const text = stripComments(await fsp.readFile(path.join(root, rel), 'utf8'));
    for (const m of text.matchAll(rx)) {
      refs.add(m[1].split('?')[0].split('#')[0]);
    }
  }

  const onDisk  = all.filter(f => f.startsWith('assets/')).sort();
  const diskSet = new Set(onDisk);

  // Folders are not assets (see the header): taken out of refs so they do not count as missing.
  const dirs = [];
  const fileRefs = [];
  for (const r of [...refs].sort()) {
    const clean = r.replace(/\/+$/, '');
    // A trailing slash is a folder reference BY SYNTAX, whether or not the folder exists yet:
    // the code assembles the files inside it from pieces, and the pipeline creates the folder
    // when it writes placeholders (Migration.VISUAL_DIR = 'assets/visual/'). Treating an absent
    // folder as a missing FILE reported a 404 that can never happen.
    let isDir = clean !== r;
    if (!isDir) {
      try { isDir = (await fsp.stat(path.join(root, clean))).isDirectory(); } catch { /* not on disk — the regular check below */ }
    }
    if (isDir) { dirs.push(clean); refs.delete(r); } else fileRefs.push(r);
  }

  return {
    refs: fileRefs,
    missing: fileRefs.filter(r => !diskSet.has(r)),
    onDisk,
    unused: onDisk.filter(f => !refs.has(f)),
    dirs,
    allFiles: all,
  };
}

export async function sizeOf(root, rel) {
  try { return (await fsp.stat(path.join(root, rel))).size; } catch { return 0; }
}

export const human = b =>
  b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB'
  : b >= 1024   ? (b / 1024).toFixed(1) + ' KB'
  : b + ' B';
