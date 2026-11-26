import { MODULE_ID } from "../constants.mjs";
import { ringRadius, slotOffsets } from "./layout.mjs";
import { DEFAULTS, MAX_SLOTS, normalize, SETTING, TRIGGERS } from "./settings.mjs";
import { GROUPS, STATS, slotAbbr } from "./stats.mjs";
import { text } from "./text.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PREVIEW_TOKEN = 72;
const PILL_ROOM = 14;
const FLAGS = ["players", "friendlyNpcs", "labels", "tempHp"];

const options = (entries, selected) =>
  entries.map(([value, label]) => ({ value, label, selected: value === selected }));

function statGroups(selected) {
  const grouped = GROUPS.map((group) => ({
    label: text(`group.${group}`),
    options: options(
      Object.entries(STATS)
        .filter(([, stat]) => stat.group === group)
        .map(([id, stat]) => [id, stat.label]),
      selected
    )
  }));
  const loose = Object.entries(STATS)
    .filter(([, stat]) => !stat.group)
    .map(([id, stat]) => [id, stat.label]);
  return [...grouped, { label: "", options: options(loose, selected) }];
}

export class PartyGlanceConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-party-glance-config",
    tag: "form",
    classes: ["my-party-glance-app"],
    window: {
      title: "MY_MODULES.PartyGlance.title",
      icon: "fa-solid fa-circle-nodes",
      contentClasses: ["standard-form"]
    },
    position: { width: 560 },
    actions: {
      focusSlot(_event, target) {
        this.active = Number(target.dataset.slot);
        this.render().then(() => this.element.querySelector(`.slot[data-slot="${this.active}"] select`)?.focus());
      },
      reset() {
        this.draft = normalize(DEFAULTS);
        this.render();
      }
    },
    form: {
      closeOnSubmit: true,
      handler(_event, _form, data) {
        this.apply(data.object);
        return game.settings.set(MODULE_ID, SETTING, this.draft);
      }
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/scripts/party-glance/config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  draft = normalize(game.settings.get(MODULE_ID, SETTING));
  active = 0;
  #focus = null;

  apply(data) {
    const form = foundry.utils.expandObject(data);
    const next = foundry.utils.deepClone(this.draft);
    if ("count" in form) next.count = Number(form.count);
    if ("trigger" in form) next.trigger = form.trigger;
    for (const flag of FLAGS) if (flag in form) next[flag] = Boolean(form[flag]);
    for (const [i, slot] of Object.entries(form.slots ?? {})) {
      const merged = { ...next.slots[i], ...slot };
      if (slot.stat !== next.slots[i].stat) {
        merged.sub = STATS[slot.stat]?.sub?.fallback;
        if (merged.sub === undefined) delete merged.sub;
      }
      next.slots[i] = merged;
    }
    this.draft = normalize(next);
  }

  _onChangeForm(_formConfig, event) {
    this.apply(new foundry.applications.ux.FormDataExtended(this.element).object);
    const name = event.target.name;
    if (name?.endsWith(".stat")) this.active = Number(name.split(".")[1]);
    // A text field changes on blur, when focus has already moved on to the next control.
    this.#focus = event.target.matches("select, input[type=checkbox]") ? name : null;
    this.render();
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (this.#focus) this.element.querySelector(`[name="${this.#focus}"]`)?.focus();
    this.#focus = null;
  }

  async _prepareContext() {
    const { count, slots, trigger } = this.draft;
    const radius = ringRadius(PREVIEW_TOKEN, count, PILL_ROOM);
    const offsets = slotOffsets(count, radius);
    const visible = slots.slice(0, count);
    return {
      text: Object.fromEntries(
        [
          "slotCount",
          "showRing",
          "previewHint",
          "slotsHeading",
          "slotsHint",
          "empty",
          "customAbbr",
          "customPath",
          "footer"
        ].map((key) => [key, text(key)])
      ),
      counts: Array.from({ length: MAX_SLOTS }, (_, i) => ({ value: i + 1, selected: i + 1 === count })),
      triggers: options(
        TRIGGERS.map((id) => [id, text(`trigger.${id}`)]),
        trigger
      ),
      previewDiameter: radius * 2,
      preview: visible.map((slot, i) => ({
        index: i,
        number: i + 1,
        name: text("slot", { n: i + 1 }),
        label: slot.stat ? STATS[slot.stat].label : text("emptyShort"),
        abbr: slot.stat ? slotAbbr(slot) : text("emptyShort"),
        empty: !slot.stat,
        active: i === this.active,
        ...offsets[i]
      })),
      rows: visible.map((slot, i) => {
        const stat = STATS[slot.stat];
        return {
          index: i,
          number: i + 1,
          name: text("slot", { n: i + 1 }),
          subName: text("slotSub", { n: i + 1 }),
          active: i === this.active,
          stat: slot.stat,
          groups: statGroups(slot.stat),
          subChoices: stat?.sub ? options(Object.entries(stat.sub.choices()), slot.sub || stat.sub.fallback) : null,
          kind: stat ? stat.kinds.map((kind) => text(`kind.${kind}`)).join(" · ") : "—",
          custom: slot.stat === "custom",
          abbr: slot.abbr ?? "",
          path: slot.path ?? ""
        };
      }),
      flags: FLAGS.map((id) => ({ id, label: text(id), value: this.draft[id] })),
      buttons: [
        { type: "button", action: "reset", icon: "fa-solid fa-rotate-left", label: text("reset") },
        { type: "submit", icon: "fa-solid fa-floppy-disk", label: text("save") }
      ]
    };
  }
}
