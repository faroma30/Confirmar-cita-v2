import { currentUser, jsonResponse, preflightOrReject, serviceClient } from "../_shared/runtime.ts";
import { autocompleteQuery, autocompleteStreets, calculateJourney, journeyAddresses, journeyFingerprint } from "./core.mjs";

Deno.serve(async (request: Request) => {
  const preflight = preflightOrReject(request);
  if (preflight) return preflight;
  const reply = (body: unknown, status = 200) => jsonResponse(request, body, status);
  const disabled = () => reply({ error: "Servicio de rutas no disponible." }, 503);
  const invalid = () => reply({ error: "Solicitud no válida." }, 400);
  const quota = () => reply({ error: "Cuota temporal alcanzada." }, 429);
  // Both query text and booked locations may be personal, regardless of the input format.
  const apiKey = Deno.env.get("MY_ROUTES_GEOAPIFY_KEY")?.trim();
  if (Deno.env.get("MY_ROUTES_GEOAPIFY_APPROVED") !== "yes" || !apiKey) return disabled();

  let input;
  try {
    const body = await request.text();
    if (body.length > 400) return invalid();
    input = JSON.parse(body);
  } catch { return invalid(); }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 3 || typeof input.expectedActor !== "string") return invalid();

  const autocomplete = input.operation === "autocomplete";
  const query = autocomplete ? autocompleteQuery(input.query) : "";
  if (autocomplete ? !query
    : typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)
      || typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return invalid();

  let auth;
  try { auth = await currentUser(request); }
  catch { return reply({ error: "Sesión no válida." }, 401); }
  if (auth.user.id !== input.expectedActor) return reply({ error: "Acceso denegado." }, 403);

  try {
    // This caller-scoped RPC checks active technician status, team membership and session revocation.
    const prefs = await auth.client.rpc("cc_my_route_locations_v2", { p_expected_technician_id: auth.user.id });
    if (prefs.error?.code === "42501") return reply({ error: "Acceso denegado." }, 403);
    if (prefs.error || !prefs.data || !Object.hasOwn(prefs.data, "home")) return disabled();

    let addresses: string[] = [];
    if (!autocomplete) {
      const date = { p_work_date: input.date };
      const [jobs, ignored] = await Promise.all([
        auth.client.rpc("cc_my_appointments", date), auth.client.rpc("cc_my_ignored_interventions", date),
      ]);
      if (jobs.error || ignored.error || !Array.isArray(jobs.data) || !Array.isArray(ignored.data)) return disabled();
      // All route stops come from the caller's actual agenda and preferences.
      addresses = journeyAddresses(prefs.data, jobs.data, ignored.data);
      if (await journeyFingerprint(addresses) !== input.fingerprint) return reply({ error: "Los datos de la ruta han cambiado." }, 409);
      if (addresses.length === 2) return reply({ estimates: [] });
    }

    if (request.signal.aborted) return disabled();
    const backend = serviceClient();
    const lease = crypto.randomUUID();
    const booking = await backend.rpc("cc_route_budget_begin_operation", {
      p_actor: auth.user.id, p_lease: lease, p_operation: autocomplete ? "autocomplete" : "route",
    });
    if (booking.error) return disabled();
    if (booking.data !== true) return quota();
    let providerLimited = false;
    try {
      const context = {
        apiKey,
        signal: request.signal,
        charge: async (credits: number) => {
          const result = await backend.rpc("cc_route_budget_charge", { p_lease: lease, p_credits: credits });
          return !result.error && result.data === true;
        },
      };
      return autocomplete
        ? reply({ suggestions: await autocompleteStreets(query, context) })
        : reply({ estimates: await calculateJourney(addresses, context) });
    } catch (error) {
      providerLimited = typeof error === "object" && error !== null
        && "providerLimited" in error && error.providerLimited === true;
      throw error;
    } finally {
      await backend.rpc("cc_route_budget_end", { p_lease: lease, p_provider_limited: providerLimited });
    }
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
    return status === 429 ? quota() : disabled();
  }
});
