import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const PANEL = ".my-soundboard";
const SOUND = "sounds/combat/epic-start-horn.ogg";

await run(async () => {
  const gm = await joinGamemaster();
  const player = await join(PLAYER_NAME);
  const original = await gm.evaluate(
    (id) => ({
      enabled: game.settings.get(id, "soundboardEnabled"),
      playlist: game.settings.get(id, "soundboardPlaylist")
    }),
    MODULE_ID
  );
  let playlistId;
  try {
    let button;
    await check("the GM sees each sound from the configured playlist and players see no board", async () => {
      const fixture = await gm.evaluate(async (path) => {
        const list = await Playlist.create({
          name: `Soundboard test ${foundry.utils.randomID()}`,
          sounds: [
            { name: "Watchman's horn", path, volume: 0.35, repeat: true },
            { name: "Cellar door", path: "sounds/doors/wood/open-creaky.ogg" }
          ]
        });
        return { id: list.id, name: list.name, horn: list.sounds.getName("Watchman's horn").id };
      }, SOUND);
      playlistId = fixture.id;
      button = `${PANEL} button[data-sound-id="${fixture.horn}"]`;
      await gm.evaluate(
        async (id, name) => {
          await game.settings.set(id, "soundboardEnabled", true);
          await game.settings.set(id, "soundboardPlaylist", name);
        },
        MODULE_ID,
        fixture.name
      );
      for (const page of [gm, player]) {
        await page.bringToFront();
        await page.evaluate(() => game.user.sheet.close({ animate: false }));
        await page.click('#sidebar-tabs [data-tab="playlists"]');
        await page.waitForSelector(".playlists-sidebar", { visible: true });
      }
      await gm.waitForSelector(button, { visible: true });
      const labels = await gm.$$eval(`${PANEL} button`, (buttons) => buttons.map((b) => b.textContent.trim()).sort());
      assert(labels.join("|") === "Cellar door|Watchman's horn", labels.join("|"));
      assert(!(await player.$(PANEL)), "the player has a soundboard panel");
    });

    await check("one GM click plays the one-shot on both clients and the next stops it on both", async () => {
      for (const page of [player, gm]) {
        await page.bringToFront();
        await page.keyboard.press("Shift");
        await page.evaluate(async (src) => {
          await game.audio.unlock;
          const proto = foundry.audio.Sound.prototype;
          const play = proto.play;
          globalThis.soundboardCalls = [];
          globalThis.finishedSounds = new Set();
          proto.play = function (options) {
            if (this.src === src) {
              soundboardCalls.push(this);
              this.addEventListener("end", () => finishedSounds.add(this), { once: true });
            }
            return play.call(this, options);
          };
        }, SOUND);
      }
      await gm.locator(button).setTimeout(10000).click();
      for (const page of [gm, player]) {
        await waitFor(page, () => {
          const [sound] = soundboardCalls;
          return (
            sound?.playing &&
            Math.abs(sound.volume - 0.35) < 0.001 &&
            [game.audio.interface, game.audio.environment].includes(sound.context)
          );
        });
      }
      await gm.locator(button).setTimeout(10000).click();
      for (const page of [gm, player]) {
        await waitFor(
          page,
          () => soundboardCalls.length === 1 && !soundboardCalls[0].playing && !finishedSounds.has(soundboardCalls[0])
        );
      }
      await gm.locator(button).setTimeout(10000).click();
      await waitFor(player, () => soundboardCalls.length === 2 && soundboardCalls[1].playing);
      await waitFor(player, () => finishedSounds.has(soundboardCalls[1]));
      await gm.waitForSelector(`${button}[aria-pressed="false"]`);
    });

    await check("the world setting hides the panel and restores it", async () => {
      await gm.evaluate((id) => game.settings.set(id, "soundboardEnabled", false), MODULE_ID);
      await gm.waitForSelector(PANEL, { hidden: true });
      await gm.evaluate((id) => game.settings.set(id, "soundboardEnabled", true), MODULE_ID);
      await gm.waitForSelector(button, { visible: true });
    });
  } finally {
    await gm.evaluate(
      async (id, original, playlistId) => {
        await game.settings.set(id, "soundboardPlaylist", original.playlist);
        await game.settings.set(id, "soundboardEnabled", original.enabled);
        await game.playlists.get(playlistId)?.delete();
      },
      MODULE_ID,
      original,
      playlistId
    );
  }
});
