// main.js — entry point: engine -> location -> camera -> UI -> PRESENTATION BACKEND ->
// PlayArcRuntime (one game model, one variant of it) -> game logic -> frame loop.
//
//     World3D.init(canvas)                        the PlayCanvas backend (the only one)
//     new Location3D({ objects })                 ground + the editor's objects
//     new CameraController(view)                  camera rig
//     UI.init(canvas)                             the DOM HUD
//     Visual3D.attach({ view, location, camera }) the bridge: semantic layer <-> engine
//     PlayArcRuntime.start({ variant })           boot GAME_SPEC, pick the variant, present it
//     new Game(app)                               gameplay: semantic APIs only
//
// Which variant this tab presents comes from the URL (?project=…&variant=…), then from
// project.json's defaultVariant. Five tabs may present five variants of the SAME project:
// no copies, no branches, no file replacement — one game model, many presentations.
//
// window.app = { location, camera, game, runtime } — for the console and for game code.

function updateLoadingProgress(percent) {
    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));
    if (bar) bar.style.width = percent + '%';
}

// The loading screen goes away when the location is ready.
function hideLoader() {
    updateLoadingProgress(100);
    setTimeout(() => {
        const screen = document.getElementById('loading-screen');
        if (screen) screen.style.display = 'none';
    }, 300);
}

function showBootError(text) {
    console.error(text);
    const el = document.querySelector('.loading-text');
    if (el) el.textContent = text;
}

function startGame() {
    if (window.app) return;                 // guard against a repeated start
    if (typeof SimplexNoise === 'undefined') { showBootError('Нет libs/simplex-noise.js'); return; }
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('world3d'));
    updateLoadingProgress(30);
    if (!World3D.init(canvas)) { showBootError('3D недоступен: нет libs/playcanvas.min.js или WebGL'); return; }

    const location = new Location3D({ objects: typeof LOCATION_OBJECTS !== 'undefined' ? LOCATION_OBJECTS : [] });
    const camera = new CameraController(location.view, {
        terrain: location.terrain,
        bounds: { w: location.width, h: location.height }
    });
    camera.attach(canvas);
    UI.init(canvas);
    window.app = { location, camera, game: null, runtime: null };
    updateLoadingProgress(50);

    // The presentation backend: from here on the semantic layer can actually show things.
    Visual3D.attach({ view: location.view, location: location, camera: camera, canvas: canvas });

    // One runtime, many variants. A failure to present a variant must not kill the game:
    // PlayArcRuntime falls back to the profile defaults and reports it.
    let boot = null;
    try {
        boot = PlayArcRuntime.start({});
        window.app.runtime = boot.context;
    } catch (e) {
        showBootError('PlayArcRuntime: ' + ((e && e.message) || e));
        return;
    }
    Input.attach(window);

    const game = window.app.game = new Game(window.app);
    console.log('ArcEngine: ' + boot.context.project + ' / ' + boot.context.variant +
        ' (profile ' + boot.context.profile + '), сущностей ' + GameModel.entities.length +
        ', объектов локации ' + location.objects.length + '.');
    updateLoadingProgress(70);

    // The frame loop is ours (the engine draws on demand). Order matters: gameplay first
    // (it moves the model), then the presentation follows the model, then one render.
    let last = performance.now();
    let frameErrors = 0;
    const loop = () => {
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        // A frame that throws must not take the loop with it: log the first few and keep
        // scheduling, so one bad frame is a hitch and not a dead tab.
        try {
            game.update(dt);                                   // the game's own logic
            GameModel.run(dt);                                 // declared systems, by phase
            GameAnimation.update(dt);
            if (typeof Kit !== 'undefined') Kit._run(dt);       // agent frame hooks
            location.update(dt);                               // clips, part spin, object sounds
            camera.update(dt);
            Visual3D.update(dt, { params: Camera.params(), target: Camera.target() });
            Sound3D.update(camera);
            Input.update();                                    // press/release edges settle last
            World3D.renderFrame();
        } catch (e) {
            frameErrors++;
            if (frameErrors <= 5) console.error('Кадр ' + frameErrors + ' упал, продолжаю:', e);
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.addEventListener('resize', () => World3D.resize());
    location.ready.then(hideLoader);
}

window.onload = () => startGame();
