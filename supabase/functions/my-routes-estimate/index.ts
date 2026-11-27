import { currentUser, jsonResponse, preflightOrReject, serviceClient } from "../_shared/runtime.ts";
import { autocompleteQuery, autocompleteStreets, calculateJourney, journeyAddresses, journeyFingerprint, providerPlan, suggestAddresses, suggestQuery } from "./core.mjs";
import { canAutocomplete, homeOptIn, parseActivityEdits, routeAccess } from "./policy.mjs";
import { pilotStopRejection } from "./pilot-control.mjs";
import { confirmPilotStopped, ensurePilotRenewed, renewalFields } from "./pilot-renewal.mjs";

Deno.serve(async (request: Request) => {
  const preflight = preflightOrReject(request);
  if (preflight) return preflight;
  const reply = (body: unknown, status = 200) => jsonResponse(request, body, status);
  const disabled = () => reply({ error: "Servicio de rutas no disponible." }, 503);
  const invalid = () => reply({ error: "Solicitud no válida." }, 400);
  const quota = () => reply({ error: "Cuota temporal alcanzada." }, 429);
  // Both query text and booked locations may be personal, regardless of the input format.
  const apiKey = Deno.env.get("MY_ROUTES_GEOAPIFY_KEY")?.trim();
  const enabled = Deno.env.get("MY_ROUTES_GEOAPIFY_APPROVED") === "yes" && Boolean(apiKey);

  let input;
  try {
    const body = await request.text();
    if (body.length > 260000) return invalid();
    input = JSON.parse(body);
  } catch { return invalid(); }
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.expectedActor !== "string") return invalid();
  const autocomplete = input.operation === "autocomplete";
  // CONFIRMAR_CITAS-022: address assistant with CartoCiudad (free): no Geoapify key, no pilot booking, no credits.
  const suggest = input.operation === "suggest";
  const cartoOn = Deno.env.get("MY_ROUTES_CARTOCIUDAD") !== "no";
  const control = input.operation === "status" || input.operation === "stop";
  if (suggest && !cartoOn) return disabled();
  if (!control && !suggest && !enabled) return disabled();
  if (!control && !suggest && !autocomplete && Deno.env.get("MY_ROUTES_GEOAPIFY_MANUAL_FREE_PILOT") !== "yes") return disabled();
  const allowedKeys = control ? ["operation", "expectedActor"] : suggest
    ? ["operation", "query", "municipality", "postalCode", "expectedActor"] : autocomplete
    ? ["operation", "query", "kind", "expectedActor"]
    : ["date", "fingerprint", "expectedActor", "edits", "useHome"];
  if (Object.keys(input).some(key => !allowedKeys.includes(key))) return invalid();
  // CONFIRMAR_CITAS-022: the saved home is always used (Director's decision; replaces the opt-in of the 015).
  // `useHome` is still accepted for compatibility with 3routes17 (a boolean); any other type is invalid.
  if (homeOptIn(input) === null) return invalid();
  if (suggest && !suggestQuery(input)) return invalid();
  const query = autocomplete ? autocompleteQuery(input.query) : "";
  if (!control && !suggest && (autocomplete ? !query
    : typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)
      || typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date))) return invalid();

  let auth;
  try { auth = await currentUser(request); }
  catch { return reply({ error: "Sesión no válida." }, 401); }
  const denied = () => reply({ error: "Acceso denegado." }, 403);
  if (auth.user.id !== input.expectedActor) return denied();
  if (input.operation === "stop") {
    // CONFIRMAR_CITAS-007: only an active Administrator may stop the pilot for everyone (403 otherwise).
    const rejection = await pilotStopRejection(() => auth.client.rpc("cc_my_profile"), auth.claims);
    if (rejection) return reply(rejection.body, rejection.status);
    try {
      const backend = serviceClient();
      const stopped = await backend.rpc("cc_route_pilot_configure", { p_external_usage: null, p_stop: true });
      if (stopped.error || stopped.data !== true) return disabled();
      // CONFIRMAR_CITAS-024: a daily renewal that read the status just before this stop cannot leave it active.
      if (!await confirmPilotStopped(backend)) return disabled();
      const status = await backend.rpc("cc_route_pilot_status");
      if (status.error || !status.data) return disabled();
      return reply({ ...status.data, enabled, ...renewalFields(status.data) });
    } catch { return disabled(); }
  }
  const access = routeAccess(Deno.env.get("MY_ROUTES_GEOAPIFY_ACCESS"), auth.user.id);
  if (!access) return denied();
  if (autocomplete && (Deno.env.get("MY_ROUTES_GEOAPIFY_AUTOCOMPLETE_APPROVED") !== "yes"
    || !canAutocomplete(access, input.kind))) return denied();

  try {
    // This caller-scoped RPC checks active technician status, team membership and session revocation.
    const prefs = await auth.client.rpc("cc_my_route_locations_v2", { p_expected_technician_id: auth.user.id });
    if (prefs.error?.code === "42501") return reply({ error: "Acceso denegado." }, 403);
    if (prefs.error || !prefs.data || !Object.hasOwn(prefs.data, "home")) return disabled();

    if (suggest) {
      // Only public street names of the official street map; the typed text is never logged.
      try {
        return reply({ suggestions: await suggestAddresses(input, { fetcher: fetch, signal: request.signal }) });
      } catch { return disabled(); }
    }

    if (control) {
      // Only "status" reaches this point: "stop" is handled above for Administrators.
      // CONFIRMAR_CITAS-024: an activated pilot renews itself every 24 h (same limits); stopped ones never do.
      const backend = serviceClient();
      const { status } = await ensurePilotRenewed(backend, { enabled });
      if (!status) return disabled();
      return reply({ ...status, enabled, ...renewalFields(status) });
    }

    let addresses: string[] = [];
    let reasons: (string | null)[] = [];
    let failure = "";
    if (!autocomplete) {
      const date = { p_work_date: input.date };
      const [jobs, ignored] = await Promise.all([
        auth.client.rpc("cc_my_appointments", date), auth.client.rpc("cc_my_ignored_interventions", date),
      ]);
      if (jobs.error || ignored.error || !Array.isArray(jobs.data) || !Array.isArray(ignored.data)) return disabled();
      // All route stops come from the caller's actual agenda and preferences.
      try {
        const edits = parseActivityEdits(input.edits);
        addresses = journeyAddresses(prefs.data, jobs.data, ignored.data, edits);
      } catch { return invalid(); }
      if (await journeyFingerprint(addresses) !== input.fingerprint) return reply({ error: "Los datos de la ruta han cambiado." }, 409);
      if (addresses.length === 2) return reply({ estimates: [] });
      // Only the caller's own saved home (cc_my_route_locations_v2 above) can be used, always (CONFIRMAR_CITAS-022).
      const plan = providerPlan(addresses, true);
      reasons = plan.reasons;
      addresses = plan.addresses;
      if (!addresses.slice(1).some((address, index) => address && addresses[index])) {
        const none = reasons.map(reason => reason ?? "incomplete");
        return reply({ estimates: Array(addresses.length - 1).fill(null), reasons: none, details: none });
      }
    }

    if (request.signal.aborted) return disabled();
    const backend = serviceClient();
    const lease = crypto.randomUUID();
    // CONFIRMAR_CITAS-024: daily renewal before booking (only if activated and not stopped by an error).
    try { await ensurePilotRenewed(backend, { enabled }); } catch { /* the booking below decides, as before */ }
    const booking = await backend.rpc("cc_route_pilot_begin", {
      p_actor: auth.user.id, p_lease: lease, p_operation: autocomplete ? "autocomplete" : "route",
    });
    if (booking.error) return disabled();
    if (booking.data !== true) return quota();
    let providerLimited = false;
    try {
      const context = {
        apiKey,
        signal: request.signal,
        manualFreePilot: !autocomplete,
        charge: async (credits: number, isRouting = false) => {
          const result = await backend.rpc("cc_route_pilot_charge", {
            p_actor: auth.user.id, p_lease: lease, p_credits: credits, p_is_routing: isRouting,
          });
          return !result.error && result.data === true;
        },
      };
      if (autocomplete) return reply({ suggestions: await autocompleteStreets(query, context) });
      // CONFIRMAR_CITAS-017: `details` (optional, one stable code per leg) explains every leg left
      // without time; `reasons` keeps the codes that 3routes14 understands. No provider data or coordinates.
      const details: (string | null)[] = reasons.map(reason => reason === "privacy" ? "privacy" : null);
      // CONFIRMAR_CITAS-018: `diagnostics` (optional) gives, per leg, the code of the address that blocks it
      // (no_results, street_mismatch, ...). Only codes: never the address, the provider response or coordinates.
      const diagnostics: (string | null)[] = [];
      // CONFIRMAR_CITAS-020: CartoCiudad (IGN-CNIG) first for the addresses, Geoapify as the fallback and for
      // the routes. `approx` marks a leg placed on the street (no portal in the official base) and `sources`
      // gives the origin per address. Its failures only log the stage and kind: never the address.
      const approx: boolean[] = [];
      const sources: (string | null)[] = [];
      // CONFIRMAR_CITAS-022: optional `officials` (official street used, per address) and `suggestions` (up to 3
      // official streets of the same municipality for an address not found, applied by the app as `edits`).
      const officials: (string | null)[] = [];
      const suggestions: (unknown[] | null)[] = [];
      const cartociudad = !cartoOn ? null : {
        fetcher: fetch,
        onFailure: (fault: { stage: string; kind: string; http: number | null }) => console.warn(JSON.stringify({
          event: "cartociudad_attempt_failed", stage: fault.stage, kind: fault.kind, http: fault.http,
        })),
      };
      const estimates = await calculateJourney(addresses, {
        ...context, reasons, details, diagnostics, approx, sources, officials, suggestions, cartociudad,
        // The pilot budget ran out after some legs: the partial result is returned and recorded as before.
        onPilotLimit: () => { failure = "quota"; },
      });
      return reply({
        estimates, reasons, details: estimates.map((_, index) => details[index] ?? null),
        diagnostics: estimates.map((_, index) => diagnostics[index] ?? null),
        approx: estimates.map((_, index) => approx[index] === true),
        sources: addresses.map((_, index) => sources[index] ?? null),
        officials: addresses.map((_, index) => officials[index] ?? null),
        suggestions: addresses.map((_, index) => suggestions[index] ?? null),
      });
    } catch (error) {
      providerLimited = typeof error === "object" && error !== null
        && "providerLimited" in error && error.providerLimited === true;
      const fault = error instanceof Error && "diagnostic" in error ? error.diagnostic : null;
      const detail = fault as { stage: string; kind: string; http: number | null } | null;
      if (detail) console.warn(JSON.stringify({
        event: "geoapify_attempt_failed", stage: detail.stage, kind: detail.kind, http: detail.http,
        pilotStopped: providerLimited,
      }));
      failure = detail?.kind === "estimate_exceeded" ? "route_estimate_exceeded"
        : providerLimited ? "provider_limited"
        : detail?.kind === "timeout" ? "timeout"
        : (typeof error === "object" && error !== null && "status" in error && error.status === 429)
          ? "quota" : "provider_unavailable";
      throw error;
    } finally {
      if (failure) {
        await backend.rpc("cc_route_pilot_report", { p_actor: auth.user.id, p_lease: lease, p_error: failure });
      }
      // CONFIRMAR_CITAS-006: release the pilot reservation so other technicians are not blocked (429).
      // Needs migration 20261125090000; until it is applied the RPC returns an error that is ignored.
      await backend.rpc("cc_route_pilot_end", { p_actor: auth.user.id, p_lease: lease });
      await backend.rpc("cc_route_budget_end", { p_lease: lease, p_provider_limited: providerLimited });
    }
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
    if (status === 429) return quota();
    if (error instanceof Error && "diagnostic" in error) {
      const fault = error.diagnostic as { stage: string; kind: string } | null;
      if (fault?.stage === "geocoding") return reply({
        error: "Geoapify no completó la búsqueda de direcciones.",
        code: fault.kind === "timeout" ? "geocoding_timeout" : "geocoding_unavailable",
      }, 503);
    }
    return disabled();
  }
});
