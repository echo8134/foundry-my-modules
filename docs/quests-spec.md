# Quests and the landing board: specification

The DM's goal (2026-11-19): a quest log in this module with the features of Forien's Quest Log (FQL), which stops at Foundry 13, so the table depends on no outside module. Quests are mostly created by the DM's vault scripts through the foundry-mcp bridge, and the DM ticks objectives in Foundry. The landing scene "Startseite" (a quest board with pinned portraits) gets quest notes that open their quest, and a calendar sheet. Do not copy FQL code; build the features fresh.

Foundry 14 only, dnd5e 6.1 on the table, ApplicationV2 with `HandlebarsApplicationMixin`, plain ES modules like the rest of `scripts/`, German and English strings in `lang/`, Biome clean (`npm run check`).

## Data model

A quest is an ordinary `JournalEntry`, so the bridge's generic `create_documents` and `update_documents` can write it without a tool of its own, and Foundry's own permissions decide who sees it.

- **Where:** a journal folder named by the world setting `questFolder` (default "Quests"). The module creates it on first use (GM only).
- **Quest data:** the flag `flags.foundry-my-modules.quest`:

```js
{
  status: "active" | "available" | "completed" | "failed" | "hidden", // hidden: the GM's alone
  giver: { name: "Carolyn", img: "path/to/portrait.webp", uuid: "Actor.abc" | null },
  objectives: [            // ordered; nesting is one level of children
    { id: "find-herb", text: "Finde das Fieberkraut", done: false, hidden: false,
      children: [{ id: "ask-sulwotik", text: "...", done: false, hidden: false }] }
  ],
  rewards: [               // an item to drag onto a sheet, or a line of text
    { id: "r1", uuid: "Item.xyz" | null, text: "50 Gold", hidden: false, locked: true }
  ],
  parent: "JournalEntry.<id>" | null,   // a sub-quest names its parent quest
  personal: [],            // user ids who may see it; empty means every player
  primary: false,          // at most one quest is primary at a time
  source: "The Baker's Husband" | null, // the vault's key for the sync; never shown
  sort: 0
}
```

- **Text:** the journal's pages. A text page "Beschreibung" (players read it) and a text page "SL-Notizen" whose own ownership is the GM's alone. More pages are allowed and shown in order.
- **Visibility:** the module keeps the journal's ownership in step with the data: `hidden` gives players no access; any other status gives every player in `personal` (or all players when empty) OBSERVER. It writes ownership only when it differs (idempotent). Foundry sends world documents to every client, so a hidden objective is only hidden from the interface, as in FQL; say so in the README.
- **Ids:** objective and reward ids are stable slugs. The vault sync keys them by id: the vault owns the texts and the list, Foundry owns `done` and `hidden` once a quest exists. The module never renames an id.
- All writes go through one small data layer (`scripts/quests/data.mjs` or similar) so the windows never touch flags directly.

## Stages

Each stage is one branch in its own worktree, ends with `npm run check` clean, new e2e checks in `e2e/quests.e2e.mjs` (added to `npm run e2e`) passing against the test world, a README section, and lang strings in both files. Stages run one after another.

### Stage 1: log and sheet

- **Quest Log window:** tabs Laufend, Verfügbar, Erledigt, Gescheitert, and for the GM Versteckt; each row shows the giver's image, the name and the objectives done of total. A GM can create a quest (empty, status hidden), delete one (with Foundry's confirm dialog), and change its status from a row's context menu.
- **Quest sheet:** opens from a row. Players see the giver, the description pages, the objectives that are not hidden (done ones struck through) and the rewards that are not hidden. The GM sees everything, hidden parts marked, and edits in place: name, giver (drop an actor or pick an image), status, objectives (add, edit text, nest one level, reorder by drag, toggle done, toggle hidden, delete), the pages through Foundry's own page editor.
- **Access:** a button at the bottom of the Journal directory, a tool in the Notes scene controls, and a keybinding (default Ctrl+Q) for the log. The sheet re-renders when its journal changes (the `updateJournalEntry` hook), for everyone looking at it.
- **API:** `game.modules.get("foundry-my-modules").api.quests` with `open()`, `openQuest(uuid)`, `list()` (the quests the current user may see, as plain data).
- **e2e:** the GM creates a quest, adds two objectives, hides one, sets it active; the player sees the quest under Laufend with one objective; the GM ticks it done and the player's sheet updates without a reload; a hidden quest does not reach the player's log.

### Stage 2: rewards, personal quests, sub-quests, tracker

- **Rewards:** the GM drops an Item onto the sheet to add it, or adds a text line; each reward can be hidden and locked. A player drags an unlocked item reward onto their actor sheet (the standard Foundry item drag data, so dnd5e takes it). Text rewards are only shown.
- **Personal quests:** the GM picks players on the sheet; ownership follows (see Visibility).
- **Sub-quests:** a quest can name a parent; the parent's sheet lists its sub-quests with their status, the log indents them under the parent.
- **Primary quest:** one quest can be primary (the GM sets it); a second keybinding (Ctrl+Shift+Q) opens it.
- **Quest Tracker:** a small panel at the screen edge, toggled by a keybinding (Ctrl+Alt+Q) and a button in the log, listing the active quests the user may see with their open objectives; collapsible per quest; position and collapsed state per user (client setting).
- **e2e:** a locked reward cannot be dragged, an unlocked one lands on the player's actor; a personal quest reaches only its player; the tracker lists an active quest and drops it when completed.

### Stage 3: the landing board

- **Quest notes:** a Tile with the flag `flags.foundry-my-modules.quest = "JournalEntry.<id>"` opens that quest's sheet when anyone clicks it on the canvas, players included (Foundry gives players no tile interaction, so the module adds a pointer handler on flagged tiles; a hover shows a pointer cursor). Nothing else about tiles changes.
- **Calendar sheet:** a Tile with the flag `flags.foundry-my-modules.calendarSheet = true` shows a parchment sheet of the current month, drawn by the module from `game.time` and dnd5e's calendar (`CONFIG.time.worldCalendarConfig`, Harptos on the table): the month's name, its days in rows of tendays, a festival day after its month where the calendar has one, past days struck through, and an ink X over today. It redraws when the world time changes (`updateWorldTime` hook). The tile's texture is only the blank parchment; the drawing sits on top of it at the tile's size and rotation.
- **e2e:** a click on a flagged tile opens the quest for the player; advancing the world time by a day moves the X.

## Not in scope

The vault side (writing quests from the vault's quest cards, the weekly refresh in session prep, drawing note textures) is built in the ROTD repo, not here. Socket messages are not needed: only the GM writes, everyone reads documents.
