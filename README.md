# foundry-my-modules

Small Foundry VTT fixes for one table, in one module.

## Features

- hide cursors from the player list: hover a row and click the check mark. On your own row it hides your cursor from everyone; on another row it hides that person's cursor from you only (Shift-click: everyone). Pings still show.
- every level in the level navigation (client setting "Show every level"), instead of three rows and a scroll bar.
- scene variants at their level, for the GM only: arrows (◀ Burning ▶) or a tree under each level. A click switches the variant on every level that has it, Shift-click on this level only. See the data contract below.

## Variants

A variant is a set of documents (Tile, AmbientLight, AmbientSound, Wall) that share the flag `flags.foundry-my-modules.variant = "<name>"`. The flag may also be a list of names: the document is on while any of them is active. The base state's name means "on in the base state", so `["Tag", "Fest", "Nacht", "Brand"]` is a wall that only the ruin removes. A document belongs to the levels in its own `levels` field, or to every level when that is empty; a document without the flag is always on.

- The variants of a level are the base state plus the variant names of its documents, in the order the documents were created. The scene flag `defaultName` names the base state.
- The scene flag `active` maps a level id to its active variant; a level missing from it shows the base state.
- Switching off saves the switched fields in the document flag `restore` and writes the off values: Tile `alpha` 0, light and sound `hidden`, Wall `move`, `sight`, `light` and `sound` 0. Switching on writes the saved values back and deletes the flag. Tiles switch by alpha, because the GM sees hidden tiles half transparent.
- Create the documents switched on. The active GM brings the scene to the stored state when it loads and whenever the flags change, writing only what differs.
- API: `game.modules.get("foundry-my-modules").api.getVariants(scene)` returns `[{levelId, name, variants, active}]`; `setVariant(scene, levelId | null, name, {linked = true})` switches a variant, on every level that has it unless `linked` is false.

## Install

Manifest URL: `https://github.com/echo8134/foundry-my-modules/releases/latest/download/module.json`

Requires Foundry VTT 14.

## Develop

- `npm run check` lints with Biome.
- `npm run e2e` drives a running test world with a Gamemaster and a player browser, one test file after the other. Set `FOUNDRY_URL`, `FOUNDRY_WORLD`, `FOUNDRY_USER` and `FOUNDRY_PASSWORD`; it writes to the world, so point it at a world kept for tests.
- `npm run package` builds `module.zip` for a release.

## License

MIT, see `LICENSE`.
