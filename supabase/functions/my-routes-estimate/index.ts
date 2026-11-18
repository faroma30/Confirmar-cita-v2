import { currentUser, jsonResponse, preflightOrReject, serviceClient } from "../_shared/runtime.ts";
import { calculateJourney, journeyAddresses, journeyFingerprint } from "./core.mjs";

Deno.serve(async (request: Request) => {
  const preflight = preflightOrReject(request);
  if (preflight) return preflight;
  const reply = (body: unknown, status = 200) => jsonResponse(request, body, status);
  const disabled = () => reply({ error: "Servicio de rutas no disponible." }, 503);
  const apiKey = Deno.env.get("MY_ROUTES_GEOAPIFY_KEY")?.trim();
  // Keep off until Free terms, external location processing and Auth are validated.
  if (Deno.env.get("MY_ROUTES_GEOAPIFY_APPROVED") !== "yes" || !apiKey) return disabled();

  let input;
  try {
    const body = await request.text();
    if (body.length > 300) return reply({ error: "Solicitud no válida." }, 400);
    input = JSON.parse(body);
  } catch { return reply({ error: "Solicitud no válida." }, 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 3 || typeof input.expectedActor !== "string"
    || typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)
    || typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return reply({ error: "Solicitud no válida." }, 400);
  }

  let auth;
  try { auth = await currentUser(request); }
  catch { return reply({ error: "Sesión no válida." }, 401); }
  if (auth.user.id !== input.expectedActor) return reply({ error: "Sesión no válida." }, 403);
  try {
    // All locations come from the caller's own RPCs, never the request body.
    const prefs = await auth.client.rpc("cc_my_route_preferences", { p_expected_technician_id: auth.user.id });
    if (prefs.error?.code === "42501") return reply({ error: "Acceso denegado." }, 403);
    if (prefs.error || typeof prefs.data?.home !== "string") return disabled();
    const date = { p_work_date: input.date };
    const [jobs, ignored] = await Promise.all([
      auth.client.rpc("cc_my_appointments", date), auth.client.rpc("cc_my_ignored_interventions", date),
    ]);
    if (jobs.error || ignored.error || !Array.isArray(jobs.data) || !Array.isArray(ignored.data)) return disabled();
    const addresses = journeyAddresses(prefs.data.home, jobs.data, ignored.data);
    const fingerprint = await journeyFingerprint(addresses);
    if (fingerprint !== input.fingerprint) return reply({ error: "Los datos de la ruta han cambiado." }, 409);
    if (addresses.length === 2) return reply({ estimates: [] });
    const backend = serviceClient();
    const lease = crypto.randomUUID();
    const booking = await backend.rpc("cc_route_budget_begin", { p_actor: auth.user.id, p_day: input.date, p_lease: lease });
    if (booking.error) return disabled();
    if (booking.data !== true) return reply({ error: "Servicio ocupado o cuota temporal alcanzada." }, 429);
    let providerLimited = false;
    try {
      const estimates = await calculateJourney(addresses, {
        apiKey,
        charge: async (credits: number) => {
          const result = await backend.rpc("cc_route_budget_charge", { p_lease: lease, p_credits: credits });
          return !result.error && result.data === true;
        },
      });
      return reply({ estimates });
    } catch (error) {
      providerLimited = typeof error === "object" && error !== null
        && "providerLimited" in error && error.providerLimited === true;
      throw error;
    } finally {
      await backend.rpc("cc_route_budget_end", { p_lease: lease, p_provider_limited: providerLimited });
    }
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
    return status === 429 ? reply({ error: "Cuota temporal alcanzada." }, 429) : disabled();
  }
});
