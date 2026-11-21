import {
  authorizeRequest,
  corsHeaders,
  jsonResponse,
  normalizeUsername,
  validUsername,
  writeAudit,
} from "../_shared/common.ts";

type SupabaseLikeError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
  status?: number;
};

function describeError(error: unknown): SupabaseLikeError & { name?: string } {
  if (error instanceof Error) {
    const candidate = error as Error & SupabaseLikeError;
    return {
      name: candidate.name,
      message: candidate.message,
      code: candidate.code,
      details: candidate.details,
      hint: candidate.hint,
      status: candidate.status,
    };
  }
  if (error && typeof error === "object") {
    const candidate = error as SupabaseLikeError & { name?: string };
    return {
      name: candidate.name,
      message: candidate.message ?? "Error de Supabase sin mensaje.",
      code: candidate.code,
      details: candidate.details,
      hint: candidate.hint,
      status: candidate.status,
    };
  }
  return { message: String(error ?? "Error desconocido.") };
}

function errorStatus(info: SupabaseLikeError & { name?: string }): number {
  const message = (info.message ?? "").toLowerCase();
  if (info.status && info.status >= 400 && info.status <= 599) return info.status;
  if (info.code === "23505") return 409;
  if (info.code === "42501" || /sesión|permiso|deshabilitada|no tienes/i.test(message)) return 403;
  if (info.name === "SyntaxError") return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido." }, 405);

  let actionForLog = "unknown";
  try {
    const { profile: actor, userClient, serviceClient: db } = await authorizeRequest(req, "admin");
    const payload = await req.json();
    const action = String(payload?.action ?? "");
    actionForLog = action || "empty";

    if (action === "list") {
      // Para la lectura de la lista usamos el JWT del administrador, no la clave
      // privilegiada. La política profiles_select_self_or_admin permite que sólo
      // un admin activo consulte los perfiles; la política bands_select_owner_or_admin
      // permite al administrador leer todas las bandas. Así no dependemos de que la función tenga una
      // service key con privilegios de lectura de tablas.
      const [{ data: users, error: usersError }, { data: bands, error: bandsError }] = await Promise.all([
        userClient.from("user_profiles")
          .select("id, username, role, is_active, created_at")
          .eq("role", "juror")
          .order("username"),
        userClient.from("bands")
          .select("id, name, created_at, created_by")
          .order("created_at", { ascending: false }),
      ]);

      if (usersError) {
        console.error("[admin-users:list] user_profiles query failed", usersError);
        throw new Error(`No se pudieron consultar los usuarios (${usersError.code ?? "sin código"}): ${usersError.message}`);
      }
      if (bandsError) {
        console.error("[admin-users:list] bands query failed", bandsError);
        throw new Error(`No se pudieron consultar las bandas (${bandsError.code ?? "sin código"}): ${bandsError.message}`);
      }

      const grouped = new Map<string, Array<{ id: string; name: string; created_at: string }>>();
      for (const band of bands ?? []) {
        if (!band.created_by) continue;
        const list = grouped.get(band.created_by) ?? [];
        list.push({ id: band.id, name: band.name, created_at: band.created_at });
        grouped.set(band.created_by, list);
      }
      return jsonResponse({ users: (users ?? []).map((user) => ({ ...user, bands: grouped.get(user.id) ?? [] })) });
    }

    const username = normalizeUsername(payload?.username);
    if (!validUsername(username)) {
      return jsonResponse({ error: "El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo." }, 400);
    }

    // La búsqueda del perfil objetivo se hace con el JWT del administrador.
    // La política profiles_select_self_or_admin permite esta lectura sólo a un
    // administrador activo. El cliente service-role queda para Auth Admin y
    // escrituras explícitamente concedidas al rol service_role.
    const { data: target, error: targetError } = await userClient
      .from("user_profiles")
      .select("id, username, role, is_active")
      .eq("username", username)
      .maybeSingle();
    if (targetError) {
      console.error("[admin-users] target profile query failed", targetError);
      throw new Error(`No se pudo consultar la cuenta ${username} (${targetError.code ?? "sin código"}): ${targetError.message}`);
    }
    if (target && target.role !== "juror") return jsonResponse({ error: "Sólo se pueden administrar cuentas de jurados." }, 403);

    if (action === "create") {
      if (target) return jsonResponse({ error: "Ese nombre de usuario ya existe." }, 409);
      const password = String(payload?.password ?? "");
      if (password.length < 10) return jsonResponse({ error: "La contraseña inicial debe tener al menos 10 caracteres." }, 400);
      const syntheticEmail = `${username}@login.marista-festival.invalid`;
      const { data, error } = await db.auth.admin.createUser({
        email: syntheticEmail,
        password,
        email_confirm: true,
        user_metadata: { username },
      });
      if (error) throw error;
      const { error: profileInsertError } = await db.from("user_profiles").insert({
        id: data.user.id,
        username,
        role: "juror",
        is_active: true,
      });
      if (profileInsertError) {
        await db.auth.admin.deleteUser(data.user.id);
        throw profileInsertError;
      }
      await writeAudit(db, actor, "user_created", "user", data.user.id, username, { username });
      return jsonResponse({ ok: true, message: `Cuenta ${username} creada.` });
    }

    if (!target) return jsonResponse({ error: "No se encontró ese usuario." }, 404);
    if (target.id === actor.id) return jsonResponse({ error: "No puedes modificar tu propia cuenta desde este módulo." }, 400);

    if (action === "set_password") {
      const password = String(payload?.password ?? "");
      if (password.length < 10) return jsonResponse({ error: "La nueva contraseña debe tener al menos 10 caracteres." }, 400);
      const { error } = await db.auth.admin.updateUserById(target.id, { password });
      if (error) throw error;
      await writeAudit(db, actor, "password_changed", "user", target.id, username, { username, changed_by_admin: true });
      return jsonResponse({ ok: true, message: `Contraseña de ${username} actualizada.` });
    }

    if (action === "set_access") {
      const isActive = payload?.is_active;
      if (typeof isActive !== "boolean") return jsonResponse({ error: "El estado de acceso no es válido." }, 400);
      const { error } = await db.from("user_profiles").update({ is_active: isActive }).eq("id", target.id);
      if (error) throw error;
      await writeAudit(db, actor, "access_updated", "user", target.id, username, { username, is_active: isActive });
      return jsonResponse({ ok: true, message: isActive ? `Acceso de ${username} habilitado.` : `Acceso de ${username} deshabilitado.` });
    }

    if (action === "delete") {
      // No eliminar una cuenta que conserva bandas: created_by permite mantener
      // sus bandas agrupadas y su podio histórico. Deshabilitar el acceso es la
      // opción correcta cuando ya hay evaluaciones registradas.
      const { count: ownedBandCount, error: ownedBandsError } = await userClient
        .from("bands")
        .select("id", { count: "exact", head: true })
        .eq("created_by", target.id);
      if (ownedBandsError) throw ownedBandsError;
      if ((ownedBandCount ?? 0) > 0) {
        return jsonResponse({
          error: `No se puede eliminar la cuenta ${username} porque tiene ${ownedBandCount} banda(s) registrada(s). Deshabilita su acceso para conservar su clasificación y podio.`,
        }, 409);
      }
      const { error } = await db.auth.admin.deleteUser(target.id);
      if (error) throw error;
      await writeAudit(db, actor, "user_deleted", "user", target.id, username, { username, note: "Cuenta eliminada por administrador." });
      return jsonResponse({ ok: true, message: `Cuenta ${username} eliminada.` });
    }

    return jsonResponse({ error: "Acción desconocida." }, 400);
  } catch (error) {
    const info = describeError(error);
    // No se registran contraseñas, tokens ni cabeceras de autenticación.
    console.error("[admin-users] request failed", {
      action: actionForLog,
      name: info.name,
      message: info.message,
      code: info.code,
      details: info.details,
      hint: info.hint,
      status: info.status,
    });
    const message = info.message || "Error interno en admin-users.";
    return jsonResponse({ error: message, code: info.code ?? null }, errorStatus(info));
  }
});
