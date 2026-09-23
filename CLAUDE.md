# ArcEngine — набор для 3D-игр в браузере

> Публичная стратегия развития (AI-native упаковка, семантический API, скаффолд) и
> лицензионная карта — в `ROADMAP.md`.

Основа для 3D-игр в браузере, заточенная под работу с Claude Code: ванильный
JS + PlayCanvas 2 (`libs/playcanvas.min.js`, локально), ноль npm-зависимостей, никакой
сборки — классические `<script>` и глобалы (`pc`). Мир движка — зеркало карты по X
(PlayCanvas левосторонний, карта правосторонняя по традиции; скилл `world3d`, §Coordinates).
Игра при запуске показывает локацию: земля с холмами, небо, свет, тени, toon-шейдер, камера,
объекты из `Objects.js` (модели FBX и GLB из `assets/models/`; GLB — со скелетом и клипами
анимации), HUD из `UILayout.js` и пример игры `Game.js`. Рядом — веб-редактор (интерфейс EN/RU): тот же мир, камеры
«свободная/игровая», toon вкл/выкл, вкладка Global Settings (все глобальные настройки,
сохранение в `Constants.js`), вкладка Objects (импорт FBX/GLB, гизмо, свойства объектов,
анимация — вращение части или клип, сохранение в `Objects.js`) и вкладка UI (раскладка
игрового интерфейса: драг и ресайз поверх вида, сохранение в `UILayout.js`).

## Скиллы — читать до правки кода

Скилл `имя` — файл `claude/skills/имя/SKILL.md`: до правки кода из таблицы прочитать его
целиком (Read). В инструменте Skill их нет — так задумано (инвариант 9).

| Задача | Скилл |
|---|---|
| `js/` (`World3D.js`, `Terrain3D.js`, `Location3D.js`, `CameraControl.js`, `Model3D.js`, `Gltf3D.js`, `Procedural3D.js`, `Objects.js`, `Game.js`, `main.js`), объекты в сцене, модели GLB и клипы анимации, свет/тени/toon/контур, константы `CAMERA_*`/`WORLD3D_*`/`TERRAIN_*`/`LOCATION_*` | `claude/skills/world3d/SKILL.md` |
| ЛЮБОЙ элемент интерфейса игры (текст, счётчик, шкала, кнопка, панель, меню): `js/UI.js`, `js/UILayout.js`, вкладка UI редактора (`ui-panel.js`), новый вид элемента | `claude/skills/ui/SKILL.md` |
| ЛЮБОЙ звук: эффект, музыка, звук объекта локации, `js/Sound3D.js`, поле `sound` в `Objects.js`, константы `AUDIO_*`, файлы в `assets/sounds` | `claude/skills/sound/SKILL.md` |
| `_utils/`, редактор, инспектор, вкладка Objects, новая константа в редакторе, текст интерфейса | `claude/skills/editor/SKILL.md` |
| `tools/`, `tests/`, ассеты, новый скрипт, архив, проверка типов и ошибки tsc | `claude/skills/build/SKILL.md` |
| своя геометрия (сетка из вершин, порт генератора, импорт glTF), материал с картой нормалей, новый источник света, свой шейдер, thin instances и процедурная расстановка; «сетка вывернута», «свет не с той стороны», пропал свет или меш | `claude/skills/render-conventions/SKILL.md` |
| проверка правки глазами и числами: панель браузера, `Debug3D` (удержание вида, кадры без rAF, замер, линтер сцены, отладочные режимы), замер цены кадра, воспроизведение состояния пользователя | `claude/skills/verify/SKILL.md` |

## Запуск и сборка

```
node tools/arc.mjs run       # игра: dev-сервер + браузер, порт 8080 (или следующий свободный)
node tools/arc.mjs editor    # редактор: http://localhost:8090/_utils/editor/
node tools/arc.mjs build     # dist/arcengine-<GAME_VERSION>.zip
node tools/arc.mjs check     # быстрый профиль; агенту — то же с [--types|--tests|--skills]
node tools/arc.mjs check --all   # релизный gate: + headless render/visual (puppeteer dev-only)
```

