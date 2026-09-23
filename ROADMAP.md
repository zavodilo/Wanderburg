# ArcEngine — roadmap публичного AI-native набора
Цель: публичный MIT-проект — набор для 3D-игр в браузере, в котором ИИ-агенты (Claude Code, Codex, Cursor и любые, читающие стандартные точки входа) являются первоклассными пользователями: находят скиллы без инструкций, правят сцену через семантический API и проверяют себя headless-рендером.

`ArcEngine (MIT)
├── AI-native semantic API + edit transactions (фаза B)
├── deterministic headless + visual verification (фаза B)
├── agent skills: свои + движковые  (фаза A)
├── CLAUDE.md / AGENTS.md / agent-manifest.json (фаза A)
├── свой editor                   (есть)
├── свой scene format             (есть)
├── свой zero-npm build           (есть)
└── PlayCanvas Engine 2 (MIT)
    └── движковые скиллы @playcanvas/skills (MIT, вендор)
`

## Текущее состояние (после PR #1–#5, main)
  * Движок перенесён с Babylon.js 9.26 на PlayCanvas 2.22 (`libs/playcanvas.min.js`, UMD, WebGL2): toon-чанки `StandardMaterial` (цветные тени, полосы, rim), чернильные рёбра, inverted-hull контур, слои WORLD/OVERLAY/ACTOR, тени directional light.
  * Координатное соглашение: мир движка — зеркало карты по X (левосторонний PlayCanvas против правосторонней карты); игровая математика осталась в координатах карты (скилл `world3d`).
  * Фаза A (база, PR #3): sync-skills и точки входа агентов (`.claude/skills/`, `.agents/skills/`, `.cursor/rules/`, `AGENTS.md`), вендор `@playcanvas/skills` **v0.3.0**, NOTICE/README.
  * Фаза B (база, PR #4): `Scene.spawn/move/remove/query/inspect/follow/manifest` + `js/SceneSchema.js` (GENERATED), контрактные тесты, headless-сессия агента.
  * Фаза C (база, PR #5): `create-arcengine` (стартеры kit/empty/survival, npm bin, zero deps).
  * Ниже — ДЕЛЬТА к базе: фаза A+ (`agent-manifest.json`), фаза B+ (транзакции `Edit.*`, `Kit.*`/`UI.*`/`Asset.*`, `Scene.seed`, профили check `--render/--visual/--all`, visual gate).

## Лицензии и атрибуция
Компонент  | Лицензия  | Использование
--- | --- | ---
ArcEngine (этот репозиторий)  | MIT (`LICENSE`)  | основа
PlayCanvas Engine 2  | MIT  | `libs/playcanvas.min.js`, бинарно в репозитории
create-playcanvas  | MIT  | образец упаковки скиллов и скаффолда (фаза A/C), код не копируется
@playcanvas/skills  | MIT  | вендор engine-скиллов (фаза A), версия пинится
Вендоренные части сохраняют свои LICENSE-файлы рядом (`libs/PLAYCANVAS_LICENSE`, `claude/skills/vendor/playcanvas/LICENSE`); упоминания — в NOTICE (фаза A). Ничего GPL/proprietary в цепочке нет; публичная публикация набора совместима со всеми тремя лицензиями при сохранении copyright-строк и текста лицензий.

## Фаза A — мульти-агентная упаковка скиллов
Перед упаковкой скиллов фиксируется машинный контракт агента: `agent-manifest.json` содержит версию API, карту скиллов, точки входа и команды проверки. `CLAUDE.md` остаётся человекочитаемой картой, а `agent-manifest.json` — источником машиночитаемых возможностей.
Канон скиллов остаётся в `claude/skills/` (имена без точки: веб-загрузка GitHub не пропускает dot-папки). Появляется генерация копий для агентов:
  * `tools/sync-skills.mjs`: из канона + вендора собирает `.claude/skills/` (Claude Code, нативный Skill-tool), `.agents/skills/` (Codex, Cursor, прочие по emerging-конвенции create-playcanvas), `.cursor/rules/arcengine.mdc`, корневой `AGENTS.md` (кросс-агентная точка входа: инварианты, проверки, карта скиллов).
  * Вендор `@playcanvas/skills` v0.3.0 (MIT, уже в main) — engine-слой дополняет скиллы набора (графика, эффекты, соглашения движка); свои скиллы приоритетнее при коллизиях имён.
  * `tools/check.mjs`: шаг «копии синхронны канону» (по образцу CI create-playcanvas); правка канона без regen — провал проверки.
  * Инвариант 9 уточняется: «Skill-инструмент теперь видит скиллы; CLAUDE.md остаётся картой для человека и агентов без нативной поддержки скиллов».
  * NOTICE + раздел «AI-native» в README/CLAUDE.md.
Критерий готовности: `node tools/check.mjs --all` зелёный; Claude Code обнаруживает скилл через Skill-tool; Codex-совместимый агент находит `AGENTS.md` и `.agents/skills`; headless-рендер игры и редактора без ошибок; `agent-manifest.json` соответствует канону скиллов и API.

## Фаза B — семантический AI-API, манифест сцены и проверяемый агентский цикл
Агент не должен знать `pc.*`: поверх кита появляется тонкий декларативный слой (`js/AgentAPI.js` или подобное):
  * `Scene.spawn(model, opts)` (контракт из main: model — литерал `assets/…`, opts — kind/x/y/h/heading/rot/scale/clip), `Scene.move/remove/query`, `Scene.inspect()` — диагностика (обёртки Debug3D.lint/bench + состояние объектов). `Scene.inspect()` поддерживает фильтры по id/kind/области и возвращает состояние, предупреждения и ошибки.
  * Операции сцены и игры идемпотентны и сериализуемы в журнал правок. Для составных AI-правок появляется `Edit.begin/add/update/remove/commit/rollback`, чтобы частично применённая правка никогда не оставляла сцену в неопределённом состоянии.
  * Помимо `Scene.*` появляется минимальный generic API игрового цикла, UI и ассетов без обращения к `pc.*`: `Kit.*` (state, frame-хуки, time/dt/fps — имя `Game.*` сознательно не используется: каждая скаффолднутая игра определяет собственный `class Game` в `js/Game.js`, глобальный `Game` столкнулся бы с ней), `UI.query/patch/add/remove/get` (расширение канонического `UI`), `Asset.preload/list/loaded`.
  * Машинно-читаемый манифест сцены: JSON-схема поверх `Objects.js`/`UILayout.js`/`Constants.js` (имена, типы, диапазоны из `_utils/editor/schema.js`), чтобы агент валидировал правки до рендера; редактор и игра читают тот же канон.
  * Детерминированность: `Scene.seed(n)` задаёт PRNG агентских операций (`Scene.random()`); стартеры пользуют только его, не `Math.random`. Рельеф сеется константой `TERRAIN_NOISE_SEED` (правится редактором) и от `Scene.seed` не зависит — visual-тесты фиксируют viewport 1280x720 и seed сценария.
  * Проверка строится в несколько уровней: unit/contract tests без 3D + headless-сценарий «агент правит сцену → запуск → console/errors → Debug3D.lint» + screenshot/visual smoke checks для камеры, видимости и критичных UI.
  * `tools/check.mjs` получает профили `--types`, `--tests`, `--skills`, `--render`, `--visual`, `--all`; базовый `check` остаётся быстрым, а `--all` является обязательным релизным gate. `--render`/`--visual` вызывают `tools/headless-gate.mjs`, которому нужен puppeteer: это dev-only зависимость окружения проверки (node_modules/NODE_PATH), а не рантайма набора; без неё gate возвращает код 2 с инструкцией, и `--all` в релизном окружении обязан упасть.
Критерий готовности: пример сессии агента (spawn 10 врагов, поставить клип, изменить UI, прогнать lint и visual smoke) проходит headless без ручных правок `js/`; в случае ошибки составная правка откатывается.

## Фаза C — публичный скаффолд `create-arcengine`
  * CLI по образцу create-playcanvas, но без Vite/npm в рантайме набора: копия набора + скиллы + стартеры (пустая сцена, top-down survival-заготовка из примера Game.js); флаги `--no-skills`, `--starter`.
  * Рантайм-инвариант не меняется: ноль runtime npm-зависимостей, классические `<script>`, `libs/playcanvas.min.js` локально; npm допустим только в инструментарии скаффолда. Инструментарий может использовать npm cache/`npx`, если это явно задокументировано.
  * Релиз-канал: zip-архив сборки (есть) + npm-пакет скаффолда (опционально).

## Не-цели (осознанные отказы)
  * Не переезжаем на Vite/TypeScript-шаблоны create-playcanvas: ниша набора — vanilla JS без сборки; TS остаётся проверкой по JSDoc.
  * Не поддерживаем WebGL1: PlayCanvas 2 — WebGL2-only.
  * Не форкаем движок: только вендоринг релизных файлов (`libs/`), апгрейд = новая пара файлов
    * прогон check/рендера.
  * Не дублируем редактор PlayCanvas Editor: свой редактор — часть ДНК набора (пишет код-файлы, а не бинарные сцены).

## Риски и их страховки
Риск  | Страховка
--- | ---
апстрим PlayCanvas ломает якорь чанков toon-шейдера  | `ArcToon.register` молча деградирует до обычных теней + тест-маркер в check; версия движка пинится файлами в `libs/`
расходимость канона и копий скиллов  | шаг sync-проверки в `tools/check.mjs` + `agent-manifest.json`
агент ломает сцену через прямой `pc.*`  | API gate: игровой код не требует `pc.*`; lint/grep/check и контрактные тесты ловят обход semantic API
частично применённая AI-правка  | транзакции `Edit.commit/rollback` + журнал операций
недетерминированный headless/visual test  | фиксированный seed, viewport и набор ассетов; шум/процедурность привязаны к seed
ошибка, незаметная по lint  | screenshot/visual smoke + console/error gate
лицензионная чистота вендора  | LICENSE-файлы рядом с вендором + NOTICE; версии пинятся коммитом

## Порядок работы
Каждая фаза — отдельная ветка и PR в `main`; до мерджа: для обычной разработки `node tools/check.mjs`, для release/PR gate `node tools/check.mjs --all`; headless-рендер игры и редактора без ошибок консоли, visual smoke зелёный, скиллы/CLAUDE.md/`agent-manifest.json` обновлены в том же PR. В PR должен быть приложен краткий evidence: команды, seed/viewport и результаты проверок.

## Сверка внешнего ревью (2026-09-19) и фазы D/E

Ревью писалось без свежего checkout, поэтому часть «отсутствующего» уже была в main или в
PR #6–#8. Статусы пунктов ревью:

| Пункт ревью | Статус |
|---|---|
| 2, 3, 4, 6 (semantic API, transactions, inspect, seed) | в main/PR #4, #7: `Scene.*`, `Edit.*`, `Scene.journal()`, `Scene.seed/random` |
| 4 расширенный (фильтры inspect: kind/name/area, entities/camera/warnings) | PR #9 |
| 5 (schema contract) | в main: `js/SceneSchema.js` + валидация до кадра (PR #4, #7) |
| 7 (headless gate + машинный отчёт) | PR #7 (gate), PR #9 (`--json=FILE` + скриншоты в отчёте) |
| 8 (visual assertions: assertVisible/assertInFrame/assertPosition/capture) | PR #9 (`Debug3D.assert*`, `capture()`) |
| 17 (agent-manifest.json) | PR #6 |
| 18 (cross-platform CLI) | PR #8 (`tools/arc.mjs`, `.bat`/`.sh`) |
| 10 (map/render coordinates) | частично: `World3D.mirror/unmirror` + запрет ручного зеркалирования в агентском коде (apigate); публичные `mapToRender/renderToMap` — фаза D |
| 19 (security editor server) | PR #9: аудит + hardening (dot-paths 403, 400 bad JSON, 413 везде, drain без обрыва соединения) + `tests/editor-security.test.mjs` |
| 20 (операционный журнал) | в main/PR #7: `Scene.journal()` |
| 1, 9, 11, 12, 13, 14, 22, 23, 24 (split World3D, editor-as-client, FBX→GLB, ECS, physics, input, perf budget, license scanner) | фазы D/E ниже |

Порядок ревью («semantic до упаковки») принят ретроспективно как принцип: упаковка (A/C)
ушла первой только потому, что semantic-база (B) была следом; все будущие фазы идут в
порядке API → verification → AI → scaffold.

### Фаза D — semantic extensions и machine-ops
  * `Input.*`: `isDown(action)`, `mousePosition()`, `pointerWorld()` — единый контракт ввода
    для игр и агентов вместо `addEventListener` в каждой игре.
  * `Physics.*` spatial queries без pc.*: `raycast()`, `overlap(area)`, `distance(a, b)`,
    `blocked(x, y)` (terrain + bounds объектов) — для AI-навигации, line of sight, pickup.
  * `World3D.mapToRender/renderToMap` как публичный API + тест, что engine-слой — единственное
    место с зеркалированием.
  * `Debug3D.stats()` машинно: fps, frame time, draw calls, triangles, materials, entities,
    textures; `node tools/check.mjs --performance` с budget-файлом
    (`{ maxDrawCalls, maxTextureMB, maxTriangles }`) — агент видит цену своих 300 деревьев.
  * `tools/notices.mjs`: сканер цепочки лицензий (runtime + vendor + tools) → генерация
    `THIRD_PARTY_NOTICES.md`; проверка в `check.mjs`.

### Фаза E — архитектурная глубина
  * Разделение `World3D` на Renderer / Scene / Camera / Lighting / Picking + RenderStyle
    (Toon / Outline / Shadows): агент меняет lighting, не трогая lifecycle рендера.
  * Editor как API-клиент Arc API: человеческие, AI- и редакторские правки идут через один
    semantic layer (сейчас редактор правит записи напрямую — это его канон, но контракт
    должен стать общим).
  * FBX → GLB: конвертация ассетов набора, затем деградация собственного FBX-парсера до
    тонкого adapter'а glTF (Model3D: load/instantiate/animation/dispose).
  * Минимальная semantic ECS-модель поверх компонентов: `Entity.add('Health'|'EnemyAI', …)`
    без копирования ECS движка; аудио и навигация — по потребности игр.
