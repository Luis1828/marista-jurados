import {
  authorizeRequest,
  corsHeaders,
  jsonResponse,
  normalizeUsername,
  validUsername,
  writeAudit,
} from "../_shared/common.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido." }, 405);

  try {
    const { profile: actor, serviceClient: db } = await authorizeRequest(req, "admin");
    const payload = await req.json();
    const action = String(payload?.action ?? "");

    if (action === "list") {
      const [{ data: users, error: usersError }, { data: bands, error: bandsError }] = await Promise.all([
        db.from("user_profiles").select("id, username, role, is_active, created_at").eq("role", "juror").order("username"),
        db.from("bands").select("id, name, created_at, created_by").order("created_at", { ascending: false }),
      ]);
      if (usersError) throw usersError;
      if (bandsError) throw bandsError;
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

    const { data: target, error: targetError } = await db
      .from("user_profiles")
      .select("id, username, role, is_active")
      .eq("username", username)
      .maybeSingle();
    if (targetError) throw targetError;
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
      const { error } = await db.auth.admin.deleteUser(target.id);
      if (error) throw error;
      await writeAudit(db, actor, "user_deleted", "user", target.id, username, { username, note: "Cuenta eliminada por administrador." });
      return jsonResponse({ ok: true, message: `Cuenta ${username} eliminada.` });
    }

    return jsonResponse({ error: "Acción desconocida." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error interno.";
    const status = /sesión|permiso|deshabilitada|no tienes/i.test(message) ? 403 : 400;
    return jsonResponse({ error: message }, status);
  }
});
