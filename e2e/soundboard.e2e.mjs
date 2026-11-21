import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const PANEL = ".my-soundboard";
const SOUND = "sounds/combat/epic-start-horn.ogg";
const DOOR = "sounds/doors/wood/open-creaky.ogg";
const CHANNEL = `module.${MODULE_ID}`;

async function observeAudio(page) {
  await page.evaluate(
    (channel, horn, door) => {
      const probe = { horn: [], door: [], finished: new Set(), messages: [] };
      globalThis.soundboard = probe;
      game.socket.on(channel, (data, sender) => probe.messages.push({ data, sender }));
      const play = foundry.audio.Sound.prototype.play;
      foundry.audio.Sound.prototype.play = function (options) {
        if (this.src === horn || this.src === door) {
          probe[this.src === horn ? "horn" : "door"].push({
            sound: this,
            offset: options.offset,
            at: game.time.serverTime
          });
          this.addEventListener("end", () => probe.finished.add(this), { once: true });
        }
        return play.call(this, options);
      };
    },
    CHANNEL,
    SOUND,
    DOOR
  );
}

async function openPlaylists(page) {
  await page.bringToFront();
  await page.evaluate(() => game.user.sheet.close({ animate: false }));
  await page.click('#sidebar-tabs [data-tab="playlists"]');
  await page.waitForSelector(".playlists-sidebar", { visible: true });
}

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
    let door;
    await check("the GM sees each sound from the configured playlist and players see no board", async () => {
      const fixture = await gm.evaluate(
        async (path, doorPath) => {
          const list = await Playlist.create({
            name: `Soundboard test ${foundry.utils.randomID()}`,
            sounds: [
              { name: "Watchman's horn", path, volume: 0.35, repeat: true },
              { name: "Cellar door", path: doorPath }
            ]
          });
          return {
            id: list.id,
            name: list.name,
            horn: list.sounds.getName("Watchman's horn").id,
            door: list.sounds.getName("Cellar door").id
          };
        },
        SOUND,
        DOOR
      );
      playlistId = fixture.id;
      door = `${PANEL} button[data-sound-id="${fixture.door}"]`;
      button = `${PANEL} button[data-sound-id="${fixture.horn}"]`;
      await gm.evaluate(
        async (id, name) => {
          await game.settings.set(id, "soundboardEnabled", true);
          await game.settings.set(id, "soundboardPlaylist", name);
        },
        MODULE_ID,
        fixture.name
      );
      await openPlaylists(gm);
      await player.evaluate(() => ui.sidebar.changeTab("playlists", "primary"));
      await player.waitForSelector(".playlists-sidebar", { visible: true });
      await gm.waitForSelector(button, { visible: true });
      const labels = await gm.$$eval(`${PANEL} button`, (buttons) => buttons.map((b) => b.textContent.trim()).sort());
      assert(labels.join("|") === "Cellar door|Watchman's horn", labels.join("|"));
      assert(!(await player.$(PANEL)), "the player has a soundboard panel");
    });

    await Promise.all([gm, player].map(observeAudio));
    await check(
      "a late audio unlock skips the expired cue and starts the remaining cue at its server-clock offset",
      async () => {
        assert(await player.evaluate(() => game.audio.locked), "the player's audio was already unlocked");
        await gm.evaluate(
          (door, horn) => {
            document.querySelector(door).click();
            document.querySelector(horn).click();
          },
          door,
          button
        );
        await waitFor(gm, () => soundboard.finished.has(soundboard.door[0]?.sound));
        await waitFor(
          player,
          () => soundboard.messages.filter(({ data }) => data.action === "soundboardPlay").length === 2
        );
        await player.bringToFront();
        await player.keyboard.press("Shift");
        await waitFor(player, () => soundboard.horn[0]?.sound.playing);
        const { offset, elapsed } = await player.evaluate((src) => {
          const cue = soundboard.messages.find(({ data }) => data.src === src).data;
          const { offset, at } = soundboard.horn[0];
          return { offset, elapsed: (at - cue.startedAt) / 1000 };
        }, SOUND);
        assert(offset > 2 && Math.abs(offset - elapsed) < 0.3, `heard offset ${offset}s after ${elapsed}s elapsed`);
        await waitFor(player, () => soundboard.finished.has(soundboard.horn[0].sound));
        assert(await player.evaluate(() => soundboard.door.length === 0), "the expired door cue played after unlock");
        await gm.waitForSelector(`${button}[aria-pressed="false"]`);
      }
    );

    await check("one GM click plays the one-shot on both clients and the next stops it on both", async () => {
      await Promise.all(
        [gm, player].map((page) =>
          page.evaluate(() => {
            soundboard.horn.length = 0;
          })
        )
      );
      await gm.locator(button).setTimeout(10000).click();
      for (const page of [gm, player]) {
        await waitFor(page, () => {
          const sound = soundboard.horn[0]?.sound;
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
          () =>
            soundboard.horn.length === 1 &&
            !soundboard.horn[0].sound.playing &&
            !soundboard.finished.has(soundboard.horn[0].sound)
        );
      }
    });

    await check("a player sender can neither start a stopped cue nor stop a GM's playing cue", async () => {
      const playerId = await player.evaluate(() => game.user.id);
      const sendAsPlayer = (action) =>
        player.evaluate(
          (channel, src, action) => {
            const cue = soundboard.messages.find(({ data }) => data.src === src).data;
            game.socket.emit(channel, {
              ...cue,
              action,
              startedAt: game.time.serverTime,
              requestId: foundry.utils.randomID()
            });
          },
          CHANNEL,
          SOUND,
          action
        );
      const received = (action) =>
        waitFor(
          gm,
          (id, action) => soundboard.messages.some(({ data, sender }) => sender === id && data.action === action),
          playerId,
          action
        );
      await gm.evaluate(() => {
        soundboard.horn.length = 0;
      });
      await sendAsPlayer("soundboardPlay");
      await received("soundboardPlay");
      assert(await gm.$eval(button, (b) => b.ariaPressed === "false"), "the player started the GM's cue");
      assert(await gm.evaluate(() => soundboard.horn.length === 0), "player command reached Sound.play");
      await gm.$eval(button, (b) => b.click());
      await waitFor(gm, () => soundboard.horn.length === 1 && soundboard.horn[0].sound.playing);
      await sendAsPlayer("soundboardStop");
      await received("soundboardStop");
      assert(await gm.$eval(button, (b) => b.ariaPressed === "true"), "the player stopped the GM's cue");
      assert(await gm.evaluate(() => soundboard.horn[0].sound.playing), "playback stopped after the player command");
      await gm.$eval(button, (b) => b.click());
      await waitFor(gm, () => !soundboard.horn[0].sound.playing);
    });

    await check("both GMs and the player apply rapid and competing clicks in relay order", async () => {
      const guest = await gm.evaluate(async () => {
        const user = await User.create({
          name: `Soundboard GM ${foundry.utils.randomID(6)}`,
          role: CONST.USER_ROLES.GAMEMASTER
        });
        return { name: user.name, id: user.id };
      });
      let other;
      try {
        other = await join(guest.name);
        await observeAudio(other);
        await openPlaylists(other);
        await other.waitForSelector(button);
        const clients = [gm, other, player];
        await Promise.all(
          clients.map((page) =>
            page.evaluate(() => {
              soundboard.messages.length = 0;
            })
          )
        );
        await gm.$eval(button, (b) => {
          b.click();
          b.click();
        });
        for (const page of clients) {
          await waitFor(page, () => soundboard.messages.length === 2);
          const actions = await page.evaluate(() => soundboard.messages.map(({ data }) => data.action));
          assert(actions.join(",") === "soundboardPlay,soundboardStop", `quick second click sent ${actions}`);
          await waitFor(page, () => soundboard.horn.every(({ sound }) => !sound.playing));
        }

        await gm.$eval(button, (b) => b.click());
        await Promise.all(
          clients.map(async (page) => {
            await waitFor(page, () => soundboard.messages.length === 3 && soundboard.horn.at(-1)?.sound.playing);
            await page.evaluate(() => {
              soundboard.beforeRestart = soundboard.horn.at(-1).sound;
            });
          })
        );
        await other.evaluate(
          (channel, selector) => {
            const socket = game.socket;
            const emit = socket.emit;
            socket.emit = (event, ...args) => {
              if (event === channel && args[0].action === "soundboardStop") {
                globalThis.releaseStop = () => emit.call(socket, event, ...args);
                return socket;
              }
              return emit.call(socket, event, ...args);
            };
            try {
              document.querySelector(selector).click();
            } finally {
              socket.emit = emit;
            }
          },
          CHANNEL,
          button
        );
        assert(
          await other.evaluate(() => soundboard.beforeRestart.playing),
          "the second GM stopped the cue before the server received the click"
        );
        await gm.$eval(button, (b) => {
          b.click();
          b.click();
        });
        await Promise.all(
          clients.map((page) =>
            waitFor(
              page,
              () =>
                soundboard.messages.length === 5 &&
                soundboard.horn.at(-1).sound !== soundboard.beforeRestart &&
                soundboard.horn.at(-1).sound.playing
            )
          )
        );
        await other.evaluate(() => releaseStop());
        for (const page of clients) {
          await waitFor(page, () => soundboard.messages.length === 6);
          const relay = await page.evaluate(() =>
            soundboard.messages.slice(3).map(({ data, sender }) => [data.action, sender])
          );
          assert(
            relay.map(([action]) => action).join(",") === "soundboardStop,soundboardPlay,soundboardStop" &&
              relay[2][1] === guest.id,
            `unexpected relay order: ${JSON.stringify(relay)}`
          );
          await waitFor(page, () => soundboard.horn.every(({ sound }) => !sound.playing));
          assert(
            await page.evaluate(() => !soundboard.finished.has(soundboard.horn.at(-1).sound)),
            "the restarted horn reached its natural end instead of stopping"
          );
        }
      } finally {
        await other?.browserContext().close();
        await gm.evaluate((id) => game.users.get(id)?.delete(), guest.id);
      }
    });

    await check("unrelated playlist renders retain scroll and the focused cue in the sidebar and popout", async () => {
      await gm.evaluate(
        async (id, path) => {
          const sounds = Array.from({ length: 48 }, (_, i) => ({ name: `Test cue ${i + 1}`, path }));
          await game.playlists.get(id).createEmbeddedDocuments("PlaylistSound", sounds);
          await ui.playlists.render();
        },
        playlistId,
        SOUND
      );
      for (const popout of [false, true]) {
        const { before, after, focused } = await gm.evaluate(async (popout) => {
          const app = popout ? await ui.playlists.renderPopout() : ui.playlists;
          const board = app.element.querySelector(".my-soundboard");
          const last = board.querySelector("button:last-child");
          last.focus({ preventScroll: true });
          board.scrollTop = board.scrollHeight;
          const before = board.scrollTop;
          await app.render();
          const current = app.element.querySelector(".my-soundboard");
          const after = current.scrollTop;
          const focused = current.querySelector(":focus")?.dataset.uuid === last.dataset.uuid;
          if (popout) await app.close({ animate: false });
          return { before, after, focused };
        }, popout);
        const view = popout ? "popout" : "sidebar";
        assert(before > 0 && before === after, `${view} scroll changed from ${before} to ${after}`);
        assert(focused, `${view} lost focus on the last cue`);
      }
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
