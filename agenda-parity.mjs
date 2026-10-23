export function madridDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function dateOffset(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

export function compareImportedAppointment(previous, incoming) {
  if (!previous) return [];
  const changes = [];
  if (previous.scheduled_time !== incoming.time) changes.push(`Hora ${previous.scheduled_time} → ${incoming.time}`);
  if ((previous.population ?? "") !== (incoming.population ?? "")) changes.push("Población modificada");
  if ((previous.phone ?? "") !== (incoming.phone ?? "")) changes.push("Teléfono modificado");
  if ((previous.full_address ?? "") !== (incoming.full_address ?? "")) changes.push("Dirección modificada");
  if ((previous.postal_code ?? "") !== (incoming.postal_code ?? "")) changes.push("Código postal modificado");
  return changes;
}

export function validateInstallation(row) {
  const issues = [];
  const digits = String(row.phone ?? "").replace(/\D/g, "");
  const phoneDigits = digits.startsWith("00") ? digits.slice(2) : digits;
  const normalizedDigits = phoneDigits.startsWith("34") && phoneDigits.length === 11 ? phoneDigits : phoneDigits;
  if (normalizedDigits.length < 9 || normalizedDigits.length > 15) issues.push("Teléfono no válido");
  if (!String(row.population ?? "").trim()) issues.push("Población no detectada");
  if (!String(row.full_address ?? "").trim()) issues.push("Dirección no detectada");
  return issues;
}

export function appointmentDateLabels(date, locale = "es-ES") {
  const parsed = new Date(`${date}T12:00:00Z`);
  return {
    chip: new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "2-digit", month: "short" }).format(parsed).replace(".", "").toUpperCase(),
    title: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(parsed),
  };
}

export function buildWhatsAppUrl(phone, message, userAgent = "") {
  const number = String(phone ?? "").replace(/\D/g, "");
  if (/Android/i.test(userAgent)) {
    return `intent://send?phone=${number}&text=${encodeURIComponent(message)}#Intent;scheme=whatsapp;package=com.whatsapp;end`;
  }
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function buildWhatsAppConversationUrl(phone, userAgent = "") {
  const number = String(phone ?? "").replace(/\D/g, "");
  if (/Android/i.test(userAgent)) {
    return `intent://send?phone=${number}#Intent;scheme=whatsapp;package=com.whatsapp;end`;
  }
  return `https://wa.me/${number}`;
}

export function buildMapsUrl(query, userAgent = "") {
  const encoded = encodeURIComponent(String(query ?? "").trim());
  if (/Android/i.test(userAgent)) {
    return `intent://maps.google.com/maps?q=${encoded}#Intent;scheme=https;package=com.google.android.apps.maps;end`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}
