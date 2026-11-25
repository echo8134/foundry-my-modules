import { sourceItem } from "../harvesting/rules.mjs";
import { dangerText, dialog, esc, key, liveReview, t } from "../harvesting/views.mjs";

export function choosePlantAction() {
  return dialog({
    window: { title: key("herbalism") },
    buttons: ["identify", "gather"].map((action) => ({ action, label: key(action) }))
  });
}

export function confirmPlantRoll(action, actor, info) {
  const choices = info.methods.map((method) => {
    const label = method === "herb" ? t("herbalismKit") : CONFIG.DND5E.skills[method].label;
    return `<option value="${method}">${esc(label)}</option>`;
  });
  const gatherers = info.gatherers.map(
    ({ uuid, name, dc }) => `<option value="${esc(uuid)}" data-dc="${dc}">${esc(name)}</option>`
  );
  const chooseGatherer =
    gatherers.length > 1
      ? `<label>${esc(t("gatherer"))} <select name="gatherer">${gatherers.join("")}</select></label>`
      : "";
  const description = action === "identify" ? t("partDC", info) : t(info.withKit ? "gatherKit" : "gatherKitless");
  return dialog({
    classes: ["herbalism-roll"],
    window: { title: key(action) },
    content: `<p>${esc(actor.name)} · ${esc(info.target)}</p>
      <label>${esc(t("checkMethod"))} <select name="method">${choices.join("")}</select></label>
      ${chooseGatherer}<p><span class="check-detail">${esc(description)}</span> · ${esc(t(info.mode))}</p>`,
    render: (_event, app) => {
      const select = app.element.querySelector('[name="gatherer"]');
      select?.addEventListener("change", () => {
        app.element.querySelector(".check-detail").textContent = t("partDC", {
          dc: select.selectedOptions[0].dataset.dc
        });
      });
    },
    buttons: [
      {
        action: "roll",
        label: key("roll"),
        default: true,
        callback: (_event, button) => ({
          method: button.form.elements.method.value,
          gathererUuid: button.form.elements.gatherer?.value ?? info.gatherers[0]?.uuid
        })
      },
      { action: "cancel", label: "COMMON.Cancel", callback: () => false }
    ]
  });
}

export function reviewGather(actor, token, rows, total) {
  const headings = ["part", "dc", "outcome"].map((key) => `<th scope="col">${esc(t(key))}</th>`).join("");
  const parts = rows.map(({ component, dc, outcome }, index) => {
    const choices = ["portion", "charge", "value"].map((value) => `<option value="${value}">${esc(t(value))}</option>`);
    const bonus =
      outcome === "superior"
        ? `<select name="bonus" aria-label="${esc(t("superiorBonus", { name: component.name }))}">${choices.join("")}</select>
          <label hidden>${esc(t("tradePrice"))} <input type="number" step="any" name="price"> <small class="currency"></small></label>`
        : "";
    const danger = component.danger ? `<small>${esc(dangerText(component.danger))}</small>` : "";
    return `<tr data-part="${index}" data-outcome="${outcome}"><th scope="row">${esc(component.name)} ×${component.quantity} ${danger}</th>
      <td>${dc}</td><td><span>${esc(t(outcome))}</span> ${bonus}</td></tr>`;
  });
  return dialog({
    classes: ["herbalism-review"],
    window: { title: key("reviewGather") },
    position: { width: 600 },
    content: `<p>${esc(t("gatherRolled", { actor: actor.name, target: token.name, total }))}</p>
      <table><thead><tr>${headings}</tr></thead><tbody>${parts.join("")}</tbody></table>`,
    ...liveReview((form) => {
      let ready = true;
      for (const [index, { component, outcome }] of rows.entries()) {
        if (!["gained", "superior"].includes(outcome)) continue;
        const row = form.querySelector(`[data-part="${index}"]`);
        const source = sourceItem(component.item);
        const uses = source?.toObject().system.uses;
        let problem;
        if (!source) problem = t("missingItem", { item: component.item });
        else if (component.charges && !uses) problem = t("needItemUses", { name: source.name });
        else if (component.charges && !Roll.validate(component.charges))
          problem = t("invalidCharges", { name: source.name });
        if (problem) ready = false;
        const details = [t(outcome)];
        if (component.charges) details.push(t("specimenCharges", { charges: component.charges }));
        row.querySelector("span").textContent = problem ?? details.join(" · ");
        const select = row.querySelector("select");
        if (!select) continue;
        const charge = select.querySelector('[value="charge"]');
        charge.disabled = !uses || !(component.charges || uses.max);
        const price = source?.system.price;
        select.querySelector('[value="value"]').disabled = !price;
        if (!select.dataset.initialized) {
          select.value = charge.disabled ? "portion" : "charge";
          select.dataset.initialized = "true";
        } else if (select.selectedOptions[0]?.disabled) select.value = "portion";
        const amount = row.querySelector('[name="price"]');
        amount.parentElement.hidden = select.value !== "value";
        if (select.value === "value") {
          row.querySelector(".currency").textContent = price.denomination;
          if (!Number.isFinite(amount.valueAsNumber) || amount.valueAsNumber <= price.value) ready = false;
        }
      }
      form.querySelector('[data-action="confirm"]').disabled = !ready;
    }),
    buttons: [
      {
        action: "confirm",
        label: key("confirmGather"),
        callback: (_event, button) =>
          rows.map((_row, index) => {
            const row = button.form.querySelector(`[data-part="${index}"]`);
            return {
              bonus: row.querySelector("select")?.value,
              price: row.querySelector('[name="price"]')?.valueAsNumber
            };
          })
      },
      { action: "cancel", label: "COMMON.Cancel", default: true, callback: () => false }
    ]
  });
}
