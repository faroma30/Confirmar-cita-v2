// CONFIRMAR_CITAS-027: análisis de las direcciones de Oracle (texto, tipo de vía, portal y complemento).
// Módulo sin dependencias y duplicado byte a byte en la app (`my-routes-address.mjs`) para que la pantalla
// y la función lean las direcciones igual; tests/my-routes-calle-libre.test.mjs comprueba que no divergen.

export const field = value => typeof value === "string" ? value.trim() : "";
// The acute accent used as an apostrophe («D´EN») separates words, like «'» (CONFIRMAR_CITAS-017).
export const normalized = value => field(value).replace(/[´`‘’ʼ′]/gu, " ").normalize("NFD").replace(/\p{Diacritic}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// CONFIRMAR_CITAS-015: Oracle writes addresses in capitals, with duplicated street types
// ("CALLE CARRER DE ...") and acute accents used as apostrophes ("L´ESTACIÓ").
const APOSTROPHES = /[´`‘’ʼ′]/gu;
// CONFIRMAR_CITAS-018: Catalan and Spanish street-type abbreviations, with or without a dot or a slash
// ("PTGE X", "Ptge. X", "C/X", "AVGDA X"), expanded before searching and comparing. `null` marks an
// ambiguous abbreviation (PSG: passeig or passatge; CR: carrer or carretera): it is dropped and the street
// is searched by its name only, like a street that Oracle writes without a type.
const TYPE_ABBREVIATIONS = {
  c: "Calle", cl: "Calle", cll: "Calle",
  av: "Avenida", avd: "Avenida", avda: "Avenida", avgda: "Avinguda", avg: "Avinguda",
  pza: "Plaza", pz: "Plaza", plz: "Plaza", pl: "Plaza", "pça": "Plaça", pca: "Plaça", "plça": "Plaça",
  ps: "Paseo", pso: "Paseo", "pº": "Paseo", pg: "Passeig",
  ptge: "Passatge", ptg: "Passatge", pje: "Pasaje", psje: "Pasaje", pj: "Pasaje",
  ctra: "Carretera", crta: "Carretera",
  rda: "Ronda", rbla: "Rambla",
  trav: "Travessera", trv: "Travesía", tv: "Travesía",
  cm: "Camino", cno: "Camino", cmno: "Camino",
  urb: "Urbanización", urbz: "Urbanización",
  pol: "Polígono", polig: "Polígono",
  bda: "Barriada",
  psg: null, cr: null,
};
const LEADING_TYPE = /^(\p{L}{1,5}º?)(?:\s*[./]+\s*|\s+)(?=\S)/u;
function expandType(text) {
  const match = LEADING_TYPE.exec(text);
  const key = match?.[1].toLowerCase();
  if (!match || !Object.hasOwn(TYPE_ABBREVIATIONS, key)) return text;
  const rest = text.slice(match[0].length);
  return TYPE_ABBREVIATIONS[key] ? TYPE_ABBREVIATIONS[key] + " " + rest : rest;
}
const GENERIC_TYPES = new Set(["calle", "cl", "c", "avenida", "av", "avda", "plaza", "pza", "pl", "paseo", "ps", "pg",
  "camino", "carretera", "ctra"]);
export const PARTICLES = new Set(["de", "del", "la", "las", "los", "el", "y", "i", "en", "les", "dels", "els", "al", "a", "da", "do", "das", "dos"]);
const capitalize = word => word.replace(/(^|-)(\p{L})/gu, (_, start, letter) => start + letter.toUpperCase());

function titleCase(value) {
  return value.split(" ").map((word, index) => word.toLowerCase().split("'").map((part, position, all) => {
    if (!part) return part;
    const first = index === 0 && position === 0;
    // Elided articles keep their lower case: l'Estació, d'Espanya.
    if (position < all.length - 1 && [...part].length <= 2) return first ? capitalize(part) : part;
    return !first && PARTICLES.has(part) ? part : capitalize(part);
  }).join("'")).join(" ");
}

export function cleanOracleText(value) {
  let text = field(value).replace(APOSTROPHES, "'").replace(/\s*'\s*/gu, "'").replace(/\s+/gu, " ").trim();
  const capitals = /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text);
  text = expandType(text);
  const words = text.split(" ");
  // "CALLE CARRER DE ..." keeps the specific type ("Carrer de ...").
  while (words.length > 2 && GENERIC_TYPES.has(normalized(words[0])) && streetTypes.has(normalized(words[1]))) words.shift();
  text = words.join(" ");
  return capitals ? titleCase(text) : text;
}

export const STREET = /^[\p{L}][\p{L}\p{N} .’'ºª/-]{1,119}$/u;
export const LOCALITY = /^[\p{L}][\p{L} .’'-]{1,99}$/u;

export const streetTypes = new Map([
  ["calle", "street"], ["carrer", "street"], ["rua", "street"], ["c", "street"],
  ["avenida", "avenue"], ["avinguda", "avenue"], ["av", "avenue"], ["avda", "avenue"],
  ["plaza", "square"], ["placa", "square"], ["passeig", "promenade"], ["paseo", "promenade"],
  ["via", "way"], ["cl", "street"], ["pza", "square"], ["pl", "square"], ["ps", "promenade"],
  ["ronda", "ronda"], ["rambla", "rambla"], ["camino", "path"], ["cami", "path"],
  ["travesia", "crossing"], ["travessera", "crossing"], ["carretera", "road"], ["ctra", "road"],
  ["pg", "promenade"], ["pca", "square"],
  // CONFIRMAR_CITAS-018: the rest of the Catalan and Spanish types and their abbreviations (same classes).
  ["cll", "street"], ["avd", "avenue"], ["avg", "avenue"], ["avgda", "avenue"], ["pz", "square"], ["plz", "square"],
  ["plca", "square"], ["placeta", "square"], ["pso", "promenade"], ["pº", "promenade"],
  ["passatge", "passage"], ["pasaje", "passage"], ["ptge", "passage"], ["ptg", "passage"], ["pje", "passage"],
  ["psje", "passage"], ["pj", "passage"], ["crta", "road"], ["rda", "ronda"], ["rbla", "rambla"],
  ["travessia", "crossing"], ["trav", "crossing"], ["trv", "crossing"], ["tv", "crossing"],
  ["cm", "path"], ["cno", "path"], ["cmno", "path"],
  ["urbanitzacio", "urbanization"], ["urbanizacion", "urbanization"], ["urb", "urbanization"], ["urbz", "urbanization"],
  ["poligon", "industrial"], ["poligono", "industrial"], ["pol", "industrial"], ["polig", "industrial"],
  ["barriada", "district"], ["bda", "district"],
]);

// CONFIRMAR_CITAS-027: Oracle writes the street followed by the portal number; whatever comes after the portal
// (floor, door, staircase: «1º E», «6 3», «PRAL», «ESC A», «2N 1A»…) is a complement: it is kept apart and
// never sent to CartoCiudad or Geoapify. The portal is therefore the FIRST number after the street, unless
// that number is part of the street name («CALLE 9 DE JULIO 12», «CARRETERA N 340 12»).
const NUMBER_MARK = /^(?:nº|n°|n\.º|num|núm|numero|número|nro)\.?$/u;
const PORTAL = /^(\d{1,5})([a-z])?(?:[-/](\d{1,5})[a-z]?)?$/u;
const bare = word => word.toLowerCase().replace(/\.+$/u, "");
// «1º», «2ª», «1r», «2n»: a floor or a door, never a portal.
const ordinalWord = word => /^\d{1,3}(?:[ºª°]|r|n|t|er|on)(?:[-/]\d{1,3}[ºª°]?)?$/u.test(word);
const NAME_LINKS = new Set(["de", "del", "d"]);
const ROAD_MARKS = new Set(["n", "c", "carretera", "ctra", "crta"]);
const nameOnly = word => {
  const text = normalized(word);
  return streetTypes.has(text) || PARTICLES.has(text) || /^[dl]$/u.test(text);
};

// The number at `index` belongs to the street name: nothing but types and articles before it
// («AVINGUDA 11 DE SETEMBRE»), or a portal comes later and it is followed by «de» or is a road number.
function numberInName(words, index) {
  if (words.slice(0, index).every(nameOnly)) return true;
  const next = bare(words[index + 1] ?? "");
  const later = words.slice(index + 1).some(word => PORTAL.test(bare(word)));
  if (later && (NAME_LINKS.has(next) || /^d'\p{L}/u.test(next))) return true;
  return later && ROAD_MARKS.has(bare(words[index - 1])) && PORTAL.test(next);
}

// Street name, portal and complement of the first comma part. `noNumber` marks an explicit "S/N" (sin número).
export function exteriorStreet(value) {
  const text = field(value).replace(/(?:^|\s)s\s*[/.]\s*n\.?(?=\s|$)/giu, " s/n").replace(/(\d)\s*-\s*(\d)/gu, "$1-$2")
    .replace(/\b(nº|n°|n\.º|núm\.?|num\.?)(?=\d)/giu, "$1 ").replace(/(\d)-(\d{1,2}[ºª°])/gu, "$1 $2")
    .replace(/\s+/gu, " ").trim();
  const words = text.split(" ").filter(Boolean);
  const join = (from, to) => words.slice(from, to).join(" ");
  for (let index = 1; index < words.length; index++) {
    const word = bare(words[index]);
    if (word === "s/n") return { name: join(0, index), portal: "", noNumber: true, complement: join(index + 1) };
    // «41-B» is the portal «41B».
    const number = PORTAL.exec(word.replace(/^(\d{1,5})-([a-z])$/u, "$1$2"));
    if (!number || ordinalWord(word) || (/^\d{1,2}a$/u.test(word) && ordinalWord(bare(words[index - 1])))
      || numberInName(words, index)) continue;
    let end = index + 1;
    let suffix = "";
    const next = bare(words[end] ?? "");
    // «9 A» and «9 BIS»: the letter right after the number belongs to the portal («9 A 2º 2º»).
    if (!number[2] && !number[3] && /^(?:bis|ter|[a-hj-np-xz])$/u.test(next)) {
      suffix = next;
      end++;
    }
    let nameEnd = index;
    if (nameEnd > 1 && NUMBER_MARK.test(bare(words[nameEnd - 1]))) nameEnd--;
    // A range ("9-11") is searched by its first number.
    const portal = number[3] ? number[1]
      : number[1] + (number[2] ?? (suffix.length === 1 ? suffix : "")).toUpperCase() + (suffix.length > 1 ? " " + suffix : "");
    return { name: join(0, nameEnd), portal, noNumber: false, complement: join(end) };
  }
  return { name: words.join(" "), portal: "", noNumber: false, complement: "" };
}

// CONFIRMAR_CITAS-018: a municipality with capital articles («Ribes De Freser») → «Ribes de Freser».
export function municipalityName(value) {
  return field(value).split(" ").map((word, index) => {
    if (!index) return word;
    const lower = word.toLowerCase();
    if (PARTICLES.has(lower)) return lower;
    const elided = /^([dl])'(.+)$/iu.exec(word);
    if (!elided) return word;
    return elided[1].toLowerCase() + "'" + (PARTICLES.has(elided[2].toLowerCase()) ? elided[2].toLowerCase() : elided[2]);
  }).join(" ");
}

// Comma parts with the portal joined to its street ("CALLE X, 8, ..." or "CALLE X, 9 A 2º, ...").
export function addressParts(address) {
  const parts = field(address).split(",").map(cleanOracleText).filter(Boolean);
  if (parts.length > 2 && !exteriorStreet(parts[0]).portal && !exteriorStreet(parts[0]).noNumber
    && /^(?:\d|s\s*[/.]\s*n\b)/iu.test(parts[1]) && !/^\d{5}$/u.test(parts[1])) {
    parts.splice(0, 2, parts[0] + " " + parts[1]);
  }
  return parts;
}

// CONFIRMAR_CITAS-027: the address of an activity as the technician can correct it: readable street (types
// expanded), portal, complement (never sent to the search), postcode, municipality and province.
export function editableAddress(address) {
  const parts = addressParts(address);
  if (!parts.length) return { street: "", number: "", complement: "", postalCode: "", municipality: "", province: "" };
  const exterior = exteriorStreet(parts[0]);
  const locality = parts.length > 1
    ? /^(?:(?<postcode>\d{5})\s+)?(?<city>[\p{L}][\p{L} .’'-]{1,99}?)(?: \((?<province>[\p{L}][\p{L} .’'-]{1,99})\))?$/u.exec(parts.at(-1))
    : null;
  const middle = parts.slice(1, locality ? -1 : parts.length);
  const postcode = locality?.groups.postcode || (parts.length > 2 && /^\d{5}$/u.test(parts.at(-2)) ? parts.at(-2) : "");
  return {
    street: exterior.name, number: exterior.portal,
    complement: [exterior.complement, ...middle.filter(part => !/^\d{5}$/u.test(part))].filter(Boolean).join(", "),
    postalCode: postcode, municipality: locality ? municipalityName(locality.groups.city) : "",
    province: locality?.groups.province ?? "",
  };
}

// CONFIRMAR_CITAS-027: the same street with or without its article, for the free-text search of Geoapify when the
// official street map does not have it. The street type is always kept («Passatge Prova» ↔ «Passatge de Prova»).
const CATALAN_TYPES = new Set(["passatge", "carrer", "avinguda", "placa", "placeta", "passeig", "cami", "travessera",
  "travessia", "urbanitzacio", "poligon"]);
const SPANISH_TYPES = new Set(["calle", "pasaje", "avenida", "plaza", "paseo", "camino", "travesia", "urbanizacion", "poligono"]);
export function streetVariant(street) {
  const words = field(street).split(" ").filter(Boolean);
  const type = normalized(words[0] ?? "");
  if (words.length < 2 || (!CATALAN_TYPES.has(type) && !SPANISH_TYPES.has(type))) return "";
  const rest = words.slice(1);
  // Leading articles: «de l'Estació», «de la Font», «dels Pins».
  while (rest.length) {
    if (rest.length > 1 && /^(?:de|del|dels|d|la|las|los|l|el|els|les|en|na)$/iu.test(rest[0])) { rest.shift(); continue; }
    const elided = /^[dl]'(.+)$/iu.exec(rest[0]);
    if (elided) { rest[0] = elided[1]; continue; }
    break;
  }
  const name = rest.join(" ");
  if (name !== words.slice(1).join(" ")) return words[0] + " " + name;
  if (/^\d/u.test(name)) return "";
  const vowel = /^h?[aeiou]/u.test(normalized(name));
  const article = SPANISH_TYPES.has(type) ? (vowel ? "de la " : "de ") : vowel ? "de l'" : "de ";
  return words[0] + " " + article + name;
}
