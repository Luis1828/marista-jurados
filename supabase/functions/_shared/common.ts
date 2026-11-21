import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function getEnvironment() {
  const url = Deno.env.get("SUPABASE_URL");
  let anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  let secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

  // Compatibilidad con las claves nombradas y las variables legacy de Supabase.
  if (!anonKey) {
    const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        anonKey = parsed.default ?? Object.values(parsed)[0] as string | undefined;
      } catch { /* se reportará una configuración incompleta */ }
    }
  }
  if (!secretKey) {
    const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        secretKey = parsed.default ?? Object.values(parsed)[0] as string | undefined;
      } catch { /* se reportará una configuración incompleta */ }
    }
  }
  if (!url || !anonKey || !secretKey) {
    throw new Error("Faltan las variables de entorno de Supabase (URL, publishable/anon y secret/service role).");
  }
  return { url, anonKey, secretKey };
}

export async function authorizeRequest(req: Request, requiredRole: "admin" | "juror") {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Sesión no válida. Inicia sesión nuevamente.");
  const { url, anonKey, secretKey } = getEnvironment();
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser(token);
  if (userError || !user) throw new Error("La sesión no es válida o ha expirado.");

  const serviceClient = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileError } = await serviceClient
    .from("user_profiles")
    .select("id, username, role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError || !profile || !profile.is_active) throw new Error("La cuenta está deshabilitada o no tiene un perfil válido.");
  if (profile.role !== requiredRole) throw new Error("No tienes permisos para realizar esta acción.");
  return { user, profile, serviceClient: serviceClient as SupabaseClient, url, anonKey };
}

export function normalizeUsername(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function validUsername(username: string): boolean {
  return /^[a-z0-9._-]{3,24}$/.test(username);
}

export async function writeAudit(
  serviceClient: SupabaseClient,
  actor: { id: string; username: string; role: string },
  action: string,
  targetType: string,
  targetId: string | null,
  targetName: string | null,
  details: Record<string, unknown> = {},
) {
  const { error } = await serviceClient.from("audit_logs").insert({
    actor_id: actor.id,
    actor_username: actor.username,
    actor_role: actor.role,
    action,
    target_type: targetType,
    target_id: targetId,
    target_name: targetName,
    details,
  });
  if (error) throw new Error(`No se pudo guardar el registro de auditoría: ${error.message}`);
}