Обёртки над тем же CLI: Windows — `run.bat`/`editor.bat`/`check.bat`/`build.bat`,
macOS/Linux — `./run.sh`/`./editor.sh`/`./check.sh`/`./build.sh`. Серверы сами выбирают
свободный порт, печатают URL и открывают браузер кроссплатформенно.

Git: что не едет в репозиторий — `.gitignore` (`.claude/`, бэкапы редактора, `build/`, `dist/`);
`.gitattributes` — файлы едут байт в байт.

После правки кода — `node tools/check.mjs`: должно пройти. После правки геометрии, материалов,
света или шейдеров — ещё `await Debug3D.lint()` в игре (в редакторе — кнопка «Lint scene»): без ошибок.

Нужен только Node. Серверы отдают всё с `no-store` — правку `.js` видно по F5.
`python -m http.server` не использовать: браузер закэширует старый скрипт.
Панель браузера Claude Desktop читает `.claude/launch.json` (`game` — 9378, `editor` — 9377);
если его нет — скопировать `claude/launch.json`.

## Инварианты

1. **Ноль зависимостей.** Ни npm, ни CDN, ни сборки, ни внешних ресурсов. TypeScript для
   проверки берёт `npx` (кэш npm), в проект он не ставится.
2. **Порядок скриптов значим.** `Constants.js` — первый, `main.js` — последний. Новый скрипт —
   файл в `js/`, `<script src="js/…">` в `index.html` и строка в `CODE_FILES`
   (`tools/asset-scan.mjs`), иначе не попадёт в архив.
3. **Все числа — в `Constants.js`, литералами.** Редактор патчит только
   `const ИМЯ = <число>;`. Код читает константу через `typeof ИМЯ !== 'undefined'` с
   дефолтом: в игре это лексический `const`, в редакторе — свойство `window`.
4. **3D — представление.** Логика игры хранит своё состояние сама и не спрашивает у
   движка высоты или пересечения для решений, которые должны совпадать на всех
   устройствах (клетка террейна на мобильных крупнее).
5. **Объекты мира — через `World3D.addObject(view, mesh, 'actor' | 'prop')`**: группа
   материала, тень, контур и обводка. Проекции экран↔мир — только через `View3D`.
6. **Отсутствующий ассет не роняет сцену** (`Location3D.loadGround`: `onerror` -> ровный цвет).
   Пути ассетов — литералами `'assets/…'`: иначе сканер сборщика их не увидит.
7. **Хранилище — только `Store`** (`Constants.js`): в sandbox-iframe прямой
   `localStorage` бросает `SecurityError`.
8. **Код проходит проверку типов.** JS проверяется по JSDoc (`strict` без `noImplicitAny`
   и `strictNullChecks`). Объект-неймспейс `const X = { … }` — со строкой
   `/** @satisfies {Record<string, any>} */` над ним: без неё tsc не видит опечаток в `X.метод`.
   Поле, заданное `null`, — `/** @type {Тип | null} */`; DOM — приведение
   `/** @type {HTMLInputElement} */ (el)`; поля на чужих объектах и общие записи — в `globals.d.ts`.
9. **Канон всего пользовательского — пути без точки; копии для агентов генерируются.**
   Веб-загрузка на GitHub пропускает dot-имена, поэтому канон скиллов —
   `claude/skills/<имя>/SKILL.md` (новый — ещё строка в таблице скиллов), шаблон панели
   браузера — `claude/launch.json`, вендор движковых скиллов — `claude/vendor/playcanvas/`.
   Точки входа агентов (`.claude/skills/`, `.agents/skills/`, `.cursor/rules/arcengine.mdc`,
   `AGENTS.md`) генерирует `tools/sync-skills.mjs`; руками их не правят, `check.mjs` сверяет
   копии с каноном. В `.claude/` вне `skills/` — только локальное (`settings.local.json`).
10. **Скиллы и комментарии в коде — на английском.** Кириллица в скилле — провал теста; в коде
   русский остаётся только в строках (словарь `ru` редактора, вывод инструментов, имена тестов).
11. **Любой элемент интерфейса — запись в `UILayout.js`, через вкладку UI редактора.** Код игры
   не создаёт, не позиционирует и не красит HUD сам: берёт элемент по id — `UI.get('score').setText(…)`,
   `setValue`, `show`, `onClick`. Элемент, созданный в коде, редактору не виден — его не подвинуть.
