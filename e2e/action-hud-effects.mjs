import { assert, check, MODULE_ID, waitFor } from "./harness.mjs";

const STRIP = "#my-action-hud .hud-effects";
const CONCENTRATION = `${STRIP} [data-action="endConcentration"]`;
const setting = (page, key, value) => page.evaluate((m, k, v) => game.settings.set(m, k, v), MODULE_ID, key, value);

export async function checkEffectStrip(gm, player, ids) {
  await check("the owner can remove prone and one level of exhaustion from the optional strip", async () => {
    const config = await player.evaluate((id) => {
      const option = game.settings.settings.get(`${id}.actionHudShowEffects`);
      return [option.scope, option.default, game.i18n.localize(option.name)];
    }, MODULE_ID);
    assert(config.join("/") === "client/false/Show active effects above the Action HUD", JSON.stringify(config));
    const prone = await gm.evaluate(async (id) => {
      const actor = game.actors.get(id);
      await actor.items
        .getName("Ashwood Staff")
        .createEmbeddedDocuments("ActiveEffect", [{ name: "Permanent staff bonus", transfer: true }]);
      await actor.toggleStatusEffect("prone", { active: true });
      return actor.effects.find((effect) => effect.statuses.has("prone")).uuid;
    }, ids.actor);
    await waitFor(player, (id) => game.actors.get(id).statuses.has("prone"), ids.actor);
    assert(!(await player.$(STRIP)), "strip was present with the setting off");
    await setting(player, "actionHudShowEffects", true);
    await player.locator(`${STRIP} [data-effect-uuid="${prone}"]`).click({ button: "right" });
    await waitFor(gm, (id) => !game.actors.get(id).statuses.has("prone"), ids.actor);
    await player.waitForSelector(STRIP, { hidden: true });

    await gm.evaluate((id) => game.actors.get(id).update({ "system.attributes.exhaustion": 2 }), ids.actor);
    await waitFor(player, (id) => game.actors.get(id).system.attributes.exhaustion === 2, ids.actor);
    const exhaustion = await player.evaluate(
      (id) => game.actors.get(id).effects.find((effect) => effect.system.type === "exhaustion").uuid,
      ids.actor
    );
    const button = player.locator(`${STRIP} [data-effect-uuid="${exhaustion}"]`);
    for (const remaining of [1, 0]) {
      await button.click({ button: "right" });
      await waitFor(
        gm,
        (id, level) => game.actors.get(id).system.attributes.exhaustion === level,
        ids.actor,
        remaining
      );
    }
    await player.waitForSelector(STRIP, { hidden: true });
  });

  await check("an owner can identify and dismiss a timed effect cast by another actor", async () => {
    const uuid = await gm.evaluate(async ({ actor, guard }) => {
      const source = canvas.tokens.get(guard).actor.items.getName("Detect Magic");
      const [effect] = await game.actors.get(actor).createEmbeddedDocuments("ActiveEffect", [
        {
          name: "Magic revealed",
          origin: source.uuid,
          duration: { value: 2, units: "minutes" }
        }
      ]);
      return effect.uuid;
    }, ids);
    const selector = `${STRIP} [data-effect-uuid="${uuid}"]`;
    await player.waitForSelector(selector, { visible: true });
    const tooltip = await player.$eval(selector, (button) => button.dataset.tooltipText);
    assert(
      tooltip.includes("Magic revealed") && tooltip.includes("Source: Detect Magic") && tooltip.includes("2"),
      tooltip
    );
    await player.locator(selector).click({ button: "right" });
    await waitFor(gm, (uuid) => !fromUuidSync(uuid), uuid);
    await player.waitForSelector(STRIP, { hidden: true });
  });

  const spell = await gm.evaluate(async (id) => {
    const pack = game.packs.get("dnd5e.spells24");
    const entry = (await pack.getIndex()).getName("Bless");
    const original = await pack.getDocument(entry._id);
    const [spell] = await game.actors.get(id).createEmbeddedDocuments("Item", [original.toObject()]);
    return spell.id;
  }, ids.actor);

  try {
    await check("casting Bless shows concentration first and ending it clears both targets", async () => {
      await waitFor(player, (id, spell) => game.actors.get(id).items.has(spell), ids.actor, spell);
      const message = await player.evaluate(
        async ({ hero, guard, actor }, spell) => {
          canvas.tokens.get(hero).setTarget(true);
          canvas.tokens.get(guard).setTarget(true, { releaseOthers: false });
          const result = await game.actors.get(actor).items.get(spell).use({ consume: false }, { configure: false });
          return result.message.id;
        },
        ids,
        spell
      );
      await waitFor(gm, (id) => game.messages.has(id), message);
      await gm.evaluate((id) => {
        hudTestDocuments.push(game.messages.get(id));
      }, message);
      const tray = `[data-message-id="${message}"] effect-application`;
      await gm.waitForSelector(`${tray} .effect button[aria-pressed="true"]`);
      await gm.$eval(`${tray} .apply-button`, (button) => button.click());
      await waitFor(
        gm,
        ({ hero, guard }) => [hero, guard].every((id) => canvas.tokens.get(id).actor.effects.getName("Blessed")),
        ids
      );
      await waitFor(
        player,
        (s) => document.querySelector(s)?.querySelectorAll("[data-effect-uuid]").length === 2,
        STRIP
      );
      const first = await player.$eval(STRIP, (strip) => {
        const button = strip.querySelector("button");
        return [button.dataset.action, button.dataset.tooltipText, button.querySelector("img")?.naturalWidth];
      });
      assert(
        first[0] === "endConcentration" && first[1].includes("Bless") && /min|60\s*s/i.test(first[1]) && first[2] > 0,
        JSON.stringify(first)
      );
      await player.hover(CONCENTRATION);
      await waitFor(player, () => document.querySelector("#tooltip.active")?.textContent.includes("Bless"));
      await player.locator(CONCENTRATION).click();
      await waitFor(
        gm,
        ({ hero, guard }) =>
          [hero, guard].every((id) => {
            const actor = canvas.tokens.get(id).actor;
            return !actor.effects.getName("Blessed") && !actor.concentration.effects.size;
          }),
        ids
      );
      await player.waitForSelector(STRIP, { hidden: true });
    });
  } finally {
    await gm.evaluate((id, spell) => game.actors.get(id).items.get(spell).delete(), ids.actor, spell);
  }

  await check(
    "two rows above the action HUD clear the open panel and macro slots in both designs and layouts",
    async () => {
      await gm.evaluate((id) => game.actors.get(id).toggleStatusEffect("prone", { active: true }), ids.actor);
      await player.locator('#my-action-hud [data-group="rolls"]').click();
      const extraRow = await player.addStyleTag({
        content: '#my-action-hud .hud-body::before { content: ""; display: block; height: 24px; }'
      });
      try {
        for (const design of ["wood", "menu"]) {
          await setting(player, "actionHudDesign", design);
          for (const detached of [false, true]) {
            await setting(player, "actionHudDetachHotbar", detached);
            const match = `${detached ? "body" : "#hotbar"} > #my-action-hud${design === "menu" ? ".menu-design" : ":not(.menu-design)"}`;
            await player.waitForSelector(`${match} .hud-panel`, { visible: true });
            await waitFor(
              player,
              (selector) => {
                const hud = document.querySelector(selector);
                if (!hud?.querySelector(".hud-effects")) return false;
                const body = hud.querySelector(".hud-body");
                const strip = hud.querySelector(".hud-effects");
                const nav = hud.querySelector(".hud-bar");
                const panel = hud.querySelector(".hud-panel")?.getBoundingClientRect();
                const macros = document.querySelector("#action-bar").getBoundingClientRect();
                const effects = strip.getBoundingClientRect();
                const bar = nav.getBoundingClientRect();
                const top = body.getBoundingClientRect().top;
                return (
                  effects.top > top &&
                  effects.height > 0 &&
                  effects.bottom <= bar.top + 1 &&
                  panel?.height > 0 &&
                  (panel.bottom <= top + 1 || panel.top >= bar.bottom - 1) &&
                  Math.max(bar.bottom, panel.bottom) <= macros.top + 1 &&
                  getComputedStyle(strip).backgroundColor === getComputedStyle(nav).backgroundColor &&
                  getComputedStyle(strip).backgroundImage === getComputedStyle(nav).backgroundImage
                );
              },
              match
            );
          }
        }
      } finally {
        await extraRow.evaluate((style) => style.remove());
        await gm.evaluate((id) => game.actors.get(id).toggleStatusEffect("prone", { active: false }), ids.actor);
        await setting(player, "actionHudDesign", "wood");
        await setting(player, "actionHudDetachHotbar", false);
        await setting(player, "actionHudShowEffects", false);
        await player.locator('#my-action-hud [data-group="rolls"]').click();
      }
    }
  );
}
