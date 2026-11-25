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

const knownPause = /^(?:pausa(?: (?:para|de) (?:comida|descanso))?|descanso|almuerzo|comida)$/;
const needsTravelDecision = /^(?:pausa|descanso|almuerzo|comida) /;

export function combineActivities(appointments, ignored, preferences = {}, overrides = new Map()) {
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
    const defaultTravel = editableTravel && knownPause.test(name) ? "pause"
      : editableTravel && needsTravelDecision.test(name) ? "undecided" : "travel";
    const override = overrides.get(key);
    const travel = override?.travel ?? defaultTravel;
    const agendaAddress = originalAddress || (editableTravel ? configuredAddress(type, preferences) : "");
    const address = travel === "travel"
      ? formatRouteLocation(override?.location) || agendaAddress
      : "";
    return {
      key, type, time: start === null ? "" : time.slice(0, 5),
      endTime: start !== null && end !== null && end >= start ? endTime : "",
      address, agendaAddress, travel, defaultTravel, editableTravel, override,
    };
  }).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
}

export function buildLegs(home, activities) {
  const house = { type: "Casa", address: home };
  const legs = [];
  let from = house;
  for (const activity of activities) {
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