12. **Агентский код игры не трогает `pc.*`.** `js/Game.js` (и стартеры) пишутся только на
   семантическом слое — `Scene` / `Edit` / `Kit` / `UI` / `Asset`; тест `tests/apigate.test.mjs`
   падает на любом `pc.` вне комментария. Всё, чему нужен движок (своя геометрия, риг, частицы),
   живёт в отдельном engine-файле `js/…3D.js` по образцу `Procedural3D.js`: он создаёт меши и
   регистрирует их через `World3D.addObject`, а игре отдаёт методы с обычными числами.
   Клавиши движения игра забирает через `camera.flightKeys = false`, а не правкой `FLY_KEYS`.

## Карта файлов

```
index.html        холст #world3d, экран загрузки, порядок скриптов (js/…)
js/               код игры — классические скрипты:
  Constants.js    Store, IS_MOBILE, LOCATION_*, TERRAIN_*, CAMERA_*, WORLD3D_* (грузится первым)
  Objects.js      LOCATION_OBJECTS — объекты локации (модель .fbx/.glb, вид, x/y/h, rot [x,y,z], scale [x,y,z],
                  anim — вращение части, clip — клип GLB, tag — группа для кода, hidden — скрыт до
                  setHidden, sound — звук на месте объекта); пишет редактор
  UILayout.js     UI_LAYOUT — раскладка интерфейса игры (id, вид, якорь, x/y, размеры, цвета); пишет редактор
  World3D.js      движок: init/renderFrame, View3D (камера, свет, тени, проекции), cfg(),
                  toon-шейдер ArcToonPlugin, контур рёбер, обводка силуэта, addObject
  Terrain3D.js    земля: поле высот из шума, сетка + кольцо за краем, heightAt/tiltAt
  Model3D.js      модели: бинарный FBX -> pc.Mesh (load с кэшем, build, dispose); 1 см = 1 px; диффузные
                  текстуры FBX (Video/Content/OP-связи) -> material.texture = { path, bytes }; .glb уходит в Gltf3D
  Procedural3D.js процедурные заглушки без файлов: KINDS (box/crate/tree/rock/pole), geometry(kind, seed),
                  spawn(view, kind, opts); Mesh3D.build — нормали в МИРОВОМ пространстве + правка winding
                  (against ≈ 0) + outward-safety; Location3D берёт их при отсутствующей модели (def.fallback,
                  rec.fallbackUsed)
  Gltf3D.js       модели glTF/GLB: скелет, текстуры, PBR -> StandardMaterial под toon; Clips3D — клипы анимации
                  (Model3D.clips(root).play('run') с плавным переходом)
  Sound3D.js      звук (Web Audio, без зависимостей): эффекты Sound3D.play(src, opts), музыка music(src),
                  звук на карте — слышно ОТТУДА, ГДЕ КАМЕРА (update(camera) каждый кадр); область
                  слышимости — сфера AUDIO_FALLOFF_MIN..MAX, панорама по стороне экрана
  Location3D.js   локация: View3D + Terrain3D + текстура земли (LOCATION_GROUND) + объекты (addObject/placeObject,
                  findByTag/setHidden, update(dt) — вращение частей по anim, клип по clip, звук по sound)
  SceneSchema.js  GENERATED (tools/manifest.mjs): машинно-читаемый контракт сцены — константы с
                  диапазонами редактора, поля записей, API
  SceneAPI.js     семантический слой для агентов и игр: Scene.spawn/move/remove/query/inspect/
                  follow/manifest, транзакции Edit.begin/…/commit/rollback с журналом,
                  Kit.* (state, frame-хуки, часы), UI.query/patch, Asset.preload/list/loaded,
                  Scene.seed/random (детерминизм агентских операций) — всё с валидацией
                  по SCENE_SCHEMA до кадра; агентский код не трогает pc.* (тест apigate)
  CameraControl.js CameraController: цель/азимут/наклон/зум, мышь, клавиши, тач; игровой и свободный режимы
  Debug3D.js      инструменты разработки (в кадре не работают, пока не позвали): lint() — сетки изнанкой,
                  конвенция карт нормалей, лимит света и солнце последним, лимиты шейдеров WebGL2, пустой кадр;
                  hold(pose)/release() — вид мимо контроллера камеры, frames(n), bench()/benchToggle(), setMode()
  UI.js           интерфейс игры: DOM поверх холста по UI_LAYOUT; UI.get(id).setText/setValue/show/onClick,
                  якоря 9 точек, масштаб по UI_REF_HEIGHT
  Game.js         пример игры: место игровой логики (кнопка Run — клипы idle/run персонажа, шкала энергии)
  main.js         вход: World3D.init -> Location3D(LOCATION_OBJECTS) -> камера -> UI -> Game -> цикл кадров; window.app
libs/             playcanvas.min.js (2.x UMD, глобал pc; контейнерный загрузчик glTF встроен), simplex-noise.js;
                  playcanvas.d.ts — типы движка для tsc
assets/           ground_texture_{g,s,d}.jpg — трава, песок, снег; models/*.fbx, *.glb — модели объектов
                  (character.glb — персонаж с клипами idle/run, генерируется tools/make-character.mjs);
                  sounds/*.wav, *.mp3 — звуки (step.wav генерируется tools/make-sounds.mjs)
tools/            dev-server.mjs, build.mjs, asset-scan.mjs, zip.mjs, check.mjs (типы + тесты), make-character.mjs,
                  make-sounds.mjs
tsconfig.json     проверка типов игры; globals.d.ts — window.app, material.arcToon, записи объектов
tests/            *.test.mjs (node --test): Store, heightAt, сканер ассетов, запись редактора, звук,
                  связка скиллов; browser-scripts.mjs — скрипты игры в node:vm + пустышка pc
_utils/editor/    редактор (в билд не едет): server.mjs (HTTP), save.mjs (запись Constants.js,
                  Objects.js и UILayout.js), index.html, i18n.js (EN/RU), schema.js, inspector.js (Global Settings),
                  objects-panel.js (Objects: список, свойства, гизмо, импорт), ui-panel.js (UI: элементы
                  интерфейса, драг и ресайз поверх вида), history.js (EditHistory:
                  Ctrl+Z / Ctrl+Shift+Z), loader.js, lab.js (вид), debug-tools.js (режим вида и «Lint scene»
                  на панели вида — Debug3D), main.js; tsconfig.json — его типы
claude/           едет пользователям (в билд игры — нет): skills/<имя>/SKILL.md — скиллы набора,
                  vendor/playcanvas/ — вендор @playcanvas/skills v0.3.0 (MIT), launch.json —
                  шаблон .claude/launch.json для панели браузера
AGENTS.md         кросс-агентная точка входа (Codex, Cursor и др.): протокол работы, инварианты,
                  карта скиллов; генерирует tools/sync-skills.mjs
NOTICE            атрибуция MIT-компонентов (PlayCanvas, @playcanvas/skills, simplex-noise)
README.md         публичное описание набора (EN): быстрый старт, AI-native раздел, лицензии
ROADMAP.md        стратегия публичного AI-native набора: фазы A/B/C, лицензии, риски
tools/            … sync-skills.mjs — генерация копий скиллов для агентов (--check для check.mjs);
                  manifest.mjs — генерация js/SceneSchema.js; create-arcengine.mjs — скаффолд
                  новой игры на наборе (стартеры kit/empty/survival, --no-skills)
scaffold/         исходники стартеров для create-arcengine (оверлеи js/); в архив игры не едет
```

