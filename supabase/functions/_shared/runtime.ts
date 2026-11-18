import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.1";
import { corsHeaders as sdkCorsHeaders } from "npm:@supabase/supabase-js@2.117.1/cors";
import { hmacHex } from "./auth-core.mjs";

export const APP_SCHEMA = "confirmar_citas";
export const CREDENTIAL_ERROR = "No se pudo completar la solicitud. Comprueba los datos o contacta con el administrador.";

export function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

export function publicClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function serviceClient(): SupabaseClient {
  const serverKey = Deno.env.get("SUPABASE_SECRET_KEY")?.trim()
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!serverKey) throw new Error("missing server key");
  return createClient(env("SUPABASE_URL"), serverKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function callerClient(request: Request): { client: SupabaseClient; token: string } {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new Error("unauthorized");
  return {
    token: match[1],
    client: createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
      global: { headers: { Authorization: `Bearer ${match[1]}` } },
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    }),
  };
}

export function corsHeaders(request: Request): HeadersInit {
  const allowedOrigin = Deno.env.get("APP_ORIGIN")?.trim() ?? "";
  const origin = request.headers.get("origin") ?? "";
  const headers = new Headers(sdkCorsHeaders);
  headers.set("Access-Control-Allow-Origin", origin && origin === allowedOrigin ? origin : allowedOrigin);
  headers.set("Access-Control-Allow-Headers", `${headers.get("Access-Control-Allow-Headers") ?? ""}, x-bootstrap-token`);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return headers;
}

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === (Deno.env.get("APP_ORIGIN")?.trim() ?? "");
}

export function jsonResponse(request: Request, body: unknown, status = 200): Response {
  const headers = new Headers(corsHeaders(request));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function preflightOrReject(request: Request): Response | null {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST" || !originAllowed(request)) {
    return jsonResponse(request, { error: CREDENTIAL_ERROR }, 403);
  }
  return null;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function employeeDigest(employeeId: string): Promise<string> {
  return await hmacHex(env("MATRICULA_HMAC_SECRET"), `employee:${employeeId}`);
}

export async function sourceDigest(request: Request): Promise<string | null> {
  // Supabase's trusted edge gateway supplies cf-connecting-ip. Do not trust a
  // caller-controlled X-Forwarded-For chain for the rate-limit identity.
  const source = request.headers.get("cf-connecting-ip")?.trim();
  if (!source || source.length > 64 || /[\r\n,]/.test(source)) return null;
  return await hmacHex(env("MATRICULA_HMAC_SECRET"), `source:${source}`);
}

export async function minimumResponseTime(start: number, milliseconds = 300): Promise<void> {
  const remaining = milliseconds - (Date.now() - start);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

export async function currentUser(request: Request) {
  const { client, token } = callerClient(request);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("unauthorized");
  const { data: verifiedClaims, error: claimsError } = await client.auth.getClaims(token);
  if (claimsError || !verifiedClaims?.claims || verifiedClaims.claims.sub !== data.user.id) {
    throw new Error("unauthorized");
  }
  return { client, token, user: data.user, claims: verifiedClaims.claims };
}
