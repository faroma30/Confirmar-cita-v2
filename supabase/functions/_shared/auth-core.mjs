export const GENERIC_CREDENTIAL_MESSAGE = "No se pudo completar la solicitud. Comprueba los datos o contacta con el administrador.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeEmployeeId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").trim().toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{6,20}$/.test(normalized) ? normalized : "";
}

// `admin` is a reserved module login identifier, never a valid matrícula.
// All ordinary users continue through the unchanged matrícula validator.
export function normalizeLoginIdentifier(value) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").trim().toUpperCase().replace(/[\s-]/g, "");
  return normalized === "ADMIN" ? "ADMIN" : normalizeEmployeeId(normalized);
}

export async function hmacHex(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateProvisionInput(input, actorRole) {
  if (!input || typeof input !== "object") return { ok: false };
  const displayName = typeof input.display_name === "string" ? input.display_name.trim() : "";
  const presentationName = typeof input.presentation_name === "string"
    ? input.presentation_name.trim()
    : (displayName.split(/\s+/u)[0] ?? "");
  const employeeId = normalizeEmployeeId(input.employee_id);
  const role = input.role;
  const teams = Array.isArray(input.team_ids) ? input.team_ids : [];
  if (displayName.length < 1 || displayName.length > 120
      || presentationName.length < 1 || presentationName.length > 120 || employeeId.length < 6
      || !["master", "technician"].includes(role)
      || teams.length < 1 || teams.length > 20
      || teams.some((id) => typeof id !== "string" || !UUID_RE.test(id))
      || new Set(teams).size !== teams.length) return { ok: false };
  if (actorRole === "master" && (role !== "technician" || teams.length !== 1)) return { ok: false };
  if (actorRole !== "admin" && actorRole !== "master") return { ok: false };
  if (role === "technician" && teams.length !== 1) return { ok: false };
  return { ok: true, displayName, presentationName, employeeId, role, teamIds: teams };
}

// Master/technician initial credentials follow the owner's requirement:
// normalized matrícula is also the temporary password. Keep the stronger
// one-time Admin bootstrap policy isolated in bootstrap-core.mjs.
export function initialProvisionPassword(employeeId) {
  const normalized = normalizeEmployeeId(employeeId);
  return normalized.length >= 6 ? normalized : "";
}

export function internalAuthEmail(employeeId, digest) {
  const normalized = normalizeLoginIdentifier(employeeId);
  return normalized && /^[0-9a-f]{64}$/.test(digest)
    ? `cc-${digest}@auth.confirmar-citas.invalid`
    : "";
}

export function canResetAccount(actorRole, targetRole, actorTeamIds, targetTeamIds) {
  if (actorRole === "admin") return ["master", "technician"].includes(targetRole);
  if (actorRole !== "master" || targetRole !== "technician") return false;
  const actorTeams = new Set(actorTeamIds ?? []);
  return (targetTeamIds ?? []).some((teamId) => actorTeams.has(teamId));
}

export function sessionAfterInvalidation(iat, threshold) {
  if (threshold === null || threshold === undefined) return true;
  const invalidBefore = Number(threshold);
  return Number.isSafeInteger(iat) && Number.isSafeInteger(invalidBefore) && iat >= invalidBefore;
}

export function validNewPassword(password, employeeId) {
  const normalizedLogin = normalizeLoginIdentifier(employeeId);
  const normalizedPassword = normalizeLoginIdentifier(password);
  return typeof password === "string"
    && password.length >= 6
    && password.length <= 128
    && Boolean(normalizedLogin)
    && normalizedPassword !== normalizedLogin;
}

export async function loginWithEmployeeId(input, deps) {
  const employeeId = normalizeLoginIdentifier(input?.login_id ?? input?.employee_id);
  const password = typeof input?.password === "string" ? input.password : "";
  const digest = await deps.digestEmployee(employeeId);
  const sourceDigest = deps.requestSourceDigest
    ?? (deps.source ? await deps.digestSource(deps.source) : null);
  const allowed = await deps.consumeRateLimit(digest, sourceDigest);
  if (!allowed || !employeeId || password.length < 1 || password.length > 256) {
    return { status: allowed ? 401 : 429, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  const userId = await deps.resolveActiveUser(digest);
  if (!userId) {
    await deps.dummySignIn(password, digest);
    return { status: 401, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  const threshold = deps.getLoginThreshold ? await deps.getLoginThreshold(userId) : null;
  if (threshold === undefined) {
    await deps.dummySignIn(password, digest);
    return { status: 401, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  const authEmail = await deps.getAuthEmail(userId);
  if (!authEmail) {
    await deps.dummySignIn(password, digest);
    return { status: 401, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  let session = await deps.signIn(authEmail, password);
  if (!session) return { status: 401, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  const thresholdEpoch = threshold === null ? null : Number(threshold);
  if (thresholdEpoch !== null && (!Number.isSafeInteger(thresholdEpoch) || thresholdEpoch < 1)) {
    return { status: 401, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  if (thresholdEpoch !== null && Math.floor(Date.now() / 1000) < thresholdEpoch) {
    session = await deps.refreshAfterLoginThreshold?.(authEmail, password, thresholdEpoch, session) ?? null;
    if (!session) return { status: 401, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  return { status: 200, body: { session } };
}

export async function completeAccountActivation(input, deps) {
  const password = typeof input?.password === "string" ? input.password : "";
  const user = await deps.getCurrentUser();
  const profile = user ? await deps.getProfile(user.id) : null;
  if (!user?.id || !profile
      || profile.status !== "pending_activation" || profile.must_change_password !== true
      || !sessionAfterInvalidation(user.iat, profile.sessions_invalid_before)
      || !await deps.employeeIdBelongsToUser(user.id, input?.employee_id)
      || !validNewPassword(password, input?.employee_id)) {
    return { status: 400, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  // The caller must already hold the pending Auth session. This changes the
  // password and unlocks the profile; it does not verify the employee's identity.
  if (!await deps.setPassword(user.id, password)) {
    return { status: 400, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  await deps.activate(user.id);
  const session = await deps.createFreshSession(user.id, password);
  if (!session) return { status: 200, body: { activated: true, requiresLogin: true } };
  return { status: 200, body: { activated: true, session } };
}

export async function changeAccountPassword(input, deps) {
  const employeeId = normalizeLoginIdentifier(input?.login_id ?? input?.employee_id);
  const password = typeof input?.new_password === "string" ? input.new_password : "";
  const mode = input?.mode;
  const user = await deps.getCurrentUser();
  const profile = user ? await deps.getProfile(user.id) : null;
  if (!user?.id || !profile || profile.status !== "active"
      || profile.must_change_password !== false
      || !await deps.employeeIdBelongsToUser(user.id, employeeId)
      || !validNewPassword(password, employeeId)) {
    return { status: 400, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  if (mode === "change") {
    const currentPassword = typeof input?.current_password === "string" ? input.current_password : "";
    if (!currentPassword || !await deps.reauthenticate(user.id, currentPassword)) {
      return { status: 400, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
    }
  } else {
    return { status: 400, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  if (!await deps.setPassword(user.id, password)) {
    return { status: 400, body: { error: GENERIC_CREDENTIAL_MESSAGE } };
  }
  return { status: 200, body: { updated: true } };
}