## AI-native слой (фаза A роадмапа)

Агенты обнаруживают скиллы нативно: Claude Code — `.claude/skills/`, Codex/Cursor и
совместимые — `.agents/skills/` + `AGENTS.md`, Cursor — ещё `.cursor/rules/arcengine.mdc`.
Канон один (`claude/skills/`, `claude/vendor/`); копии и точки входа перегенерируются
`node tools/sync-skills.mjs` после любой правки канона (иначе `check.mjs` упадёт).
Семантический слой фазы B: `Scene.*` (js/SceneAPI.js) над каноном записей; манифест
`js/SceneSchema.js` перегенерируется `node tools/manifest.mjs` после правок Constants.js или
схемы редактора (check.mjs сверяет). Составные правки агента — транзакции
`Edit.begin(label).add/update/remove…commit()`: валидация всех операций до применения,
при ошибке — откат к снимку и запись в `Scene.journal()` (committed/rolledback/rejected/
discarded). Детерминизм: `Scene.seed(n)` + `Scene.random()` (стартеры не пользуют
Math.random — тест apigate), рельеф — константа `TERRAIN_NOISE_SEED`.
Проверки: `node tools/check.mjs` — быстрый профиль (типы, тесты, sync, манифест);
`node tools/check.mjs --all` — релизный gate: + `tools/headless-gate.mjs --render/--visual`
(headless Chrome, puppeteer — dev-only зависимость окружения проверки, не рантайма набора;
без неё gate возвращает код 2 с инструкцией). `--json=FILE` у gate пишет машинный отчёт
{ok, viewport, seed, game, editor, screenshots, failures} — агент читает его, а не код
выхода. Визуальные утверждения в странице: `Debug3D.assertVisible/assertInFrame/
assertPosition/capture` — возвращают {ok, code, details} без исключений.
Безопасность editor server: слушает только 127.0.0.1; статика не отдаёт dot-пути
(.git/, .backups/); traversal закрыт containment-проверкой; тела запросов ограничены
(JSON 1MB, модель 200MB) с 413; битый JSON — 400; имена констант — IDENT-whitelist;
импорт модели пишем только в assets/models/ после magic-bytes. Контракт — в
`tests/editor-security.test.mjs`. Вендоренные скиллы PlayCanvas описывают движок (эффекты, чанки, glb, пиксель-проверки);
в споре про файлы набора приоритет у скиллов набора.

