const FACES = [4, 6, 8, 10, 12, 20];
const trays = new WeakMap();
const label = (key) => game.i18n.localize(`MY_MODULES.DiceTray.${key}`);

// Only combine free-standing, additive dice. A die inside a product or a keep/drop term has a different meaning.
function sumTerms(formula) {
  const terms = [];
  const closing = [];
  const pairs = { "(": ")", "[": "]", "{": "}" };
  let start = 0;
  for (let i = 0; i < formula.length; i++) {
    const char = formula[i];
    if (char === closing.at(-1)) closing.pop();
    else if (closing.at(-1) === "]") continue;
    else if (pairs[char]) closing.push(pairs[char]);
    else if (!closing.length && (char === "+" || char === "-")) {
      const term = formula.slice(start, i).trim();
      if (!term || /[*/%<>=+^-]$/.test(term)) continue;
      terms.push(term);
      start = i;
    }
  }
  terms.push(formula.slice(start).trim());
  return terms;
}

function diceCount(term, faces) {
  const match = /^\+?\s*(\d*)d(\d+)$/i.exec(term);
  return match && Number(match[2]) === faces ? Number(match[1] || 1) : 0;
}

function readDraft(view, chat) {
  const { doc } = view.state;
  const block = doc.firstChild;
  if (doc.childCount !== 1 || block.type.name !== "paragraph") return null;
  if (!block.childCount) return { command: "/r ", formula: "", flavor: "", terms: [] };
  if (block.childCount !== 1 || !block.firstChild.isText || block.firstChild.marks.length) return null;
  const [rule, matches] = chat.constructor.parse(foundry.utils.escapeHTML(block.textContent.trim()));
  if (!chat.constructor.CHAT_COMMANDS[rule]?.isRoll || matches.length !== 1 || !matches[0]) return null;
  const [, command, formula, flavor] = matches[0];
  if (typeof command !== "string" || typeof formula !== "string") return null;
  return {
    command,
    formula: formula.trim(),
    flavor: flavor === undefined ? "" : ` #${flavor}`,
    terms: sumTerms(formula)
  };
}

