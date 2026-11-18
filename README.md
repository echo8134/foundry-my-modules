# foundry-my-modules

Small Foundry VTT fixes for one table, in one module.

## Features

- hide cursors from the player list: hover a row and click the check mark. On your own row it hides your cursor from everyone; on another row it hides that person's cursor from you only (Shift-click: everyone). Pings still show.

## Install

Manifest URL: `https://github.com/echo8134/foundry-my-modules/releases/latest/download/module.json`

Requires Foundry VTT 14.

## Develop

- `npm run check` lints with Biome.
- `npm run e2e` drives a running test world with a Gamemaster and a player browser. Set `FOUNDRY_URL`, `FOUNDRY_WORLD`, `FOUNDRY_USER` and `FOUNDRY_PASSWORD`; it writes to the world, so point it at a world kept for tests.
- `npm run package` builds `module.zip` for a release.

## License

MIT, see `LICENSE`.
