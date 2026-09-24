# Источники пака (все — CC0)

Скачано 2026-09-24 через зеркала OpenGameArt (автор обоих паков — Kenney, www.kenney.nl):

| Пак | Лицензия | URL зеркала | Прямая ссылка архива |
|---|---|---|---|
| Nature Kit (2.1) | CC0 1.0 | https://opengameart.org/content/nature-kit | https://opengameart.org/sites/default/files/Nature%20Kit%20%282.1%29.zip |
| Castle Kit | CC0 1.0 | https://opengameart.org/content/castle-kit | https://opengameart.org/sites/default/files/kenney_castle-kit.zip |

CC0 не требует атрибуции, но мы держим её добровольно: NOTICE и LICENSE-*.txt в этой папке.

## Что взято

Nature Kit: tree_cone, tree_default, tree_blocks, rock_largeA, rock_largeC, rock_smallA,
plant_bush, plant_bushSmall, tent_smallOpen, fence_simple, campfire_stones, log_stack.
Castle Kit: gate, tower-square, wall, flag-banner-long, siege-catapult + Textures/colormap.png
(текстура приложена как провенанс: в рантайме замок печётся в геометрию с палитрой игры).

## Как используется

* `tools/make-pack-geo.mjs` запекает GLB (позиции + цвет материала, нормировка в высоту 1)
  в `js/WanderPackGeo.js` — данные батчера scenery и рецептов деревни/врат/корпуса;
* дрейф запека сторожит `node tools/make-pack-geo.mjs --check` (шаг `check.mjs`);
* нет запека — игра молча остаётся на процедурной геометрии (`js/WanderMesh.js`);
* новые модели добавляются сюда же: источник → SOURCES.md → NOTICE → генератор → роль в
  `js/GameSpec.js` → задача в `docs/ROADMAP.md` (таблица M-*).