## Как начать свою игру на наборе

`node tools/create-arcengine.mjs <папка> --starter kit|empty|survival [--no-skills]` — копия
набора + оверлей стартера + копии скиллов внутри цели; дальше `node tools/dev-server.mjs`.
Survival-стартер — образцовый пользователь семантического `Scene.*` (фазы B роадмапа).

## Как начать игру на наборе

1. Логика — в `js/Game.js` (пример в наборе: `constructor(app)` и `update(dt)`, зовётся из цикла
   `main.js` до рендера); большая игра — новые файлы: `<script>` до `main.js` + строка в `CODE_FILES`.
2. Статичные объекты локации — вкладка Objects редактора (`Objects.js`), в коде —
   `app.location.objects` (`{ def, mesh }` — mesh это корневая СУЩНОСТЬ модели). Свои объекты:
   `pc.Mesh` из вершин или `Model3D.load` + `Model3D.build` в `app.location.view` ->
   `World3D.addObject` -> позиция на `app.location.terrain.heightAt(x, y)` (в зеркальном
   мире: `setPosition(-x, h, y)`).
3. Декларативно (агенты и быстрые прототипы): `Scene.spawn(model, opts)`, `Scene.move(name, patch)`,
   `Scene.query()`, `await Scene.inspect()` — валидация по манифесту, ошибки читабельны без кадра.
4. Персонаж с анимацией — модель `.glb`: `Model3D.clips(mesh).play('run')`, переход между клипами —
   сам (скилл `world3d`). Поворот сущности — `World3D.rotQuat` / `eulerFromQuat`. Камера за героем —
   `app.camera.follow(obj)` (объект с полями `x`, `y`).
5. Интерфейс — записи в `UILayout.js` (вкладка UI редактора) + `UI.get(id)` в коде (скилл `ui`,
   инвариант 11). Новые числа — в `Constants.js` и `_utils/editor/schema.js`.

## Чего в наборе нет

Звука, физики и коллизий, готовых игрока и противника (`Game.js` — только образец места для
логики), текстур и скелета у FBX (`Model3D` — геометрия и цвета материалов бинарного FBX, центр
и оси частей; скелет, клипы и текстуры — только в GLB), картинок и привязки к точке мира в UI
(виды элементов — текст, панель, шкала, кнопка), нескольких сцен/уровней
(одна локация), сохранений прогресса, тестов рендера и ввода (тесты — только логика без 3D).
