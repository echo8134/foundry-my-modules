# Safety tools and an action HUD: specification

The DM's rule (2026-11-19): the table runs its own modules rather than outside ones. Two outside modules are replaced by features of this module: Safety Tools (p4535992/foundryvtt-safety-tools, BSD-3-Clause) and Token Action HUD Core with its D&D 5e adapter (Larkinabout, no licence on GitHub). The action HUD is written fresh: do not read, copy or port Token Action HUD's code. Safety tools are also written fresh; nothing has to be taken from the original.

Foundry 14 only, dnd5e 6.1, ApplicationV2 with `HandlebarsApplicationMixin`, plain ES modules, German and English strings in `lang/`, Biome clean (`npm run check`), e2e checks in `e2e/` added to `npm run e2e`, a README section per feature. The look follows the quest log: parchment and plank textures and the bundled IM Fell fonts already in `assets/`.

## Safety tools

The table's consent tools, for every user, each one optional by a world setting (all on by default).

- **X-card.** A button visible to every user (a top-level scene control below Quests, a card icon) shows an X-card prompt: "Etwas stört mich, bitte weiter" with an optional free-text line. On confirm, every client sees a large X-card overlay for a few seconds and a chat message to all, both without the sender's name: the module routes it through the active GM's client (a socket message via `game.socket` on the module's channel, declared with `"socket": true` in module.json), so no client ever receives who sent it. The GM sees the free text; players see only the card. The overlay can be dismissed with a click.
- **Lines and veils.** A shared list the table keeps between sessions: two columns, Lines (out of the game) and Veils (only off screen). Any user can add an entry anonymously; only the GM can edit or remove. Stored in a world setting (written by the GM's client on request through the same socket path, so players need no write rights). Opened from the same control (a second tool in a small menu, or a tab in one window).
- **Open door.** A small button in the safety window: "Ich brauche eine Pause / ich gehe kurz raus", posted to chat with the user's name (this one is not anonymous), so leaving needs no explanation.
- **e2e:** a player's X-card reaches the GM and another player as an overlay and a chat message that carries no user id, alias or speaker of the sender (check the ChatMessage data, not only the rendered text); a player adds a line that appears for everyone and cannot delete it; the GM deletes it.

## Action HUD for dnd5e

A compact bar for the selected token's actor, so nobody has to open the sheet in combat.

- **When it shows:** for a user with OWNER permission over the controlled token's actor (the GM for any controlled token); one actor at a time, the first controlled token; hidden with no token controlled. A client setting turns it off; a keybinding toggles it.
- **Where:** a bar above the hotbar, draggable, its position stored per user (client setting); it does not cover the chat or the scene controls.
- **Groups**, each a button that folds out its entries: Angriffe (weapons and other items with an attack activity), Zauber (by level, cantrips first, only prepared or always-prepared and innate/pact ones, with remaining slots per level shown), Merkmale (feats and class features with an activity), Gegenstände (consumables and other usable items, with quantity), Würfe (the six ability checks, the six saving throws, the skills, with the actor's modifiers), Zustände (toggle the common conditions with dnd5e's own status effects), Rasten (short and long rest). Empty groups are hidden.
- **What a click does:** the dnd5e action itself, never a reimplementation: `item.use()` for items and spells (dnd5e opens its own usage dialog), `actor.rollAbilityCheck`, `rollSavingThrow`, `rollSkill`, `actor.toggleStatusEffect`, `actor.shortRest` / `longRest`. Shift-click skips the dialog where dnd5e supports a fast-forward. Right-click on an item shows its tooltip or opens its sheet.
- **Live:** re-renders when the actor, its items or the controlled token change; uses remaining (uses, slots, quantity) shown and kept current.
- **e2e:** a player who owns an actor sees the bar when controlling its token and not for a token they do not own; a click on a weapon calls `item.use`, on a skill calls `rollSkill` (spy, no real dialog needed), on a condition toggles it on the actor; spell slots shown match the actor's data.

## Order

1. Safety tools (version 0.6.0).
2. Quest log stage 2 (`docs/quests-spec.md`).
3. Action HUD (0.7.0 or later).
4. Quest log stage 3.

Each stage: its own worktree and branch, a review by an agent that did not write it, a release, and screenshots from the test world for the DM before it reaches the table's server.
