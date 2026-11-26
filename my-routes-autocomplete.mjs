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

// CONFIRMAR_CITAS-022: asistente de direcciones de Mis rutas (CartoCiudad, gratis; nunca Geoapify).
// Propone calles mientras se escribe (3 letras, 300 ms entre teclas) con el pueblo visible y, al elegir una,
// rellena calle, número, pueblo, provincia y código postal. «Escribir a mano» siempre está disponible.
export const ASSISTANT_DEBOUNCE_MS = 300;
export const ASSISTANT_MIN_LETTERS = 3;

export function bindAddressAssistant({ fields, search, eligible = () => true, cancelOthers = () => {}, document, place }) {
  const { street, number, municipality, province, postalCode } = fields;
  const results = document.createElement("div");
  results.className = "route-address-results";
  results.hidden = true;
  const listId = (street.id || "route-address") + "-suggestions";
  results.id = listId;
  street.setAttribute("role", "combobox");
  street.setAttribute("aria-autocomplete", "list");
  street.setAttribute("aria-expanded", "false");
  street.setAttribute("aria-controls", listId);
  if (place) place(results);
  else street.closest?.("label")?.after?.(results);
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const choices = document.createElement("div");
  choices.className = "route-address-options";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Direcciones sugeridas");
  const manualButton = document.createElement("button");
  manualButton.type = "button";
  manualButton.className = "button secondary";
  manualButton.textContent = "Escribir a mano";
  const attribution = document.createElement("small");
  attribution.textContent = "Direcciones: CartoCiudad © IGN-CNIG (CC BY 4.0)";
  attribution.hidden = true;
  results.append(status, choices, manualButton, attribution);
  let timer;
  let pending;
  let lastQuery = "";
  let manual = false;

  function open(visible) {
    results.hidden = !visible;
    street.setAttribute("aria-expanded", visible ? "true" : "false");
  }
  function clear() {
    clearTimeout(timer);
    pending?.abort();
    pending = undefined;
    lastQuery = "";
    choices.replaceChildren();
    status.textContent = "";
    attribution.hidden = true;
    open(false);
  }
  function choose(item) {
    const sameTown = municipality.value.trim().toLowerCase() === item.municipality.toLowerCase();
    street.value = item.street;
    // CONFIRMAR_CITAS-023: sin número en la sugerencia, el anterior (de otra calle) se vacía.
    number.value = item.number || "";
    municipality.value = item.municipality;
    if (province) province.value = item.province || (sameTown ? province.value : "");
    if (postalCode) postalCode.value = item.postalCode || (sameTown ? postalCode.value : "");
    clear();
    // Sin número en la sugerencia: el técnico lo escribe en «Número o S/N».
    (item.number ? street : number).focus();
  }
  async function lookup(query, controller) {
    const isCurrent = () => !controller.signal.aborted && pending === controller && eligible();
    if (!isCurrent()) return;
    open(true);
    status.textContent = "Buscando direcciones…";
    try {
      const items = await search({
        query, municipality: municipality.value.trim(), postalCode: postalCode?.value.trim() ?? "",
      }, controller.signal);
      if (!isCurrent()) return;
      choices.replaceChildren();
      status.textContent = items.length
        ? `${items.length === 1 ? "1 dirección sugerida" : items.length + " direcciones sugeridas"}. Elige una o escribe a mano.`
        : "Sin coincidencias. Puedes escribir la dirección a mano.";
      attribution.hidden = !items.length;
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button secondary";
        button.textContent = item.label;
        button.addEventListener("click", () => { if (isCurrent()) choose(item); });
        button.addEventListener("keydown", event => move(event, button));
        choices.append(button);
      }
    } catch {
      if (isCurrent()) status.textContent = "No se pudieron cargar sugerencias. Puedes escribir la dirección a mano.";
    }
  }
  function move(event, from) {
    const list = [...choices.children];
    const index = list.indexOf(from);
    if (event.key === "ArrowDown" && index < list.length - 1) { event.preventDefault(); list[index + 1].focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); (index > 0 ? list[index - 1] : street).focus(); }
  }
  manualButton.addEventListener("click", () => {
    manual = true;
    clear();
    street.focus();
  });
  street.addEventListener("focus", cancelOthers);
  municipality.addEventListener("input", clear);
  street.addEventListener("input", () => {
    const query = street.value.trim().replace(/\s+/g, " ");
    if (!query) manual = false;
    if (lastQuery === query) return;
    cancelOthers();
    clear();
    if (manual || !eligible() || query.replace(/[^\p{L}]/gu, "").length < ASSISTANT_MIN_LETTERS || query.length > 100) return;
    lastQuery = query;
    const controller = new AbortController();
    pending = controller;
    timer = setTimeout(() => void lookup(query, controller), ASSISTANT_DEBOUNCE_MS);
  });
  function escape(event) {
    if (event.key !== "Escape" || results.hidden) return;
    event.preventDefault();
    clear();
    street.focus();
  }
  street.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && !results.hidden && choices.children.length) {
      event.preventDefault();
      choices.children[0].focus();
    } else escape(event);
  });
  results.addEventListener("keydown", escape);
  return Object.assign(clear, { results, isManual: () => manual });
}
