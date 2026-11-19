import { MODULE_ID } from "./constants.mjs";

function renderTokenHUD(hud, element) {
  const saved = hud.document.getFlag(MODULE_ID, "restore");
  const button = element.querySelector('[data-action="visibility"]');
  if (!saved || !button) return;
  const renderEye = (hidden) => {
    button.classList.toggle("active", hidden);
    button.setAttribute("aria-label", game.i18n.localize(hidden ? "HUD.Show" : "HUD.Hide"));
    const icon = button.querySelector("i");
    icon.classList.toggle("fa-eye", !hidden);
    icon.classList.toggle("fa-eye-slash", hidden);
  };
  renderEye(saved.hidden);
  button.onclick = (event) => {
    const restore = hud.document.getFlag(MODULE_ID, "restore");
    if (!restore) return;
    event.stopPropagation();
    const hidden = !restore.hidden;
    const updates = hud.layer.controlled.map((object) => ({ _id: object.id, hidden }));
    hud.document.parent.updateEmbeddedDocuments("Token", updates).then(() => renderEye(hidden));
  };
}

export function setupVariantTokenControls() {
  Hooks.on("renderTokenHUD", renderTokenHUD);
  Hooks.on("renderTokenConfig", (sheet, element) => {
    const saved = sheet.document.getFlag(MODULE_ID, "restore");
    const checkbox = element.querySelector('input[name="hidden"]');
    if (saved && checkbox) checkbox.checked = saved.hidden;
  });
}
