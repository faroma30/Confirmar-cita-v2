import { cleanMapAddress, normalizePhone, normalizePhoneForCall, normalizePhoneForWhatsApp } from "./agenda-parser.mjs";
import { buildMapsUrl, buildWhatsAppConversationUrl } from "./agenda-parity.mjs";

const validPhone = (value) => {
  const digits = normalizePhone(value).replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 15;
};

export function buildIgnoredWorkActionLinks(item, userAgent = "") {
  const address = String(item?.full_address ?? "").trim();
  const population = String(item?.population ?? "").trim();
  const postalCode = String(item?.postal_code ?? "").trim();
  const mapAddress = cleanMapAddress(address, population);
  const mapQuery = [mapAddress, postalCode].filter(Boolean).join(", ");
  const phone = String(item?.phone ?? "");
  const hasValidPhone = validPhone(phone);

  return {
    maps: address && (population || postalCode) && mapQuery
      ? buildMapsUrl(mapQuery, userAgent) : "",
    call: hasValidPhone ? `tel:${normalizePhoneForCall(phone)}` : "",
    whatsapp: hasValidPhone
      ? buildWhatsAppConversationUrl(normalizePhoneForWhatsApp(phone), userAgent) : "",
  };
}

function addAction(document, container, label, href, unavailableMessage) {
  if (!href) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.textContent = label;
    button.disabled = true;
    button.title = unavailableMessage;
    button.setAttribute("aria-label", `${label}: ${unavailableMessage}`);
    container.append(button);
    return;
  }

  const link = document.createElement("a");
  link.className = "button secondary";
  link.textContent = label;
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", label);
  container.append(link);
}

export function createIgnoredWorkCard(item, document, userAgent = "") {
  const card = document.createElement("article");
  card.className = "appointment-card ignored-work-card";
  const title = document.createElement("h3");
  title.textContent = `${item.time || "Hora no detectada"} · ${item.type || "Trabajo ignorado"}`;
  card.append(title);

  const ignored = document.createElement("p");
  ignored.className = "appt-meta";
  ignored.textContent = "Ignorada · no es una instalación";
  card.append(ignored);

  if (item.customer_name) {
    const customer = document.createElement("p");
    customer.textContent = item.customer_name;
    card.append(customer);
  }
  const workInfo = [item.population, item.postal_code].filter(Boolean).join(" · ");
  if (workInfo) {
    const location = document.createElement("p");
    location.className = "appt-meta";
    location.textContent = workInfo;
    card.append(location);
  }

  const actions = document.createElement("div");
  actions.className = "appointment-actions ignored-work-actions";
  actions.setAttribute("aria-label", "Acciones rápidas del trabajo ignorado");
  const links = buildIgnoredWorkActionLinks(item, userAgent);
  addAction(document, actions, "Maps", links.maps, "Dirección insuficiente");
  addAction(document, actions, "Llamar", links.call, "Teléfono no válido");
  addAction(document, actions, "WhatsApp", links.whatsapp, "Teléfono no válido");
  card.append(actions);
  return card;
}
