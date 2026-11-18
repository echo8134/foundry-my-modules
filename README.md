# foundry-my-modules

Small Foundry VTT fixes for one table, in one module. Requires Foundry VTT 14.

## Install

Install the module from its manifest URL:

```
https://github.com/echo8134/foundry-my-modules/releases/latest/download/module.json
```

Foundry offers each new release through the module's Update button.

## Features

### Hide cursors

Hover a row of the player list, bottom left, and a check mark appears; it fades out when the mouse leaves.

- On your own row it hides your cursor from everyone, for example the GM's while preparing a reveal.
- On another row it hides that person's cursor from you only. Shift-click applies it to everyone.
- Pings still show. The choice is stored per user, so it follows you to every device.

### Every level in the level navigation

The client setting "Show every level" lists all levels of a scene under the scene name, instead of three rows and a scroll bar. It is off by default.

### Scene variants at their level

A scene can carry variants of its levels, such as feast, night, burning or ruined. The GM switches them in the level navigation; players see nothing of it.

- The client setting "Variants at their levels" shows them as arrows (`◀ Burning ▶`) or as a tree under each level.
- A click switches the variant on that level only. Shift-click switches it on every level that has it, so the fire takes the tower too.
- A click on the base state resets that level; Shift-click resets every level.

## Variant data

A variant is a set of documents (Tile, AmbientLight, AmbientSound, Wall) with the flag `flags.foundry-my-modules.variant`.

- The flag is a variant name, or a list of names: the document is on while any of them is active. The base state's name means "on in the base state", so `["Day", "Feast", "Night", "Burning"]` is a wall that only the ruin removes. A document without the flag is always on.
- A document belongs to the levels in its own `levels` field, or to every level when that is empty.
- The variants of a level are the base state, then the variant names of its documents in the order the documents were created. The scene flag `defaultName` names the base state.
- The scene flag `active` maps a level id to its active variant. A level missing from it shows the base state.
- Switching off saves the switched fields in the document flag `restore` and writes the off values: Tile `alpha` 0, light and sound `hidden`, Wall `move`, `sight`, `light` and `sound` 0. Switching on writes the saved values back and deletes the flag. Tiles switch by alpha, because the GM sees hidden tiles half transparent.
- Create the documents switched on. The active GM brings the scene to the stored state when it loads and whenever the flags change, and writes only what differs.

The API for macros and other modules:

```js
const api = game.modules.get("foundry-my-modules").api;
api.getVariants(scene); // [{ levelId, name, variants, active }]
await api.setVariant(scene, levelId, "Burning"); // this level only
await api.setVariant(scene, levelId, "Burning", { linked: true }); // every level that has it
await api.setVariant(scene, null, "Day"); // reset every level
```

## Develop

- `npm run check` lints with Biome.
- `npm run e2e` runs the end-to-end tests against a running Foundry world, with a Gamemaster and a player browser. Set `FOUNDRY_URL`, `FOUNDRY_WORLD`, `FOUNDRY_USER` and `FOUNDRY_PASSWORD`. The tests write to the world, so point them at a world kept for tests.

## Release

Raise `version` in `module.json` and `package.json` and push to `main`. The Release workflow publishes `module.json` and `module.zip` as release `v<version>` when that release does not exist yet.

## License

MIT, see `LICENSE`.
