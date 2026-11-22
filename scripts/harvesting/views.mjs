import { MODULE_ID } from "../constants.mjs";
import { previewHarvest, sourceItem } from "./rules.mjs";

export const key = (name) => `MY_MODULES.Harvest.${name}`;
export const t = (name, data) => (data ? game.i18n.format(key(name), data) : game.i18n.localize(key(name)));
const esc = (value) => foundry.utils.escapeHTML(value);
const dialog = (options) => foundry.applications.api.DialogV2.wait(options);

function dangerText(danger) {
  if (!danger) return "";
  const details = [danger.text];
  if (danger.save)
    details.push(t("saveDetail", { dc: danger.save.dc, ability: CONFIG.DND5E.abilities[danger.save.ability].label }));
  if (danger.damage)
    details.push(
      `${danger.damage.formula} ${CONFIG.DND5E.damageTypes[danger.damage.type]?.label ?? danger.damage.type}`
    );
  return details.join(" · ");
}

export async function confirmRoll(action, actor, info) {
  const test =
    action === "appraise"
      ? t("appraiseCheck", { skill: CONFIG.DND5E.skills[info.skill].label, dc: info.dc })
      : t(info.withKit ? "kitCheck" : "kitlessCheck");
  return (
    (await dialog({
      classes: ["harvest-roll"],
      window: { title: key(action) },
      content: `<p>${esc(actor.name)} · ${esc(info.target)}</p><p>${esc(test)} · ${esc(t(info.mode))}</p>`,
      buttons: [
        { action: "roll", label: key("roll"), icon: "fa-solid fa-dice-d20", default: true },
        { action: "cancel", label: "COMMON.Cancel" }
      ]
    })) === "roll"
  );
}

export async function chooseAction() {
  return dialog({
    window: { title: key("title") },
    buttons: [
      { action: "appraise", label: key("appraise") },
      { action: "harvest", label: key("harvest") }
    ]
  });
}

function selection(form) {
  const fields = new FormData(form);
  return { condition: fields.get("condition"), ruined: fields.getAll("ruined"), passed: fields.getAll("passed") };
}

export async function reviewHarvest(actor, token, table, total, withKit) {
  const conditions = ["clean", "normal", "brutal"]
    .map((value) => `<option value="${value}" ${value === "normal" ? "selected" : ""}>${esc(t(value))}</option>`)
    .join("");
  const headings = ["part", "dc", "ruined", "passed", "outcome"]
    .map((name) => `<th scope="col">${esc(t(name))}</th>`)
    .join("");
  const rows = table.components
    .map((part, index) => {
      const check = (name) =>
        `<input type="checkbox" name="${name}" value="${esc(part.id)}" aria-label="${esc(`${t(name)} · ${part.name}`)}">`;
      return `<tr data-part="${index}"><th scope="row">${esc(part.name)} ×${part.quantity}
      ${part.danger ? `<small>${esc(dangerText(part.danger))}</small>` : ""}</th>
      <td class="harvest-dc"></td><td>${check("ruined")}</td><td>${check("passed")}</td><td class="harvest-outcome"></td></tr>`;
    })
    .join("");
  const itemHooks = [];
  return dialog({
    classes: ["harvest-review"],
    window: { title: key("review") },
    position: { width: 650 },
    content: `<p>${esc(t("rolled", { actor: actor.name, target: token.name, total }))}</p>
      <label>${esc(t("condition"))} <select name="condition">${conditions}</select></label>
      <table><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table>`,
    render: (_event, app) => {
      const form = app.element.querySelector("form");
      const update = () => {
        let ready = true;
        for (const [i, result] of previewHarvest(table, total, selection(form), withKit).entries()) {
          const row = form.querySelector(`[data-part="${i}"]`);
          row.querySelector(".harvest-dc").textContent = result.dc;
          const missing = result.outcome === "gained" && !sourceItem(result.component.item);
          if (missing) ready = false;
          row.querySelector(".harvest-outcome").textContent = missing
            ? t("missingItem", { item: result.component.item })
            : t(result.outcome);
          const pass = row.querySelector('[name="passed"]');
          pass.disabled = !["gained", "alternative", "passed"].includes(result.outcome);
          if (pass.disabled) pass.checked = false;
          row.dataset.outcome = result.outcome;
        }
        form.querySelector('[data-action="confirm"]').disabled = !ready;
      };
      for (const hook of ["createItem", "updateItem", "deleteItem"]) itemHooks.push([hook, Hooks.on(hook, update)]);
      form.addEventListener("change", update);
      update();
    },
    close: () => {
      for (const [hook, id] of itemHooks) Hooks.off(hook, id);
    },
    buttons: [
      {
        action: "confirm",
        label: key("confirm"),
        icon: "fa-solid fa-check",
        callback: (_event, button) => selection(button.form)
      },
      { action: "cancel", label: "COMMON.Cancel", default: true, callback: () => false }
    ]
  });
}

export function renderCard(card) {
  const lines = [];
  if (card.type === "appraisal") {
    lines.push(t(card.success ? "appraisalSuccess" : "appraisalFailure", card));
    for (const part of card.parts ?? [])
      lines.push(
        `${part.name} · ${t("partDC", part)}${part.edible ? ` · ${t("edible")}` : ""}${part.danger ? ` · ${dangerText(part.danger)}` : ""}`
      );
  } else if (card.type === "danger") {
    lines.push(t("triggered", card), dangerText(card.danger));
  } else {
    lines.push(t("harvestResult", card), card.parts.map((p) => `${p.name} ×${p.quantity}`).join(", ") || t("nothing"));
  }
  return lines.map((line) => `<p>${esc(line)}</p>`).join("");
}

export function renderHarvestMessage(message, html) {
  const card = message.getFlag(MODULE_ID, "harvestCard");
  if (!card || !message.isContentVisible || !message.author?.isGM) return;
  const content = html.querySelector(".message-content");
  if (!content) return;
  content.innerHTML = renderCard(card);
  const save = card.type === "danger" && card.danger.save;
  if (!save) return;
  const actor = fromUuidSync(card.actorUuid);
  if (!actor?.isOwner) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "harvest-save";
  button.textContent = t("rollSave");
  button.addEventListener("click", (event) => actor.rollSavingThrow({ event, ability: save.ability, target: save.dc }));
  content.append(button);
}
