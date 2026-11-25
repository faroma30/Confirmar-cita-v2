// CONFIRMAR_CITAS-007: solo el Administrador puede desactivar el piloto de Mis rutas.
// Misma comprobación que `admin-management` (perfil propio con `cc_my_profile`, rol leído de la base de datos).
// Master se trata como técnico: según ROLES_Y_PERMISOS.md no gestiona configuración global
// y parar el piloto afecta a todos los técnicos.
import { sessionAfterInvalidation } from "../_shared/auth-core.mjs";

export const PILOT_STOP_FORBIDDEN = "Solo el administrador puede desactivar el piloto. Avísale si hay que pararlo.";

/** true solo para un Administrador activo, verificado y con la sesión vigente. */
export function canStopPilot(profile, claims) {
  return Boolean(profile) && typeof profile === "object"
    && profile.role === "admin"
    && profile.status === "active"
    && profile.must_change_password !== true
    && Boolean(profile.activation_verified_at)
    && sessionAfterInvalidation(claims?.iat, profile.sessions_invalid_before);
}

/**
 * Decide la operación `stop` antes de tocar el piloto.
 * @param {() => Promise<{data: unknown, error: unknown}>} loadProfile llamada a `cc_my_profile` con el cliente del usuario
 * @returns {Promise<null | {status: number, body: {error: string, code?: string}}>} null si se permite
 */
export async function pilotStopRejection(loadProfile, claims) {
  let result;
  try { result = await loadProfile(); } catch { result = { data: null, error: true }; }
  if (result?.error) return { status: 503, body: { error: "Servicio de rutas no disponible." } };
  if (!canStopPilot(result?.data, claims)) return { status: 403, body: { error: PILOT_STOP_FORBIDDEN, code: "admin_only" } };
  return null;
}
