// main.js — entry point: 3D engine -> location with objects from Objects.js -> camera ->
// UI (UILayout.js) -> game (Game.js) -> frame loop (Sound3D hears from where the camera is). window.app = { location, camera, game } —
// for the console and for game code built on top of the kit.

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
    updateLoadingProgress(40);
    if (!World3D.init(canvas)) { showBootError('3D недоступен: нет libs/playcanvas.min.js или WebGL'); return; }

    const location = new Location3D({ objects: typeof LOCATION_OBJECTS !== 'undefined' ? LOCATION_OBJECTS : [] });
    const camera = new CameraController(location.view, {
        terrain: location.terrain,
        bounds: { w: location.width, h: location.height }
    });
    camera.attach(canvas);
    UI.init(canvas);
    window.app = { location, camera, game: null };
    const game = window.app.game = new Game(window.app);
    console.log('ArcEngine: локация запущена, объектов ' + location.objects.length + '.');
    updateLoadingProgress(70);

    // The frame loop is ours (the engine draws on demand): game logic, location,
    // camera — then one World3D.renderFrame(), which steps and draws the app.
    let last = performance.now();
    let frameErrors = 0;
    const loop = () => {
        const now = performance.now(), dt = (now - last) / 1000;
        last = now;
        // A frame that throws must not take the loop with it: log the first few and keep
        // scheduling, so one bad frame is a hitch and not a dead tab.
        try {
            game.update(Math.min(0.1, dt));
            if (typeof Kit !== 'undefined') Kit._run(Math.min(0.1, dt));
            location.update(dt);
            camera.update(dt);
            Sound3D.update(camera);
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
