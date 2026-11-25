import { harvested, harvestRound, openHarvestRound } from "./award.mjs";
import { harvestTable, isCorpse } from "./rules.mjs";
import { t } from "./views.mjs";

function renderStatus(hud, element) {
  element.querySelector(".my-harvest-status")?.remove();
  const token = hud.document;
  if (!token || !isCorpse(token) || !harvestTable(token)) return;

  const round = harvestRound(token);
  const done = harvested(token, round);
  const reset = done && game.user.isGM;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon my-harvest-status";
  button.dataset.state = done ? "harvested" : "unharvested";
  const status = t(done ? "statusHarvested" : "statusUnharvested");
  const label = reset ? `${status} · ${t("resetHarvest")}` : status;
  button.setAttribute("aria-label", label);
  button.dataset.tooltipText = label;
  button.disabled = !reset;
  button.innerHTML = `<i class="fa-solid ${done ? "fa-circle-check" : "fa-sickle"}" inert></i>`;
  if (reset)
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (hud.document !== token) return;
      try {
        await openHarvestRound(token, round);
      } catch (error) {
        ui.notifications.error(foundry.utils.escapeHTML(error.message));
      }
    });
  element.querySelector(".col.left")?.append(button);
}

export function setupCorpseHUD() {
  Hooks.on("renderTokenHUD", renderStatus);
  Hooks.on("updateToken", (token) => {
    const hud = canvas?.hud?.token;
    if (hud?.rendered && hud.document === token) renderStatus(hud, hud.element);
  });
}
