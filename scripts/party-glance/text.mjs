import english from "../../lang/en.json" with { type: "json" };

export function text(key, data = {}) {
  return english[`MY_MODULES.PartyGlance.${key}`].replace(/\{(\w+)\}/g, (_, name) => data[name] ?? "");
}
