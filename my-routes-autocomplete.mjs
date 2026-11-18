const DEBOUNCE_MS = 450;

export function bindRouteAutocomplete({ fields, search, eligible, cancelOthers, document }) {
  const { street, municipality, province, postalCode } = fields;
  const results = document.createElement("div");
  results.className = "route-address-results";
  results.id = street.id + "-suggestions";
  results.hidden = true;
  street.setAttribute("aria-controls", results.id);
  street.closest("label").after(results);
  const status = document.createElement("div");
  status.className = "muted";
  status.setAttribute("role", "status");
  const choices = document.createElement("div");
  choices.className = "route-address-options";
  const attribution = document.createElement("small");
  attribution.append("Datos: ");
  for (const [index, [label, url]] of [
    ["Geoapify", "https://www.geoapify.com/"], ["© OpenStreetMap", "https://www.openstreetmap.org/copyright"],
  ].entries()) {
    if (index) attribution.append(" · ");
    const link = document.createElement("a");
    link.textContent = label;
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    attribution.append(link);
  }
  results.append(status, choices, attribution);
  let timer;
  let pending;
  let lastQuery = "";

  function clear() {
    clearTimeout(timer);
    pending?.abort();
    pending = undefined;
    lastQuery = "";
    choices.replaceChildren();
    status.textContent = "";
    attribution.hidden = true;
    results.hidden = true;
  }
  async function lookup(query, controller) {
    const isCurrent = () => !controller.signal.aborted && pending === controller && eligible();
    if (!isCurrent()) return;
    results.hidden = false;
    status.textContent = "Buscando direcciones…";
    try {
      const items = await search(query, controller.signal);
      if (!isCurrent()) return;
      status.textContent = items.length ? "Selecciona una calle y su municipio." : "Sin coincidencias. Puedes continuar manualmente.";
      attribution.hidden = !items.length;
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button secondary";
        button.textContent = [item.street, item.municipality, item.province, item.displayPostalCode || item.postalCode].filter(Boolean).join(" · ");
        button.addEventListener("click", () => {
          if (!isCurrent()) return;
          street.value = item.street;
          municipality.value = item.municipality;
          if (province) province.value = item.province ?? "";
          postalCode.value = item.postalCode;
          fields.number.focus();
          clear();
        });
        choices.append(button);
      }
    } catch {
      if (isCurrent()) status.textContent = "No se pudieron cargar sugerencias. Puedes introducir la dirección manualmente.";
    }
  }
  street.addEventListener("focus", cancelOthers);
  municipality.addEventListener("input", () => { if (province) province.value = ""; clear(); });
  street.addEventListener("input", () => {
    if (province) province.value = "";
    const query = street.value.trim().replace(/\s+/g, " ");
    if (lastQuery === query) return;
    cancelOthers();
    clear();
    if (!eligible() || query.length < 4 || query.length > 100) return;
    lastQuery = query;
    const controller = new AbortController();
    pending = controller;
    timer = setTimeout(() => void lookup(query, controller), DEBOUNCE_MS);
  });
  function escape(event) {
    if (event.key !== "Escape" || results.hidden) return;
    event.preventDefault();
    clear();
    street.focus();
  }
  street.addEventListener("keydown", escape);
  results.addEventListener("keydown", escape);
  return clear;
}
