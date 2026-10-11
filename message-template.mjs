export function derivePresentationName(fullName) {
  return String(fullName ?? "").trim().split(/\s+/u)[0] ?? "";
}

export function fillAppointmentTemplate(template, row = {}, presentationName, reason = "") {
  const values = {
    TECNICO: String(presentationName ?? "").trim(),
    POBLACION: row.population ?? "",
    HORA: row.scheduled_time ?? "",
    DIRECCION: [row.full_address, row.postal_code].filter(Boolean).join(" "),
    TELEFONO: row.phone ?? "",
    PROSPECTO: row.prospect_ref ?? "Sin prospecto",
    MTO: row.prospect_ref ?? "Sin prospecto",
    TIPO: row.installation_type || "Instalación",
    MOTIVO: reason,
  };
  let message = String(template ?? "");
  for (const [key, value] of Object.entries(values)) message = message.replaceAll(`{${key}}`, value || "");
  return message;
}

export function buildWhatsAppIntent(phone, message) {
  return `intent://send?phone=${phone}&text=${encodeURIComponent(message)}#Intent;scheme=whatsapp;package=com.whatsapp;end`;
}