function createTray(view, chatInput) {
  const input = view.dom.closest("#chat-message");
  const doc = input.ownerDocument;
  const tray = doc.createElement("div");
  tray.className = "my-dice-tray";
  tray.setAttribute("role", "group");
  tray.setAttribute("aria-label", label("Title"));
  tray.innerHTML = `
    ${FACES.map((faces) => `<button type="button" data-faces="${faces}"><img alt="" src="${foundry.utils.getRoute(`icons/svg/d${faces}-grey.svg`)}"><span>d${faces}</span><b hidden></b></button>`).join("")}
    <input class="my-dice-modifier" type="number" step="1" value="0">
    <div class="my-dice-modes"><button type="button" data-mode="kh" aria-pressed="false">ADV</button><button type="button" data-mode="kl" aria-pressed="false">DIS</button></div>
    <button type="button" class="my-dice-roll"><i class="fa-solid fa-dice" aria-hidden="true"></i></button>
    <div class="my-dice-quantity" popover><input type="number" min="1" max="999" step="1" required><button type="button"><i class="fa-solid fa-check" aria-hidden="true"></i></button></div>`;
  const buttons = Array.from(tray.querySelectorAll("[data-faces]"));
  const modes = Array.from(tray.querySelectorAll("[data-mode]"));
  const modifier = tray.querySelector(".my-dice-modifier");
  const submit = tray.querySelector(".my-dice-roll");
  const popup = tray.querySelector(".my-dice-quantity");
  const quantity = popup.querySelector("input");
  const confirm = popup.querySelector("button");
  let chosenDie;
  let busy = false;

  function describe(element, text) {
    element.title = text;
    element.setAttribute("aria-label", text);
  }
  describe(modifier, label("Modifier"));
  describe(submit, label("Roll"));
  describe(confirm, label("Add"));
  describe(quantity, label("Quantity"));
  for (const mode of modes) {
    describe(mode, label(mode.dataset.mode === "kh" ? "Advantage" : "Disadvantage"));
    mode.addEventListener("click", () => {
      const selected = mode.getAttribute("aria-pressed") === "false";
      for (const other of modes) other.setAttribute("aria-pressed", String(selected && other === mode));
    });
  }

  function addDice(faces, amount) {
    const draft = readDraft(view, chatInput.chat);
    if (!draft) return ui.notifications.warn(label("NeedRoll"));
    const { terms } = draft;
    const index = terms.findIndex((term) => diceCount(term, faces) > 0);
    let formula;
    if (index >= 0) {
      const total = diceCount(terms[index], faces) + amount;
      if (total > 999) return ui.notifications.warn(label("TooMany"));
      terms[index] = `${index ? "+" : ""}${total}d${faces}`;
      formula = terms.join("");
    } else {
      formula = `${draft.formula}${draft.formula ? "+" : ""}${amount}d${faces}`;
    }
    chatInput.setMessage(view, foundry.utils.escapeHTML(draft.command + formula + draft.flavor));
  }

  const confirmQuantity = () => {
    if (!quantity.reportValidity()) return;
    addDice(Number(chosenDie.dataset.faces), quantity.valueAsNumber);
    popup.hidePopover();
    chosenDie.focus();
  };
  confirm.addEventListener("click", confirmQuantity);
  quantity.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmQuantity();
    }
  });

  for (const button of buttons) {
    const faces = Number(button.dataset.faces);
    describe(button, game.i18n.format("MY_MODULES.DiceTray.Die", { die: `d${faces}` }));
    button.addEventListener("click", async (event) => {
      if (event.ctrlKey || event.metaKey) {
        try {
          await chatInput.chat.processMessage(`/r 1d${faces}`);
        } catch (error) {
          ui.notifications.error(error.message);
        }
      } else if (event.shiftKey) {
        chosenDie = button;
        quantity.value = "1";
        popup.showPopover();
        const anchor = button.getBoundingClientRect();
        popup.style.left = `${Math.min(anchor.left, doc.documentElement.clientWidth - popup.offsetWidth)}px`;
        popup.style.top = `${Math.max(0, anchor.top - popup.offsetHeight - 4)}px`;
        quantity.focus();
        quantity.select();
      } else {
        addDice(faces, 1);
      }
    });
  }

  submit.addEventListener("click", async () => {
    const draft = readDraft(view, chatInput.chat);
    if (busy || !draft?.formula || !modifier.reportValidity()) return;
    const mode = modes.find((element) => element.getAttribute("aria-pressed") === "true");
    let formula = draft.formula;
    if (mode) {
      const count = draft.terms.reduce((sum, term) => sum + diceCount(term, 20), 0);
      const simpleSum = draft.terms.every((term) => /^[+-]?\s*(?:\d*d\d+|\d+)$/i.test(term));
      if (count !== 1 || !simpleSum) return ui.notifications.warn(label("NeedD20"));
      formula = draft.terms
        .map((term) => (diceCount(term, 20) ? term.replace(/1?d20/i, `2d20${mode.dataset.mode}`) : term))
        .join("");
    }
    const bonus = modifier.valueAsNumber;
    if (bonus) formula += bonus > 0 ? `+${bonus}` : String(bonus);
    const before = view.state.doc;
    busy = submit.disabled = true;
    try {
      const result = await chatInput.chat.processMessage(
        foundry.utils.escapeHTML(draft.command + formula + draft.flavor)
      );
      if (result && !view.isDestroyed && view.state.doc === before) chatInput.setMessage(view, "");
    } catch (error) {
      ui.notifications.error(error.message);
    } finally {
      busy = false;
      if (!view.isDestroyed) update();
    }
  });

  function update() {
    const draft = readDraft(view, chatInput.chat);
    for (const button of buttons) {
      const count = draft?.terms.reduce((sum, term) => sum + diceCount(term, Number(button.dataset.faces)), 0) || 0;
      const badge = button.querySelector("b");
      badge.hidden = !count;
      badge.textContent = count || "";
    }
    submit.disabled = busy || !draft?.formula;
  }
  trays.set(input, tray);
  input.after(tray);
  update();
  return {
    update(_view, previous) {
      if (view.state.doc === previous.doc) return;
      if (!view.state.doc.textContent) {
        modifier.value = "0";
        for (const mode of modes) mode.setAttribute("aria-pressed", "false");
      }
      update();
    },
    destroy() {
      tray.remove();
      trays.delete(input);
    }
  };
}

export function setupDiceTray() {
  Hooks.on("createProseMirrorEditor", (_id, plugins) => {
    const chatInput = plugins.chatInput?.spec.instance;
    if (chatInput) plugins.myDiceTray = new foundry.prosemirror.Plugin({ view: (view) => createTray(view, chatInput) });
  });
  Hooks.on("renderChatInput", (_app, elements) => {
    const input = elements["#chat-message"];
    const tray = trays.get(input);
    if (tray && tray !== input.nextElementSibling) input.after(tray);
  });
}
