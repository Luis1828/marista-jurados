import { authorizeRequest, corsHeaders, jsonResponse, normalizeUsername } from "../_shared/common.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido." }, 405);

  try {
    const { user, profile: actor, serviceClient: db, url, anonKey } = await authorizeRequest(req, "juror");
    const payload = await req.json();
    const bandId = String(payload?.band_id ?? "");
    const username = normalizeUsername(payload?.username);
    const password = String(payload?.password ?? "");
    if (!bandId || !/^[0-9a-f-]{36}$/i.test(bandId)) return jsonResponse({ error: "Selecciona una banda válida." }, 400);
    if (username !== actor.username || password.length < 1) {
      return jsonResponse({ error: "Escribe tu propio usuario y contraseña para confirmar la eliminación." }, 400);
    }

    // Revalidación real de contraseña contra Supabase Auth. No se confía sólo en el JWT existente.
    const verifyResponse = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email: `${username}@login.marista-festival.invalid`, password }),
    });
    const verifyData = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || verifyData?.user?.id !== user.id || !verifyData?.access_token) {
      return jsonResponse({ error: "Usuario o contraseña incorrectos. No se eliminó la banda." }, 401);
    }

    // La verificación de contraseña crea una sesión temporal en Auth. Revocamos
    // su refresh token inmediatamente; la sesión principal del jurado permanece intacta.
    const revokeResponse = await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${verifyData.access_token}`,
      },
    });
    if (!revokeResponse.ok) {
      return jsonResponse({ error: "No se pudo cerrar la sesión temporal de verificación. No se eliminó la banda; inténtalo nuevamente." }, 503);
    }

    const { data: deleted, error: deleteError } = await db.rpc("delete_band_audited", {
      p_band_id: bandId,
      p_actor_id: user.id,
      p_actor_username: actor.username,
    });
    if (deleteError) throw deleteError;
    if (deleted?.photo_path) {
      // La eliminación de la foto se hace después; un fallo de limpieza no revierte la eliminación auditada.
      await db.storage.from("band-photos").remove([deleted.photo_path]).catch(() => ({ error: null }));
    }
    return jsonResponse({ ok: true, message: `La banda “${deleted?.name ?? "seleccionada"}” fue eliminada y registrada en la auditoría.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error interno.";
    const status = /sesión|permiso|deshabilitada|no tienes/i.test(message) ? 403 : 400;
    return jsonResponse({ error: message }, status);
  }
});
