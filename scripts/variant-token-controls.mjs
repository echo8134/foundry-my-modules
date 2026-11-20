import { MODULE_ID } from "./constants.mjs";
import { savedHidden } from "./variant-tokens.mjs";

function renderTokenHUD(hud, element) {
  const saved = savedHidden(hud.document._source.flags[MODULE_ID]);
  const button = element.querySelector('[data-action="visibility"]');
  if (saved == null || !button) return;
  const renderEye = (hidden) => {
    button.classList.toggle("active", hidden);
    button.setAttribute("aria-label", game.i18n.localize(hidden ? "HUD.Show" : "HUD.Hide"));
    const icon = button.querySelector("i");
    icon.classList.toggle("fa-eye", !hidden);
    icon.classList.toggle("fa-eye-slash", hidden);
  };
  renderEye(saved);
  button.onclick = (event) => {
    const current = savedHidden(hud.document._source.flags[MODULE_ID]);
    if (current == null) return;
    event.stopPropagation();
    const hidden = !current;
    const updates = hud.layer.controlled.map((object) => ({ _id: object.id, hidden }));
    hud.document.parent.updateEmbeddedDocuments("Token", updates).then(() => renderEye(hidden));
  };
}

export function setupVariantTokenControls() {
  Hooks.on("renderTokenHUD", renderTokenHUD);
  Hooks.on("renderTokenConfig", (sheet, element) => {
    const saved = savedHidden(sheet.document._source.flags[MODULE_ID]);
    const checkbox = element.querySelector('input[name="hidden"]');
    if (saved != null && checkbox) checkbox.checked = saved;
  });
}
