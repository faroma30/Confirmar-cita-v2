const normalizeText = (value = "") => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function normalizePhone(value = "") {
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("34") && digits.length === 11) return `+${digits}`;
  if (digits.length > 9 && !digits.startsWith("34")) return `+${digits}`;
  return digits;
}

function cleanAddress(value = "") {
  return String(value).replace(/\b0+(\d+)\b/g, (_match, digits) => String(Number(digits)))
    .replace(/\s+/g, " ").trim();
}

function normalizePopulation(value = "") {
  let result = String(value).trim();
  const matches = [...result.matchAll(/\(([^)]+)\)/g)];
  if (matches.length) result = matches.at(-1)[1];
  return result.toLocaleLowerCase("es-ES").replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toLocaleUpperCase("es-ES"));
}

export function parseOracleInstallations(text, keywords = ["kit hogar", "kit básico", "kit basico", "kit negocio", "kit premium"]) {
  const normalized = String(text ?? "").replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const starts = [...normalized.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)];
  const installations = [];
  const ignored = [];
  const normalizedKeywords = (Array.isArray(keywords) ? keywords : []).map(normalizeText).filter(Boolean);

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index;
    const segment = normalized.slice(start, starts[index + 1]?.index ?? normalized.length);
    const time = starts[index][1].padStart(5, "0");
    const type = segment.match(/Tipo:\s*(.*?)\s+Panel:/i)?.[1]?.trim() ?? "";
    const isInstallation = normalizedKeywords.some((keyword) => normalizeText(type).includes(keyword));
    const prospect = segment.match(/Mto:\s*-?(\d+)/i)?.[1] ?? "";
    const phone = normalizePhone(segment.match(/Tlf:\s*([+\d][\d\s()-]{7,})/i)?.[1] ?? "");
    let population = "";
    let fullAddress = "";
    let postalCode = "";
    const panelAt = segment.search(/Panel:/i);
    const postalAt = segment.search(/\sCP:/i);
    if (panelAt >= 0 && postalAt > panelAt) {
      const parts = segment.slice(panelAt, postalAt).replace(/^Panel:\s*/i, "").trim().split(/\s+-\s+/);
      if (parts.length >= 2) {
        parts.shift();
        population = normalizePopulation(parts.shift());
        fullAddress = cleanAddress(parts.join(" - "));
      }
    }
    postalCode = segment.match(/CP:\s*([\w -]{3,20})/i)?.[1]?.trim().split(/\s+/)[0] ?? "";
    const entry = {
      time,
      type,
      kind: isInstallation ? "installation" : "maintenance_or_other",
      prospect_ref: prospect || null,
      phone,
      population,
      full_address: fullAddress,
      postal_code: postalCode,
    };
    if (isInstallation) installations.push(entry);
    else ignored.push({ time, type: type || "Tipo no detectado" });
  }
  return { installations, ignored };
}

export function normalizePhoneForWhatsApp(value) {
  const phone = normalizePhone(value);
  if (!phone) return "";
  return phone.startsWith("+") ? phone.slice(1) : `34${phone}`;
}

export function normalizePhoneForCall(value) {
  const phone = normalizePhone(value);
  if (!phone) return "";
  return phone.startsWith("+") ? phone : `+34${phone}`;
}

export function cleanMapAddress(address = "", population = "") {
  const parts = String(address).trim().split(/\s+/);
  const cleaned = [];
  for (const part of parts) {
    cleaned.push(part);
    if (/^\d+[A-Za-z]?$/.test(part)) break;
  }
  return [cleaned.join(" "), population].filter(Boolean).join(", ");
}

export async function stableSourceKey(userId, workDate, row, occurrence = 0) {
  const identity = row.prospect_ref
    ? `prospect:${String(row.prospect_ref).trim().toUpperCase()}`
    : `fallback:${workDate}:${row.time}:${String(row.population).toLocaleLowerCase("es-ES")}:${String(row.type).toLocaleLowerCase("es-ES")}:${occurrence}`;
  const bytes = new TextEncoder().encode(`${userId}:${identity}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  hex = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${(parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
