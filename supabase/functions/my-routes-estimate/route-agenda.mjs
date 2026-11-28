const text = value => typeof value === "string" ? value.trim() : "";

function addressOf(row) {
  const street = text(row.full_address);
  const missing = /^(?:s\/d|s\/n|sin (?:direccion|datos)|no (?:disponible|informada)|[-–—]+)$/i;
  return street && !missing.test(street.normalize("NFD").replace(/\p{Diacritic}/gu, ""))
    ? [street, text(row.postal_code), text(row.population)].filter(Boolean).join(", ") : "";
}

export const routeLocationFields = { street: 200, number: 30, municipality: 100, postalCode: 5, province: 100 };
export const routeLocationKinds = ["home", "keys", "tourline"];

export function formatRouteLocation(location) {
  if (!location) return "";
  return [[location.street, location.number].filter(Boolean).join(" "), location.postalCode, location.province ? location.municipality + " (" + location.province + ")" : location.municipality].filter(Boolean).join(", ");
}

function activityName(value) {
  return text(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function configuredAddress(type, preferences) {
  const name = activityName(type);
  if (/^(?:recogida (?:de )?llaves|recoger (?:las )?llaves)(?: (?:en|del?|de la) .+)?$/.test(name)) {
    return formatRouteLocation(preferences.keys);
  }
  if (/^(?:tour ?line(?: express| alianzas)?(?: recogida(?: (?:de )?material(?:es)?)?)?|recogida (?:de )?material(?:es)?(?: tour ?line(?: express| alianzas)?)?)$/.test(name)) {
    return formatRouteLocation(preferences.tourline);
  }
  return "";
}

// CONFIRMAR_CITAS-016 (opción A): toda actividad cuyo nombre empiece por Comida, Almuerzo, Pausa o Descanso
// es por defecto una pausa sin desplazamiento; el técnico puede cambiarlo en la tarjeta (edits).
const defaultPause = /^(?:pausa|descanso|almuerzo|comida)s?(?: |$)/;
// CONFIRMAR_CITAS-031: actividades que, cuando NO tienen dirección (ni en la agenda ni en Ajustes), son
// por defecto «Sin desplazamiento»: no se calculan, no cuentan y la ruta va de la anterior a la siguiente.
// Regla exacta: nombre (sin tildes ni mayúsculas) que empieza por la palabra «desplazamiento», p. ej.
// «Desplazamiento Alianzas». Con dirección se calculan como siempre; «Tourline Alianzas» no entra.
// Para ampliarla, añadir un patrón aquí (la lista es igual en my-routes.mjs y route-agenda.mjs).
const noTravelWithoutAddress = [/^desplazamiento(?: |$)/];

// `legacyTransit`: cadena anterior a CONFIRMAR_CITAS-031 (esas actividades seguían en la ruta, sin destino).
// Solo se usa para hablar con la otra versión (web o función) mientras convivan.
export function combineActivities(appointments, ignored, preferences = {}, overrides = new Map(), { legacyTransit = false } = {}) {
  const occurrences = new Map();
  return [
    ...appointments.filter(row => !row.source_missing && row.status !== "cancelled")
      .map(row => ({ row, type: "Instalación", time: row.scheduled_time, editableTravel: false })),
    ...ignored.filter(row => text(row.type))
      .map(row => ({ row, type: row.type, time: row.time, editableTravel: true })),
  ].map(({ row, type, time, editableTravel }) => {
    const endTime = row.scheduled_end_time ?? row.end_time;
    const start = clockMinutes(time);
    const end = clockMinutes(endTime);
    const originalAddress = addressOf(row);
    const identity = !editableTravel && row.id
      ? JSON.stringify(["installation", row.id])
      : JSON.stringify([editableTravel, type, time, endTime, originalAddress]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const key = JSON.stringify([identity, occurrence]);
    const name = activityName(type);
    const agendaAddress = originalAddress || (editableTravel ? configuredAddress(type, preferences) : "");
    const transit = editableTravel && noTravelWithoutAddress.some(pattern => pattern.test(name));
    const excluded = transit && !agendaAddress && !legacyTransit;
    const defaultTravel = editableTravel && (excluded || defaultPause.test(name)) ? "pause" : "travel";
    const override = overrides.get(key);
    const travel = override?.travel ?? defaultTravel;
    const address = travel === "travel"
      ? formatRouteLocation(override?.location) || agendaAddress
      : "";
    const noDestination = transit && travel === "travel" && !address;
    // «skipped»: excluida por la regla; a diferencia de una pausa, no alarga la hora de salida de la anterior.
    const skipped = excluded && travel === "pause";
    return {
      ...(skipped ? { skipped } : {}),
      key, type, time: start === null ? "" : time.slice(0, 5),
      endTime: start !== null && end !== null && end >= start ? endTime : "",
      address, agendaAddress, travel, defaultTravel, editableTravel, override, noDestination,
    };
  }).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
}

export function buildLegs(home, activities) {
  const house = { type: "Casa", address: home };
  const legs = [];
  let from = house;
  for (const activity of activities) {
    if (activity.skipped) continue;
    if (activity.travel === "pause") {
      // A pause stays at the last stop. Any later ETA needs a known finish for both activities.
      if (legs.length) {
        const previous = clockMinutes(from.endTime);
        const pauseEnd = clockMinutes(activity.endTime);
        from = { ...from, endTime: previous === null || pauseEnd === null
          ? "" : pauseEnd > previous ? activity.endTime : from.endTime };
      }
      continue;
    }
    legs.push({ from, to: activity });
    from = activity;
  }
  if (legs.length) legs.push({ from, to: house });
  return legs;
}

export function clockMinutes(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60 : null;
}

