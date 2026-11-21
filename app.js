import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const app = document.getElementById("app");
const toastRegion = document.getElementById("toast-region");
const validConfig = SUPABASE_URL.includes(".supabase.co") && !SUPABASE_URL.includes("TU-PROJECT") &&
  SUPABASE_ANON_KEY.length > 30 && !SUPABASE_ANON_KEY.includes("PEGA_AQUI");
const supabase = validConfig ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null;

const state = {
  session: null,
  profile: null,
  screen: "login",
  bands: [],
  criteria: [],
  adminUsers: [],
  auditLogs: [],
  selectedJurorId: null,
  selectedBandId: null,
  wizard: null,
  cameraStream: null,
  cameraError: "",
  quickRetake: null,
  modal: null,
  busy: false,
};

const usernameEmail = (username) => `${String(username).trim().toLowerCase()}@login.marista-festival.invalid`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const activeCriteria = () => state.criteria.filter((criterion) => criterion.active).sort((a, b) => a.sort_order - b.sort_order);
const isAdmin = () => state.profile?.role === "admin";
const isJuror = () => state.profile?.role === "juror";
const bandScores = (band) => Object.fromEntries((band?.band_scores ?? []).map((item) => [item.criterion_id, Number(item.score)]));
const averageScore = (band) => {
  const criteria = activeCriteria();
  if (!criteria.length) return 0;
  const scores = bandScores(band);
  return criteria.reduce((sum, item) => sum + (Number(scores[item.id]) || 0), 0) / criteria.length;
};
// Los jurados sólo trabajan con sus propias bandas. El RLS también limita
// los datos entregados por Supabase; este filtro define la vista y el podio.
const visibleBands = () => {
  if (isJuror()) return state.bands.filter((band) => band.created_by === state.profile.id);
  if (isAdmin() && state.selectedJurorId) return state.bands.filter((band) => band.created_by === state.selectedJurorId);
  return [];
};
const sortedBands = () => [...visibleBands()].sort((a, b) => averageScore(b) - averageScore(a) || a.name.localeCompare(b.name, "es"));
const selectedJuror = () => state.adminUsers.find((user) => user.id === state.selectedJurorId) ?? null;
const fmtDate = (value) => new Date(value).toLocaleString("es-BO", { dateStyle: "medium", timeStyle: "short" });

function showToast(message, type = "success", duration = 3600) {
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "error" : type === "warning" ? "warning" : ""}`;
  element.textContent = message;
  toastRegion.append(element);
  window.setTimeout(() => element.remove(), duration);
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
}

function resetWizard() {
  stopCamera();
  state.wizard = null;
  state.cameraError = "";
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "No se concedió el permiso de cámara. La cámara es necesaria para registrar o actualizar la fotografía de una banda. En Safari, abre los ajustes del sitio desde el botón aA y permite el acceso a Cámara; después recarga e inténtalo nuevamente.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No se encontró una cámara disponible en este dispositivo. Comprueba que el dispositivo tenga cámara y vuelve a intentarlo.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "La cámara está siendo utilizada por otra aplicación o pestaña. Ciérrala y vuelve a intentarlo.";
  }
  return "No fue posible iniciar la cámara. Comprueba los permisos de Safari y vuelve a intentarlo.";
}

async function startCamera(target = "wizard") {
  const videoId = target === "quick" ? "quick-camera-video" : "camera-video";
  const placeholderId = target === "quick" ? "quick-camera-placeholder" : "camera-placeholder";
  const errorId = target === "quick" ? "quick-camera-error" : "camera-error";
  const video = document.getElementById(videoId);
  const placeholder = document.getElementById(placeholderId);
  if (!video) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = "Este navegador no permite acceder directamente a la cámara. Actualiza iOS/Safari o utiliza el selector de fotos del dispositivo.";
    if (target === "quick" && state.quickRetake) state.quickRetake.error = message;
    else state.cameraError = message;
    render();
    return;
  }
  try {
    if (target === "quick" && state.quickRetake) state.quickRetake.loading = true;
    if (target !== "quick" && state.wizard) state.wizard.cameraLoading = true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (!video.isConnected) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    stopCamera();
    state.cameraStream = stream;
    video.srcObject = stream;
    video.style.display = "block";
    if (placeholder) placeholder.style.display = "none";
    video.classList.add("camera-ready");
    await video.play().catch(() => {});
    const errorNode = document.getElementById(errorId);
    if (errorNode) errorNode.textContent = "";
    if (target === "quick" && state.quickRetake) {
      state.quickRetake.loading = false;
      state.quickRetake.error = "";
      const capture = document.querySelector('[data-action="quick-capture"]');
      if (capture) capture.disabled = false;
    } else if (state.wizard) {
      state.wizard.cameraLoading = false;
      state.cameraError = "";
      const capture = document.querySelector('[data-action="capture-photo"]');
      if (capture) capture.disabled = false;
    }
  } catch (error) {
    const message = cameraErrorMessage(error);
    if (target === "quick" && state.quickRetake) {
      state.quickRetake.loading = false;
      state.quickRetake.error = message;
    } else {
      if (state.wizard) state.wizard.cameraLoading = false;
      state.cameraError = message;
    }
    render();
  }
}

function radarSvg(scores, criteria, large = false) {
  const items = [...criteria].sort((a, b) => a.sort_order - b.sort_order);
  if (!items.length) return "<div class='muted'>No hay criterios activos.</div>";
  const n = items.length;
  const cx = 100, cy = 94, radius = 60;
  const point = (index, scale) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index / n);
    return [cx + Math.cos(angle) * radius * scale, cy + Math.sin(angle) * radius * scale];
  };
  const polygon = (scale) => items.map((_, index) => point(index, scale).map((v) => v.toFixed(1)).join(",")).join(" ");
  const values = items.map((item) => Math.max(0, Math.min(5, Number(scores?.[item.id]) || 0)) / 5);
  const dataPoints = values.map((value, index) => point(index, value).map((v) => v.toFixed(1)).join(",")).join(" ");
  const grid = [0.2, 0.4, 0.6, 0.8, 1].map((scale) => `<polygon points="${polygon(scale)}" fill="none" stroke="#dfe5eb" stroke-width="1"/>`).join("");
  const axes = items.map((_, index) => {
    const [x, y] = point(index, 1);
    const [tx, ty] = point(index, 1.23);
    const label = large ? esc(items[index].label) : esc(items[index].label.length > 8 ? `${items[index].label.slice(0, 7)}…` : items[index].label);
    const anchor = tx < 88 ? "end" : tx > 112 ? "start" : "middle";
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e2e7ed" stroke-width="1"/><text x="${tx}" y="${ty + 3}" font-size="${large ? 8 : 8.5}" text-anchor="${anchor}" fill="#68788c" font-family="DM Sans, sans-serif">${label}</text>`;
  }).join("");
  const dots = values.map((value, index) => {
    const [x, y] = point(index, value);
    return `<circle cx="${x}" cy="${y}" r="${large ? 3.3 : 2.5}" fill="#bf8422" stroke="#fff" stroke-width="1.2"/>`;
  }).join("");
  return `<svg class="${large ? "radar-large" : "radar-small"}" viewBox="0 0 200 190" role="img" aria-label="Gráfico radar de habilidades">${grid}${axes}<polygon points="${dataPoints}" fill="#eab84e" fill-opacity=".28" stroke="#c48a29" stroke-width="2.2" stroke-linejoin="round"/>${dots}<circle cx="${cx}" cy="${cy}" r="2" fill="#c48a29"/></svg>`;
}

function headerHtml() {
  return `<header class="topbar">
    <div class="brand"><div class="brand-symbol">M</div><div class="brand-copy"><strong>FESTIVAL MARISTA</strong><span>Panel de jurados</span></div></div>
    <div class="top-actions">
      <span class="user-chip">${esc(state.profile.username)} · ${isAdmin() ? "Admin" : "Jurado"}</span>
      ${isAdmin() ? `<button class="top-link" data-action="go-users">Usuarios</button><button class="top-link" data-action="go-criteria">Criterios</button>` : `<button class="top-link" data-action="go-delete">Eliminar</button>`}
      <button class="icon-button" title="Registro de actividad" aria-label="Registro de actividad" data-action="go-audit">▤</button>
      <button class="icon-button" title="Cerrar sesión" aria-label="Cerrar sesión" data-action="logout">↪</button>
    </div>
  </header>`;
}

function layout(content) {
  app.innerHTML = `<div class="app-shell">${headerHtml()}${content}<div class="footer-note">Festival Intercolegial · Colegio Marista</div></div>`;
  bindGlobalFocus();
}

function bindGlobalFocus() {
  // Mantiene el foco/teclado en campos restaurados tras un render de estado.
  const focus = app.querySelector("[data-autofocus]");
  if (focus) focus.focus({ preventScroll: true });
}

function renderLogin(error = "") {
  app.innerHTML = `<main class="login-page">
    <section class="login-art">
      <div><div class="brand"><div class="brand-symbol">M</div><div class="brand-copy"><strong>FESTIVAL MARISTA</strong><span>Intercolegial</span></div></div>
      <div class="login-tag">Sistema oficial de evaluación</div><h1>El talento merece una buena evaluación.</h1><p>Plataforma privada para los jurados del Festival Intercolegial del Colegio Marista.</p></div>
      <footer>Acceso exclusivo para personal autorizado · 2026</footer>
    </section>
    <section class="login-panel"><form class="login-box" id="login-form">
      <h2>Bienvenido</h2><p>Ingresa con el usuario y contraseña asignados.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      <div class="field"><label for="login-username">Usuario</label><input id="login-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="24" placeholder="Tu usuario" data-autofocus></div>
      <div class="field"><label for="login-password">Contraseña</label><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Tu contraseña"></div>
      <button class="primary-button" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "Ingresando…" : "Ingresar al panel"} <span>→</span></button>
      <div class="subtle-note">El acceso no requiere correo electrónico ni registro público. Solicita tus credenciales al administrador del festival.</div>
    </form></section>
  </main>`;
}

function bandCard(band, index) {
  const rank = index + 1;
  const medalClass = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
  const photo = band.photo_url ? `<img class="card-photo" src="${esc(band.photo_url)}" alt="Fotografía de ${esc(band.name)}" loading="lazy">` : `<div class="photo-placeholder">♫</div>`;
  const canEditPhoto = isJuror() ? `<button class="photo-edit" aria-label="Retomar fotografía de ${esc(band.name)}" title="Retomar fotografía" data-action="quick-retake" data-id="${band.id}">✎</button>` : "";
  const scoreMap = bandScores(band);
  return `<article class="band-card" data-action="open-band" data-id="${band.id}" tabindex="0" role="button" aria-label="Ver detalles de ${esc(band.name)}">
    <div class="card-photo-wrap">${photo}${rank <= 3 ? `<span class="rank-medal ${medalClass}">${rank}</span>` : ""}${canEditPhoto}</div>
    <div class="card-body"><div class="card-title-row"><h3 class="card-title">${esc(band.name)}</h3><span class="card-average">${averageScore(band).toFixed(2)} / 5</span></div>
      ${radarSvg(scoreMap, activeCriteria())}
      <div class="card-foot"><span>${activeCriteria().length} criterios de habilidad</span><span>${rank <= 3 ? ["🥇","🥈","🥉"][rank - 1] : `Puesto ${rank}`}</span></div>
    </div>
  </article>`;
}

function renderAdminDashboard() {
  const jurors = state.adminUsers.filter((user) => user.role === "juror");
  const cards = jurors.map((user) => {
    const bands = state.bands
      .filter((band) => band.created_by === user.id)
      .sort((a, b) => averageScore(b) - averageScore(a) || a.name.localeCompare(b.name, "es"));
    const leaders = bands.slice(0, 3);
    const preview = leaders.length
      ? `<div class="juror-preview-list">${leaders.map((band, index) => `<span class="juror-preview-chip"><b>${index + 1}.</b> ${esc(band.name)} <small>${averageScore(band).toFixed(2)}</small></span>`).join("")}</div>`
      : `<div class="juror-preview-empty">Todavía no ha registrado bandas.</div>`;
    return `<button class="juror-dashboard-card" type="button" data-action="select-juror" data-id="${user.id}">
      <div class="juror-dashboard-top"><span class="status ${user.is_active ? "active" : "inactive"}">${user.is_active ? "● Acceso habilitado" : "● Acceso deshabilitado"}</span><span class="juror-open-link">Ver evaluación →</span></div>
      <h2>${esc(user.username)}</h2>
      <p>${bands.length} ${bands.length === 1 ? "banda registrada" : "bandas registradas"}</p>
      ${preview}
      <div class="juror-dashboard-bottom"><span>Mejor promedio</span><strong>${bands.length ? `${averageScore(bands[0]).toFixed(2)} / 5` : "—"}</strong></div>
    </button>`;
  }).join("");

  layout(`<main class="page-wrap">
    <section class="hero"><div><div class="eyebrow">Panel de administración</div><h1>Evaluaciones por jurado</h1><p>Cada jurado tiene su propia clasificación y su propio podio. Selecciona uno para consultar exactamente sus bandas.</p></div><button class="secondary-button" data-action="refresh-dashboard">↻ Actualizar datos</button></section>
    <div class="section-head"><h2>Jurados</h2><span class="muted" style="font-size:12px">${jurors.length} cuentas</span></div>
    <div class="juror-dashboard-grid">${cards || `<div class="empty-state"><h3>Aún no hay jurados</h3><p>Crea las cuentas desde Usuarios para que aparezcan sus evaluaciones.</p><button class="primary-button" data-action="go-users">Administrar usuarios</button></div>`}</div>
    <p class="form-hint">La administración puede consultar las evaluaciones, pero no editar ni eliminar bandas ni cambiar puntuaciones.</p>
  </main>`);
}

function renderHome() {
  if (isAdmin() && !state.selectedJurorId) {
    renderAdminDashboard();
    return;
  }

  const bands = sortedBands();
  const juror = isAdmin() ? selectedJuror() : null;
  if (isAdmin() && !juror) {
    state.selectedJurorId = null;
    renderAdminDashboard();
    return;
  }
  const title = juror ? `Bandas de ${juror.username}` : "Mis bandas";
  const back = juror ? `<div class="backline"><button class="back-button" data-action="back-jurors">← Volver a todos los jurados</button></div>` : "";
  const cards = bands.length ? `<div class="band-grid">${bands.map((band, index) => bandCard(band, index)).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">♫</div><h3>Aún no hay bandas registradas</h3><p>${juror ? `${esc(juror.username)} todavía no ha creado bandas.` : "Registra la primera banda para iniciar tu evaluación."}</p>${isJuror() ? `<button class="primary-button" data-action="new-band">＋ Crear primera banda</button>` : ""}</div>`;
  layout(`<main class="page-wrap">
    ${back}
    <section class="hero"><div><div class="eyebrow">${juror ? "Vista individual del jurado · Sólo lectura" : "Evaluación individual"}</div><h1>${esc(title)}</h1><p>${bands.length} ${bands.length === 1 ? "banda registrada" : "bandas registradas"} · Clasificación independiente por promedio</p></div>
      ${isJuror() ? `<button class="primary-button" data-action="new-band">＋ Crear banda</button>` : `<span class="step-pill">Vista de administración · Sólo lectura</span>`}
    </section>
    <div class="section-head"><h2>${juror ? `Clasificación de ${esc(juror.username)}` : "Mi clasificación"}</h2><span class="muted" style="font-size:12px">No se mezclan bandas de otros jurados</span></div>
    ${cards}
    ${bands.length ? `<button class="award-cta" data-action="award"><span>✦</span> PREMIAR GANADORES ${juror ? `· ${esc(juror.username)}` : ""}<span>✦</span></button>` : ""}
  </main>`);
}
function renderBandDetail() {
  const currentBands = sortedBands();
  const band = currentBands.find((item) => item.id === state.selectedBandId);
  if (!band) { state.screen = "home"; state.selectedBandId = null; renderHome(); return; }
  const rank = currentBands.findIndex((item) => item.id === band.id) + 1;
  const scores = bandScores(band);
  const rows = activeCriteria().map((criterion) => `<div class="score-row"><strong>${esc(criterion.label)}</strong><span class="stars">${"★".repeat(scores[criterion.id] || 0)}${"☆".repeat(5 - (scores[criterion.id] || 0))} <b style="color:#34465b;font-size:12px;letter-spacing:0">${scores[criterion.id] || 0}/5</b></span></div>`).join("");
  const detailBackLabel = isAdmin() ? `← Volver a bandas de ${selectedJuror()?.username ?? "jurado"}` : "← Volver a mis bandas";
  layout(`<main class="page-wrap"><div class="backline"><button class="back-button" data-action="back-home">${esc(detailBackLabel)}</button></div>
    <section class="content-card"><div class="detail-header">
      <div>${band.photo_url ? `<img class="detail-photo" src="${esc(band.photo_url)}" alt="Fotografía de ${esc(band.name)}">` : `<div class="detail-photo photo-placeholder">♫</div>`}</div>
      <div><div class="detail-label">${rank <= 3 ? `Puesto ${rank} · ${["Primer lugar","Segundo lugar","Tercer lugar"][rank-1]}` : `Puesto ${rank} de ${currentBands.length}`}</div><h1 class="detail-title">${esc(band.name)}</h1><p class="muted" style="font-size:13px;margin:0 0 14px">Calificación promedio: <strong style="color:#9a711e">${averageScore(band).toFixed(2)} / 5</strong></p>
        <div class="radar-wrap">${radarSvg(scores, activeCriteria(), true)}</div>
        <div class="detail-score-table">${rows}</div>
        <div class="notes-box"><h4>Comentarios y notas adicionales</h4><p>${band.notes?.trim() ? esc(band.notes) : "No se registraron comentarios adicionales."}</p></div>
      </div></div>
      <div class="detail-actions">${isJuror() ? `<button class="primary-button" data-action="edit-band" data-id="${band.id}">✎ Editar banda</button>` : ""}<button class="secondary-button" data-action="back-home">Cancelar</button></div>
    </section>
  </main>`);
}

function photoStepHtml() {
  const wizard = state.wizard;
  if (wizard.photoPreview) {
    return `<div class="camera-frame"><img src="${esc(wizard.photoPreview)}" alt="Vista previa de la fotografía"></div>
      <div class="camera-actions"><button class="secondary-button" data-action="retake-photo">↻ Volver a tomar</button><button class="primary-button" data-action="photo-confirm">Confirmar foto y continuar →</button></div>`;
  }
  if (wizard.existingPhotoUrl && !wizard.retakeMode) {
    return `<div class="camera-frame"><img src="${esc(wizard.existingPhotoUrl)}" alt="Fotografía actual de la banda"></div>
      <div class="camera-actions"><button class="secondary-button" data-action="retake-photo">↻ Retomar fotografía</button><button class="primary-button" data-action="photo-confirm">Conservar foto y continuar →</button></div>
      <p class="camera-help">La fotografía actual se conservará. Sólo se reemplazará si tomas una nueva.</p>`;
  }
  return `<div class="camera-frame">
      <div class="camera-placeholder" id="camera-placeholder"><div class="camera-icon">📷</div><p>${state.cameraError ? "La cámara no está disponible." : "Solicitando acceso a la cámara del dispositivo…"}</p></div>
      <video id="camera-video" autoplay playsinline muted style="display:none"></video>
    </div>
    ${state.cameraError ? `<div class="form-error" id="camera-error">${esc(state.cameraError)}</div>` : `<p class="camera-help" id="camera-error">Centra a todos los integrantes y toma una fotografía horizontal con buena iluminación.</p>`}
    <div class="camera-actions"><button class="secondary-button" data-action="retry-camera">↻ Activar cámara</button><button class="primary-button" data-action="capture-photo" disabled>Tomar fotografía</button></div>
    ${!state.cameraError.toLowerCase().includes("no se concedió el permiso") ? `<div class="camera-actions" style="margin-top:8px"><label class="small-button" for="photo-file">Elegir foto del dispositivo</label><input id="photo-file" type="file" accept="image/*" capture="environment" hidden></div>` : ""}`;
}

function renderWizard() {
  const w = state.wizard;
  if (!w) { state.screen = "home"; renderHome(); return; }
  const criteria = activeCriteria();
  const stepNames = ["Fotografía", "Nombre", "Habilidades", "Comentarios"];
  let body = "";
  if (w.step === 0) {
    body = `<h2>Fotografía de la banda</h2><p class="intro">${w.id ? "Puedes conservar la imagen actual o tomar una fotografía nueva." : "Activa la cámara y captura una fotografía para identificar a la banda."}</p>${photoStepHtml()}`;
  } else if (w.step === 1) {
    body = `<h2>Nombre de la banda</h2><p class="intro">Escribe el nombre con el que aparecerá en la clasificación del festival.</p><div class="field"><label for="band-name">Nombre de la banda</label><input id="band-name" maxlength="90" placeholder="Nombre de la banda" value="${esc(w.name)}" autocomplete="off" data-autofocus></div>`;
  } else if (w.step === 2) {
    const cards = criteria.map((criterion) => {
      const score = Number(w.scores[criterion.id]) || 0;
      return `<div class="criterion-card"><div><strong>${esc(criterion.label)}</strong><small>Valoración de 1 a 5</small></div><div class="star-control" role="group" aria-label="Calificar ${esc(criterion.label)}">${[1,2,3,4,5].map((value) => `<button type="button" class="${value <= score ? "active" : ""}" aria-label="${value} estrellas" aria-pressed="${value === score}" data-action="rate" data-id="${criterion.id}" data-score="${value}">★</button>`).join("")}</div></div>`;
    }).join("");
    body = `<h2>Calificación de habilidades</h2><p class="intro">Valora cada aspecto del 1 al 5. El radar se actualiza en tiempo real con tus selecciones.</p><div class="criteria-grid">${cards}</div><div class="wizard-preview"><div class="radar-wrap">${radarSvg(w.scores, criteria, true)}</div></div>`;
  } else {
    body = `<h2>Comentarios adicionales</h2><p class="intro">Registra observaciones que complementen las puntuaciones. Este campo es opcional.</p>
      <div class="field"><label for="band-notes">Comentarios o notas (opcional)</label><textarea id="band-notes" maxlength="2000" placeholder="Ej.: estilo rock, composiciones propias, originalidad, presencia escénica…">${esc(w.notes)}</textarea></div>
      <div class="notes-box"><h4>Resumen</h4><p><strong>${esc(w.name)}</strong><br>${criteria.map((criterion) => `${esc(criterion.label)}: ${Number(w.scores[criterion.id]) || 0}/5`).join(" · ")}</p></div>`;
  }
  layout(`<main class="page-wrap"><div class="wizard-wrap"><div class="backline"><button class="back-button" data-action="cancel-wizard">← Cancelar y volver</button></div>
    <div class="wizard-top"><div><div class="eyebrow">${w.id ? "Edición de participante" : "Nuevo participante"}</div><h1>${w.id ? "Editar banda" : "Crear banda"}</h1></div><span class="step-pill">Paso ${w.step + 1} de 4 · ${stepNames[w.step]}</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${((w.step + 1) / 4) * 100}%"></div></div>
    <section class="wizard-card">${body}<div class="wizard-actions">${w.step > 0 ? `<button class="secondary-button" data-action="wizard-prev">← Anterior</button>` : `<span class="muted" style="font-size:11px">${w.id ? "Editando información existente" : "El registro requiere fotografía"}</span>`}
      <div class="right">${w.step < 3 ? `<button class="primary-button" data-action="wizard-next" ${w.step === 0 && !w.photoPreview && (!w.existingPhotoUrl || w.retakeMode) ? "disabled" : ""}>Siguiente →</button>` : `<button class="primary-button" data-action="save-band" ${state.busy ? "disabled" : ""}>${state.busy ? "Guardando…" : w.id ? "Guardar cambios" : "Confirmar banda"}</button>`}</div></div>
    </section></div></main>`);
  if (w.step === 0 && !w.photoPreview && (!w.existingPhotoUrl || w.retakeMode) && !state.cameraStream && !state.cameraError) {
    window.setTimeout(() => startCamera("wizard"), 60);
  }
}

function renderDeleteModule() {
  const bands = sortedBands();
  layout(`<main class="page-wrap"><div class="backline"><button class="back-button" data-action="back-home">← Volver al panel principal</button></div>
    <div class="danger-zone"><div class="eyebrow">Módulo independiente</div><h1 style="font:800 30px Manrope;margin:8px 0 7px">Eliminar banda</h1><p class="muted" style="font-size:13px;line-height:1.6">La eliminación es irreversible. Para evitar borrados accidentales, el sistema volverá a verificar tu usuario y contraseña antes de ejecutar la operación.</p>
      <section class="content-card" style="margin-top:20px"><form id="delete-band-form"><div class="field"><label for="delete-band-id">Banda que deseas eliminar</label><select id="delete-band-id" name="band_id" required><option value="">Seleccionar banda…</option>${bands.map((band) => `<option value="${band.id}">${esc(band.name)}</option>`).join("")}</select></div>
      <div class="confirm-panel"><h3>⚠ Confirmación de identidad</h3><p>Ingresa las credenciales de tu propia cuenta. La contraseña se valida directamente con el servicio de autenticación y no se guarda en el registro de actividad.</p></div>
      <div class="field"><label for="delete-username">Usuario</label><input id="delete-username" name="username" autocomplete="username" autocapitalize="none" required value="${esc(state.profile.username)}"></div>
      <div class="field"><label for="delete-password">Contraseña</label><input id="delete-password" name="password" type="password" autocomplete="current-password" required></div>
      <div class="button-row"><button class="danger-button" type="submit" ${state.busy || !bands.length ? "disabled" : ""}>Eliminar permanentemente</button><button class="secondary-button" type="button" data-action="back-home">Cancelar</button></div></form></section>
    </div></main>`);
}

function renderAudit() {
  const criterionLabel = (id) => state.criteria.find((item) => item.id === id)?.label ?? `Criterio ${String(id).slice(0, 8)}`;
  const scoreLines = (scores) => Object.entries(scores ?? {})
    .map(([id, value]) => `${criterionLabel(id)}: ${value}/5`).join("\n");
  const rows = state.auditLogs.map((log) => {
    const tone = log.action.includes("deleted") || log.action === "deleted" ? "deleted" : log.action.includes("created") || log.action === "created" ? "created" : "edited";
    const labels = {
      created: "Creó una banda", edited: "Editó una banda", deleted: "Eliminó una banda",
      user_created: "Creó un usuario", user_deleted: "Eliminó un usuario", password_changed: "Cambió una contraseña",
      access_updated: "Modificó el acceso de un usuario", criteria_created: "Creó un criterio", criteria_updated: "Modificó un criterio",
    };
    let details = "";
    if (["created", "edited", "deleted"].includes(log.action)) {
      const before = log.details?.before ?? {};
      const after = log.details?.after ?? {};
      if (log.action === "created") {
        details = [after.notes ? `Notas: ${after.notes}` : "", scoreLines(after.scores)].filter(Boolean).join("\n");
      } else if (log.action === "deleted") {
        details = ["Registro eliminado permanentemente.", before.notes ? `Notas: ${before.notes}` : "", scoreLines(before.scores)].filter(Boolean).join("\n");
      } else {
        const changes = [];
        if (before.name !== after.name) changes.push(`Nombre: ${before.name ?? "—"} → ${after.name ?? "—"}`);
        if (before.photo_path !== after.photo_path) changes.push("Fotografía actualizada.");
        if ((before.notes ?? "") !== (after.notes ?? "")) changes.push(`Notas: ${before.notes || "(vacío)"} → ${after.notes || "(vacío)"}`);
        const scoreIds = new Set([...Object.keys(before.scores ?? {}), ...Object.keys(after.scores ?? {})]);
        for (const id of scoreIds) {
          const oldValue = before.scores?.[id];
          const newValue = after.scores?.[id];
          if (Number(oldValue ?? 0) !== Number(newValue ?? 0)) {
            changes.push(`${criterionLabel(id)}: ${oldValue ?? "—"}/5 → ${newValue ?? "—"}/5`);
          }
        }
        details = changes.join("\n") || "Se guardaron cambios en la ficha.";
      }
    } else if (log.action === "access_updated") {
      details = log.details?.is_active ? "Acceso habilitado." : "Acceso deshabilitado.";
    } else if (log.action === "password_changed") {
      details = "La contraseña fue restablecida por el administrador. El valor de la contraseña nunca se registra.";
    } else if (log.action === "user_created") {
      details = "Se creó una cuenta de jurado.";
    } else if (log.action === "user_deleted") {
      details = "Se eliminó la cuenta del jurado.";
    } else if (log.action === "criteria_created") {
      details = `Nuevo criterio: ${log.details?.after?.label ?? log.target_name ?? "Sin nombre"}.`;
    } else if (log.action === "criteria_updated") {
      const before = log.details?.before ?? {};
      const after = log.details?.after ?? {};
      const changes = [];
      if (before.label !== after.label) changes.push(`Nombre: ${before.label ?? "—"} → ${after.label ?? "—"}`);
      if (before.active !== after.active) changes.push(after.active ? "Criterio activado." : "Criterio desactivado.");
      if (before.sort_order !== after.sort_order) changes.push(`Posición: ${before.sort_order ?? "—"} → ${after.sort_order ?? "—"}`);
      details = changes.join("\n") || "Se actualizó el criterio.";
    }
    return `<article class="audit-entry ${tone}"><div class="audit-head"><div class="audit-action">${esc(labels[log.action] ?? log.action)} · ${esc(log.target_name ?? log.target_type)}</div><span class="audit-time">${fmtDate(log.created_at)}</span></div><div class="audit-meta">${esc(log.actor_username)} · ${esc(log.actor_role === "admin" ? "Administrador" : "Jurado")}</div>${details ? `<div class="audit-detail">${esc(details)}</div>` : ""}</article>`;
  }).join("");
  layout(`<main class="page-wrap"><div class="backline"><button class="back-button" data-action="back-home">← Volver al panel principal</button></div>
    <div class="hero" style="padding-top:10px"><div><div class="eyebrow">Trazabilidad</div><h1>Registro de actividad</h1><p>Historial de operaciones realizadas por jurados y administración.</p></div><span class="step-pill">Últimos ${state.auditLogs.length} eventos</span></div>
    <section class="audit-list">${rows || `<div class="empty-state"><h3>Sin actividad registrada</h3><p>Los cambios aparecerán aquí.</p></div>`}</section></main>`);
}

function renderUsers() {
  const cards = state.adminUsers.map((user) => `<article class="user-card"><div><div class="user-name">${esc(user.username)}</div><div class="user-meta">Cuenta creada: ${fmtDate(user.created_at)}</div><div style="margin-top:7px"><span class="status ${user.is_active ? "active" : "inactive"}">${user.is_active ? "● Acceso habilitado" : "● Acceso deshabilitado"}</span></div></div>
    <div><div class="user-meta" style="margin:0 0 7px">Bandas registradas por este usuario (${user.bands.length})</div><div class="user-band-list">${user.bands.length ? user.bands.map((band) => `<span class="user-band-chip">${esc(band.name)}</span>`).join("") : `<span class="muted" style="font-size:11px">Todavía no ha creado bandas</span>`}</div></div>
    <div class="user-actions"><button class="small-button" data-action="select-juror" data-id="${user.id}">Ver bandas y podio</button><button class="small-button" data-action="user-password" data-id="${user.id}" data-username="${esc(user.username)}">Contraseña</button><button class="small-button" data-action="user-access" data-id="${user.id}" data-username="${esc(user.username)}" data-active="${user.is_active}">${user.is_active ? "Deshabilitar" : "Habilitar"}</button><button class="small-button danger" data-action="user-delete" data-id="${user.id}" data-username="${esc(user.username)}" ${user.bands.length ? 'disabled title="No se puede eliminar: este jurado tiene bandas registradas. Deshabilita su acceso para conservar su evaluación."' : ""}>Eliminar</button></div>
  </article>`).join("");
  layout(`<main class="page-wrap"><div class="backline"><button class="back-button" data-action="back-home">← Volver al panel principal</button></div>
    <section class="hero" style="padding-top:8px"><div><div class="eyebrow">Administración de cuentas</div><h1>Usuarios</h1><p>Consulta las cuentas y las bandas creadas por cada jurado. No se muestran ni se almacenan contraseñas en este panel.</p></div><button class="primary-button" data-action="new-user">＋ Crear usuario</button></section>
    <div class="user-list">${cards || `<div class="empty-state"><h3>No hay usuarios jurado</h3><p>Crea las cuentas que utilizarán los evaluadores.</p></div>`}</div>
    <p class="form-hint">El administrador no puede editar bandas ni modificar puntuaciones. Las acciones de cuentas quedan registradas en la auditoría.</p>
  </main>`);
}

function renderCriteria() {
  const rows = [...state.criteria].sort((a,b) => a.sort_order - b.sort_order).map((criterion, index, all) => `<div class="criterion-manage"><input type="text" maxlength="50" value="${esc(criterion.label)}" aria-label="Nombre del criterio ${index + 1}" data-criterion-input="${criterion.id}"><label class="toggle-label"><input type="checkbox" data-criterion-active="${criterion.id}" ${criterion.active ? "checked" : ""}> Activo</label><button class="small-button" data-action="criterion-up" data-id="${criterion.id}" ${index === 0 ? "disabled" : ""}>↑</button><button class="small-button" data-action="criterion-down" data-id="${criterion.id}" ${index === all.length - 1 ? "disabled" : ""}>↓</button><button class="small-button" data-action="criterion-save" data-id="${criterion.id}">Guardar</button></div>`).join("");
  layout(`<main class="page-wrap"><div class="backline"><button class="back-button" data-action="back-home">← Volver al panel principal</button></div>
    <section class="hero" style="padding-top:8px"><div><div class="eyebrow">Configuración de evaluación</div><h1>Patrones de calificación</h1><p>Define los ejes del radar y los aspectos que evaluarán los jurados.</p></div><button class="primary-button" data-action="add-criterion">＋ Añadir criterio</button></section>
    <section class="content-card"><div class="section-head" style="margin-top:0"><h2>Criterios de evaluación</h2><span class="step-pill">${activeCriteria().length} activos</span></div>
      <p class="muted" style="font-size:12px;line-height:1.6">Cada criterio se califica con estrellas del 1 al 5. Se necesitan al menos tres criterios activos para guardar una banda. Desactivar un criterio lo retira del cálculo y del radar; los registros históricos se conservan en la auditoría.</p>
      <div class="criteria-list">${rows}</div>
    </section></main>`);
}

function renderModal() {
  app.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
  if (state.quickRetake) {
    const q = state.quickRetake;
    const band = state.bands.find((item) => item.id === q.bandId);
    const content = q.preview
      ? `<div class="camera-frame"><img src="${esc(q.preview)}" alt="Vista previa de la nueva fotografía"></div><div class="camera-actions"><button class="secondary-button" data-action="quick-retake-again">Volver a tomar</button><button class="primary-button" data-action="quick-save-photo" ${state.busy ? "disabled" : ""}>${state.busy ? "Guardando…" : "Guardar nueva foto"}</button></div>`
      : `<div class="camera-frame"><div class="camera-placeholder" id="quick-camera-placeholder"><div class="camera-icon">📷</div><p>${esc(q.error || "Solicitando acceso a la cámara…")}</p></div><video id="quick-camera-video" autoplay playsinline muted style="display:none"></video></div>${q.error ? `<div class="form-error">${esc(q.error)}</div>` : ""}<div class="camera-actions"><button class="secondary-button" data-action="quick-retry-camera">↻ Activar cámara</button><button class="primary-button" data-action="quick-capture" disabled>Tomar fotografía</button></div>`;
    app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal photo-only-modal"><div class="modal-head"><div><div class="eyebrow">Actualizar fotografía</div><h2>${esc(band?.name ?? "Banda")}</h2></div><button class="modal-close" data-action="quick-close" aria-label="Cerrar">×</button></div>${content}</section></div>`);
    if (!q.preview && !q.error && !state.cameraStream) window.setTimeout(() => startCamera("quick"), 60);
    return;
  }
  if (!state.modal) return;
  const m = state.modal;
  let body = "";
  if (m.type === "new-user") body = `<form id="modal-form"><div class="field"><label for="modal-username">Nombre de usuario</label><input id="modal-username" name="username" minlength="3" maxlength="24" pattern="[a-zA-Z0-9._-]{3,24}" autocapitalize="none" required placeholder="ej. jurado01"></div><div class="field"><label for="modal-password">Contraseña inicial</label><input id="modal-password" name="password" type="password" minlength="10" required placeholder="Mínimo 10 caracteres"></div><div class="button-row"><button class="primary-button" type="submit">Crear cuenta</button><button class="secondary-button" type="button" data-action="close-modal">Cancelar</button></div></form>`;
  if (m.type === "password") body = `<form id="modal-form"><p class="muted" style="font-size:13px">Establece una nueva contraseña para <strong>${esc(m.username)}</strong>. La persona deberá utilizarla en su próximo inicio de sesión.</p><div class="field"><label for="modal-password">Nueva contraseña</label><input id="modal-password" name="password" type="password" minlength="10" required placeholder="Mínimo 10 caracteres"></div><div class="button-row"><button class="primary-button" type="submit">Actualizar contraseña</button><button class="secondary-button" type="button" data-action="close-modal">Cancelar</button></div></form>`;
  if (m.type === "confirm-access") body = `<p class="muted" style="font-size:13px">${m.active ? "¿Deseas deshabilitar" : "¿Deseas habilitar"} el acceso de <strong>${esc(m.username)}</strong>?</p><div class="button-row"><button class="primary-button" data-action="confirm-user-access">${m.active ? "Deshabilitar acceso" : "Habilitar acceso"}</button><button class="secondary-button" data-action="close-modal">Cancelar</button></div>`;
  if (m.type === "confirm-delete-user") body = `<div class="confirm-panel"><h3>Eliminar cuenta</h3><p>Se eliminará la cuenta de ${esc(m.username)}. Esta operación sólo está permitida cuando no tiene bandas registradas. Para conservar evaluaciones existentes, deshabilita el acceso en lugar de eliminar la cuenta.</p></div><div class="button-row"><button class="danger-button" data-action="confirm-delete-user">Eliminar cuenta</button><button class="secondary-button" data-action="close-modal">Cancelar</button></div>`;
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal" style="max-width:480px"><div class="modal-head"><h2>${m.type === "new-user" ? "Crear usuario" : m.type === "password" ? "Cambiar contraseña" : m.type === "confirm-access" ? "Administrar acceso" : "Confirmar eliminación"}</h2><button class="modal-close" data-action="close-modal">×</button></div>${body}</section></div>`);
}

function renderAward() {
  app.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
  const bands = sortedBands().slice(0, 3);
  const third = bands[2], second = bands[1], first = bands[0];
  const juryLabel = isAdmin() ? selectedJuror()?.username : state.profile.username;
  const podiumSlot = (band, place, className, emoji) => `<div class="podium-slot ${className}" id="podium-${place}"><img class="podium-photo" src="${esc(band?.photo_url ?? "")}" alt="" onerror="this.style.opacity='0'"><div class="podium-name">${esc(band?.name ?? "Por definir")}</div><div class="podium-block">${emoji}</div></div>`;
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal podium-modal"><div class="award-subtitle">Festival Intercolegial · ${esc(juryLabel ? `Evaluación de ${juryLabel}` : "Resultados")}</div><h2>¡Llegó el momento de premiar!</h2><p>El podio de este jurado se revela de menor a mayor posición.</p><div class="podium-stage">${podiumSlot(second, 2, "second", "2.º")}${podiumSlot(first, 1, "first", "1.º")}${podiumSlot(third, 3, "third", "3.º")}</div><div class="spin-note" id="award-caption">Preparando resultados…</div><div class="podium-actions"><button class="primary-button" data-action="close-award" disabled id="award-close">Cerrar ceremonia</button></div></section></div>`);
  window.setTimeout(() => { document.getElementById("podium-3")?.classList.add("revealed"); const caption = document.getElementById("award-caption"); if (caption) caption.textContent = third ? `Tercer lugar: ${third.name}` : "Tercer lugar"; }, 800);
  window.setTimeout(() => { document.getElementById("podium-2")?.classList.add("revealed"); const caption = document.getElementById("award-caption"); if (caption) caption.textContent = second ? `Segundo lugar: ${second.name}` : "Segundo lugar"; }, 3900);
  window.setTimeout(() => { document.getElementById("podium-1")?.classList.add("revealed"); const caption = document.getElementById("award-caption"); if (caption) caption.textContent = first ? `¡Primer lugar: ${first.name}!` : "Primer lugar"; }, 7200);
  window.setTimeout(() => { const close = document.getElementById("award-close"); if (close) close.disabled = false; const caption = document.getElementById("award-caption"); if (caption) caption.textContent = "¡Felicitaciones a las bandas ganadoras!"; }, 10000);
}

function render() {
  if (!validConfig) {
    app.innerHTML = `<main class="login-page"><section class="login-art"><div><div class="login-tag">Festival Intercolegial Marista</div><h1>Configuración pendiente.</h1><p>La interfaz está preparada, pero todavía debes conectar el proyecto con tu backend Supabase.</p></div><footer>Consulta README.md dentro del proyecto.</footer></section><section class="login-panel"><div class="login-box"><h2>Conecta Supabase</h2><p>Abre <strong>config.js</strong> y reemplaza los dos valores de ejemplo por la URL de tu proyecto y su clave publishable/anon. Nunca pegues la secret/service role key aquí.</p></div></section></main>`;
    return;
  }
  if (!state.profile) { renderLogin(); return; }
  if (state.screen === "home") renderHome();
  else if (state.screen === "detail") renderBandDetail();
  else if (state.screen === "wizard") renderWizard();
  else if (state.screen === "delete") renderDeleteModule();
  else if (state.screen === "audit") renderAudit();
  else if (state.screen === "users") renderUsers();
  else if (state.screen === "criteria") renderCriteria();
  renderModal();
}

async function loadProfile(user) {
  const { data, error } = await supabase.from("user_profiles").select("id, username, role, is_active").eq("id", user.id).single();
  if (error || !data || !data.is_active) {
    await supabase.auth.signOut();
    state.session = null;
    state.profile = null;
    renderLogin("Tu cuenta está deshabilitada o no tiene permisos configurados. Contacta al administrador.");
    return false;
  }
  state.session = { user };
  state.profile = data;
  state.screen = "home";
  state.selectedJurorId = null;
  await refreshData();
  if (isAdmin()) {
    try {
      await fetchAdminUsers();
    } catch (error) {
      console.error("No se pudo cargar el listado administrativo; se intenta la lectura segura directa:", error);
      const { data: users, error: usersError } = await supabase
        .from("user_profiles")
        .select("id, username, role, is_active, created_at")
        .eq("role", "juror")
        .order("username");
      if (usersError) {
        console.error("No se pudo cargar el panel por jurado:", usersError);
        state.adminUsers = [];
      } else {
        state.adminUsers = (users ?? []).map((user) => ({
          ...user,
          bands: state.bands.filter((band) => band.created_by === user.id)
            .map((band) => ({ id: band.id, name: band.name, created_at: band.created_at })),
        }));
      }
    }
  }
  return true;
}

async function refreshData() {
  if (!state.profile) return;
  const [{ data: criteria, error: criteriaError }, { data: bands, error: bandsError }] = await Promise.all([
    supabase.from("scoring_criteria").select("id,label,sort_order,active").order("sort_order"),
    supabase.from("bands").select("id,name,photo_path,notes,created_by,created_at,updated_at,band_scores(criterion_id,score)").order("created_at", { ascending: false }),
  ]);
  if (criteriaError) throw criteriaError;
  if (bandsError) throw bandsError;
  state.criteria = criteria ?? [];
  const results = await Promise.all((bands ?? []).map(async (band) => {
    let photoUrl = "";
    if (band.photo_path) {
      const { data } = await supabase.storage.from("band-photos").createSignedUrl(band.photo_path, 3600);
      photoUrl = data?.signedUrl ?? "";
    }
    return { ...band, photo_url: photoUrl };
  }));
  state.bands = results;
}

async function edgeErrorMessage(error) {
  try {
    const response = error?.context;
    if (response && typeof response.clone === "function") {
      const payload = await response.clone().json();
      if (payload?.error) return payload.error;
      if (payload?.message) return payload.message;
    }
  } catch { /* usar el mensaje genérico del SDK */ }
  return error?.message ?? "La operación no pudo completarse.";
}

async function fetchAdminUsers() {
  const { data, error } = await supabase.functions.invoke("admin-users", { body: { action: "list" } });
  if (error) throw new Error(await edgeErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  state.adminUsers = data.users ?? [];
}

async function fetchAuditLogs() {
  const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(150);
  if (error) throw error;
  state.auditLogs = data ?? [];
}

async function login(form) {
  const formData = new FormData(form);
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!/^[a-z0-9._-]{3,24}$/.test(username)) { renderLogin("El usuario no tiene un formato válido."); return; }
  state.busy = true; renderLogin();
  const { data, error } = await supabase.auth.signInWithPassword({ email: usernameEmail(username), password });
  state.busy = false;
  if (error || !data.user) { renderLogin("Usuario o contraseña incorrectos."); return; }
  const ok = await loadProfile(data.user);
  if (ok) { showToast(`Bienvenido, ${state.profile.username}.`); render(); }
}

async function logout() {
  stopCamera(); resetWizard(); state.quickRetake = null; state.modal = null;
  await supabase.auth.signOut();
  state.profile = null; state.session = null; state.screen = "login";
  renderLogin();
}

function openNewWizard() {
  if (!isJuror()) return;
  if (activeCriteria().length < 3) { showToast("El administrador debe activar al menos tres criterios de evaluación.", "warning"); return; }
  state.wizard = { id: null, step: 0, name: "", notes: "", photoBlob: null, photoPreview: "", photoPath: null, existingPhotoUrl: "", retakeMode: true, scores: Object.fromEntries(activeCriteria().map((criterion) => [criterion.id, 0])) };
  state.cameraError = ""; state.screen = "wizard"; render();
}

function openEditWizard(id) {
  if (!isJuror()) return;
  const band = state.bands.find((item) => item.id === id);
  if (!band) return;
  const scores = bandScores(band);
  state.wizard = { id: band.id, step: 0, name: band.name, notes: band.notes ?? "", photoBlob: null, photoPreview: "", photoPath: band.photo_path, existingPhotoUrl: band.photo_url, retakeMode: false, scores: Object.fromEntries(activeCriteria().map((criterion) => [criterion.id, scores[criterion.id] ?? 0])) };
  state.cameraError = ""; state.selectedBandId = id; state.screen = "wizard"; render();
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function captureFromVideo(videoId, callback) {
  const video = document.getElementById(videoId);
  if (!video || !state.cameraStream || video.videoWidth === 0) { showToast("La cámara todavía no está lista. Inténtalo de nuevo.", "warning"); return; }
  const canvas = document.createElement("canvas");
  const maxWidth = 1600;
  const ratio = Math.min(1, maxWidth / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * ratio);
  canvas.height = Math.round(video.videoHeight * ratio);
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) { showToast("No se pudo procesar la fotografía.", "error"); return; }
    callback(blob, canvas.toDataURL("image/jpeg", .9));
  }, "image/jpeg", .9);
}

async function fileToJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    const ratio = Math.min(1, 1600 / image.naturalWidth);
    canvas.width = Math.round(image.naturalWidth * ratio);
    canvas.height = Math.round(image.naturalHeight * ratio);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo procesar la imagen.")), "image/jpeg", .9));
  } finally { URL.revokeObjectURL(url); }
}

async function uploadPhoto(blob, id) {
  const path = `${state.profile.id}/${id}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from("band-photos").upload(path, blob, { contentType: "image/jpeg", cacheControl: "3600", upsert: false });
  if (error) throw error;
  return path;
}

async function saveWizard() {
  const w = state.wizard;
  if (!w) return;
  const nameInput = document.getElementById("band-name");
  const notesInput = document.getElementById("band-notes");
  if (nameInput) w.name = nameInput.value.trim();
  if (notesInput) w.notes = notesInput.value.trim();
  if (!w.name || w.name.length > 90) { showToast("Escribe un nombre de banda válido.", "warning"); return; }
  const criteria = activeCriteria();
  const missing = criteria.filter((criterion) => !(Number(w.scores[criterion.id]) >= 1 && Number(w.scores[criterion.id]) <= 5));
  if (missing.length) { showToast(`Completa la calificación de: ${missing.map((item) => item.label).join(", ")}.`, "warning", 5000); state.wizard.step = 2; render(); return; }
  if (!w.photoBlob && !w.photoPath) { showToast("Debes tomar una fotografía antes de guardar.", "warning"); state.wizard.step = 0; render(); return; }
  state.busy = true; render();
  let newPath = null;
  try {
    const bandIdForPath = w.id ?? crypto.randomUUID();
    let photoPath = w.photoPath;
    if (w.photoBlob) { newPath = await uploadPhoto(w.photoBlob, bandIdForPath); photoPath = newPath; }
    const scores = Object.fromEntries(criteria.map((criterion) => [criterion.id, Number(w.scores[criterion.id])]));
    const { data, error } = await supabase.rpc("save_band", {
      p_id: w.id,
      p_name: w.name,
      p_photo_path: photoPath,
      p_notes: w.notes,
      p_scores: scores,
    });
    if (error) throw error;
    const oldPath = w.id ? state.bands.find((item) => item.id === w.id)?.photo_path : null;
    if (oldPath && newPath && oldPath !== newPath) await supabase.storage.from("band-photos").remove([oldPath]);
    const savedId = data;
    stopCamera(); state.wizard = null; state.cameraError = "";
    await refreshData();
    state.busy = false;
    if (w.id) { state.selectedBandId = savedId; state.screen = "detail"; showToast("Los cambios se guardaron correctamente."); }
    else { state.screen = "home"; showToast("La banda se creó exitosamente."); }
    render();
  } catch (error) {
    if (newPath) await supabase.storage.from("band-photos").remove([newPath]);
    state.busy = false;
    showToast(error.message ?? "No se pudo guardar la banda.", "error", 6000);
    render();
  }
}

async function quickRetakeSave() {
  const q = state.quickRetake;
  if (!q?.blob) return;
  const band = state.bands.find((item) => item.id === q.bandId);
  if (!band) return;
  state.busy = true; renderModal();
  let newPath = null;
  try {
    newPath = await uploadPhoto(q.blob, band.id);
    const scores = Object.fromEntries(activeCriteria().map((criterion) => [criterion.id, bandScores(band)[criterion.id] ?? 0]));
    const { error } = await supabase.rpc("save_band", { p_id: band.id, p_name: band.name, p_photo_path: newPath, p_notes: band.notes ?? "", p_scores: scores });
    if (error) throw error;
    if (band.photo_path) await supabase.storage.from("band-photos").remove([band.photo_path]);
    stopCamera(); state.quickRetake = null; state.busy = false;
    await refreshData(); render(); showToast("Fotografía actualizada correctamente.");
  } catch (error) {
    if (newPath) await supabase.storage.from("band-photos").remove([newPath]);
    state.busy = false; showToast(error.message ?? "No se pudo cambiar la foto.", "error"); renderModal();
  }
}

async function deleteBand(form) {
  const data = new FormData(form);
  const payload = { band_id: data.get("band_id"), username: data.get("username"), password: data.get("password") };
  if (!payload.band_id) { showToast("Selecciona una banda.", "warning"); return; }
  if (String(payload.username).trim().toLowerCase() !== state.profile.username) { showToast("Debes confirmar con tu propio usuario.", "warning"); return; }
  if (!window.confirm("Esta acción eliminará la banda de forma permanente. ¿Deseas continuar?")) return;
  state.busy = true; renderDeleteModule();
  const { data: result, error } = await supabase.functions.invoke("delete-band", { body: payload });
  state.busy = false;
  if (error || result?.error) { showToast(result?.error ?? await edgeErrorMessage(error), "error", 6000); renderDeleteModule(); return; }
  await refreshData(); state.screen = "home"; render(); showToast(result.message ?? "Banda eliminada.");
}

async function callAdminAction(payload) {
  const { data, error } = await supabase.functions.invoke("admin-users", { body: payload });
  if (error) throw new Error(await edgeErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

async function changeCriterion(id) {
  const criterion = state.criteria.find((item) => item.id === id);
  if (!criterion || !isAdmin()) return;
  const labelInput = document.querySelector(`[data-criterion-input="${id}"]`);
  const activeInput = document.querySelector(`[data-criterion-active="${id}"]`);
  const newLabel = labelInput?.value.trim() ?? criterion.label;
  const newActive = Boolean(activeInput?.checked);
  if (!newLabel || newLabel.length > 50) { showToast("El criterio debe tener entre 1 y 50 caracteres.", "warning"); return; }
  const activeCount = activeCriteria().length + (criterion.active ? 0 : 0) + (newActive !== criterion.active ? (newActive ? 1 : -1) : 0);
  if (activeCount < 3) { showToast("Debe haber al menos tres criterios activos.", "warning"); if (activeInput) activeInput.checked = true; return; }
  const { error } = await supabase.from("scoring_criteria").update({ label: newLabel, active: newActive, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  await refreshData(); await fetchAuditLogs(); renderCriteria(); showToast("Criterio actualizado.");
}

async function reorderCriterion(id, direction) {
  const list = [...state.criteria].sort((a,b) => a.sort_order - b.sort_order);
  const index = list.findIndex((item) => item.id === id);
  const other = list[index + direction];
  if (index < 0 || !other) return;
  const first = await supabase.from("scoring_criteria").update({ sort_order: other.sort_order, updated_at: new Date().toISOString() }).eq("id", list[index].id);
  const second = await supabase.from("scoring_criteria").update({ sort_order: list[index].sort_order, updated_at: new Date().toISOString() }).eq("id", other.id);
  if (first.error || second.error) { showToast(first.error?.message ?? second.error?.message, "error"); return; }
  await refreshData(); await fetchAuditLogs(); renderCriteria();
}

async function handleClick(event) {
  const actionNode = event.target.closest("[data-action]");
  if (!actionNode) return;
  const action = actionNode.dataset.action;
  const id = actionNode.dataset.id;
  if (action === "new-band") openNewWizard();
  else if (action === "open-band") { if (event.target.closest(".photo-edit")) return; if (!sortedBands().some((band) => band.id === id)) return; state.selectedBandId = id; state.screen = "detail"; render(); }
  else if (action === "back-home") { resetWizard(); state.modal = null; state.screen = "home"; render(); }
  else if (action === "back-jurors") { state.selectedJurorId = null; state.selectedBandId = null; state.screen = "home"; render(); }
  else if (action === "select-juror") { if (!isAdmin() || !state.adminUsers.some((user) => user.id === id)) return; state.selectedJurorId = id; state.selectedBandId = null; state.screen = "home"; render(); }
  else if (action === "refresh-dashboard") { try { await refreshData(); await fetchAdminUsers(); renderHome(); showToast("Evaluaciones actualizadas."); } catch (error) { showToast(error.message, "error"); } }
  else if (action === "edit-band") openEditWizard(id);
  else if (action === "cancel-wizard") {
    const editingId = state.wizard?.id;
    resetWizard();
    if (editingId) { state.selectedBandId = editingId; state.screen = "detail"; }
    else state.screen = "home";
    render();
  }
  else if (action === "wizard-prev") {
    if (state.wizard.step === 1) state.wizard.name = document.getElementById("band-name")?.value.trim() ?? state.wizard.name;
    if (state.wizard.step === 3) state.wizard.notes = document.getElementById("band-notes")?.value ?? state.wizard.notes;
    state.wizard.step = Math.max(0, state.wizard.step - 1); state.cameraError = ""; stopCamera(); render();
  }
  else if (action === "wizard-next") {
    if (state.wizard.step === 0 && !state.wizard.photoPreview && (!state.wizard.existingPhotoUrl || state.wizard.retakeMode)) { showToast("Toma una fotografía antes de continuar.", "warning"); return; }
    if (state.wizard.step === 1) {
      const name = document.getElementById("band-name")?.value.trim() ?? "";
      if (!name || name.length > 90) { showToast("Escribe un nombre de banda válido.", "warning"); return; }
      state.wizard.name = name;
    }
    if (state.wizard.step === 2) {
      const missing = activeCriteria().filter((criterion) => !(Number(state.wizard.scores[criterion.id]) >= 1));
      if (missing.length) { showToast(`Falta calificar: ${missing.map((item) => item.label).join(", ")}.`, "warning", 5000); return; }
    }
    if (state.wizard.step === 0 && state.wizard.photoPreview && !state.wizard.id) state.wizard.photoPath = null;
    state.wizard.step += 1;
    stopCamera(); render();
  }
  else if (action === "rate") { state.wizard.scores[id] = Number(actionNode.dataset.score); renderWizard(); }
  else if (action === "capture-photo") captureFromVideo("camera-video", (blob, preview) => { state.wizard.photoBlob = blob; state.wizard.photoPreview = preview; state.wizard.retakeMode = true; stopCamera(); renderWizard(); });
  else if (action === "retry-camera") { state.cameraError = ""; renderWizard(); }
  else if (action === "retake-photo") { state.wizard.photoPreview = ""; state.wizard.photoBlob = null; state.wizard.retakeMode = true; state.cameraError = ""; renderWizard(); }
  else if (action === "photo-confirm") { if (!state.wizard.photoPreview && !state.wizard.existingPhotoUrl) return; state.wizard.step = 1; renderWizard(); }
  else if (action === "save-band") saveWizard();
  else if (action === "go-delete") { state.screen = "delete"; render(); }
  else if (action === "go-audit") { try { state.selectedJurorId = null; await fetchAuditLogs(); state.screen = "audit"; render(); } catch (error) { showToast(error.message, "error"); } }
  else if (action === "go-users") { try { state.selectedJurorId = null; await fetchAdminUsers(); state.screen = "users"; render(); } catch (error) { showToast(error.message, "error"); } }
  else if (action === "go-criteria") { state.selectedJurorId = null; state.screen = "criteria"; render(); }
  else if (action === "logout") logout();
  else if (action === "quick-retake") { if (!isJuror()) return; state.quickRetake = { bandId: id, preview: "", blob: null, error: "", loading: true }; renderModal(); }
  else if (action === "quick-close") { stopCamera(); state.quickRetake = null; render(); }
  else if (action === "quick-retry-camera") { stopCamera(); state.quickRetake.error = ""; state.quickRetake.loading = true; renderModal(); }
  else if (action === "quick-capture") captureFromVideo("quick-camera-video", (blob, preview) => { state.quickRetake.blob = blob; state.quickRetake.preview = preview; stopCamera(); renderModal(); });
  else if (action === "quick-retake-again") { state.quickRetake.preview = ""; state.quickRetake.blob = null; state.quickRetake.error = ""; renderModal(); }
  else if (action === "quick-save-photo") quickRetakeSave();
  else if (action === "award") { if (!sortedBands().length) { showToast("Todavía no hay bandas para premiar.", "warning"); return; } renderAward(); }
  else if (action === "close-award") { document.querySelector(".modal-backdrop")?.remove(); }
  else if (action === "new-user") { state.modal = { type: "new-user" }; renderModal(); }
  else if (action === "close-modal") { state.modal = null; document.querySelector(".modal-backdrop")?.remove(); }
  else if (action === "user-password") { state.modal = { type: "password", id, username: actionNode.dataset.username }; renderModal(); }
  else if (action === "user-access") { state.modal = { type: "confirm-access", id, username: actionNode.dataset.username, active: actionNode.dataset.active === "true" }; renderModal(); }
  else if (action === "user-delete") { const targetUser = state.adminUsers.find((user) => user.id === id); if (targetUser?.bands?.length) { showToast("No puedes eliminar una cuenta que conserva bandas. Deshabilita su acceso para mantener su evaluación.", "warning", 5000); return; } state.modal = { type: "confirm-delete-user", id, username: actionNode.dataset.username }; renderModal(); }
  else if (action === "confirm-user-access") {
    try { await callAdminAction({ action: "set_access", username: state.modal.username, is_active: !state.modal.active }); state.modal = null; await fetchAdminUsers(); await fetchAuditLogs(); renderUsers(); showToast("Permisos de acceso actualizados."); }
    catch (error) { showToast(error.message, "error"); }
  }
  else if (action === "confirm-delete-user") {
    try { await callAdminAction({ action: "delete", username: state.modal.username }); state.modal = null; await fetchAdminUsers(); await fetchAuditLogs(); renderUsers(); showToast("Cuenta eliminada."); }
    catch (error) { showToast(error.message, "error"); }
  }
  else if (action === "add-criterion") {
    const maxOrder = Math.max(0, ...state.criteria.map((item) => item.sort_order));
    const { error } = await supabase.from("scoring_criteria").insert({ label: `Nuevo criterio ${maxOrder}`, sort_order: maxOrder + 1, active: true });
    if (error) showToast(error.message, "error"); else { await refreshData(); await fetchAuditLogs(); renderCriteria(); showToast("Criterio añadido. Cambia su nombre y guarda."); }
  }
  else if (action === "criterion-save") changeCriterion(id);
  else if (action === "criterion-up") reorderCriterion(id, -1);
  else if (action === "criterion-down") reorderCriterion(id, 1);
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form.matches("form")) return;
  if (form.id === "login-form") { event.preventDefault(); login(form); }
  else if (form.id === "delete-band-form") { event.preventDefault(); deleteBand(form); }
  else if (form.id === "modal-form") {
    event.preventDefault();
    const data = new FormData(form);
    try {
      if (state.modal.type === "new-user") {
        await callAdminAction({ action: "create", username: data.get("username"), password: data.get("password") });
        state.modal = null; await fetchAdminUsers(); await fetchAuditLogs(); renderUsers(); showToast("Usuario creado correctamente.");
      } else if (state.modal.type === "password") {
        await callAdminAction({ action: "set_password", username: state.modal.username, password: data.get("password") });
        state.modal = null; await fetchAdminUsers(); await fetchAuditLogs(); renderUsers(); showToast("Contraseña actualizada correctamente.");
      }
    } catch (error) { showToast(error.message, "error", 6000); }
  }
}

async function handleChange(event) {
  const target = event.target;
  if (target.id === "photo-file" && target.files?.[0]) {
    try {
      const blob = await fileToJpeg(target.files[0]);
      const preview = URL.createObjectURL(blob);
      state.wizard.photoBlob = blob; state.wizard.photoPreview = preview; state.wizard.retakeMode = true; state.cameraError = ""; stopCamera(); renderWizard();
    } catch (error) { showToast(error.message ?? "No se pudo leer esa fotografía.", "error"); }
  }
  if (target.dataset.criterionActive) {
    // La selección se guarda explícitamente con el botón Guardar de esa fila.
  }
}

app.addEventListener("click", (event) => { handleClick(event).catch((error) => showToast(error.message ?? "Ocurrió un error.", "error")); });
app.addEventListener("submit", (event) => { handleSubmit(event).catch((error) => showToast(error.message ?? "Ocurrió un error.", "error")); });
app.addEventListener("change", (event) => { handleChange(event).catch((error) => showToast(error.message ?? "Ocurrió un error.", "error")); });
app.addEventListener("keydown", (event) => {
  if (event.target.matches(".band-card") && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.target.click(); }
});

async function init() {
  if (!validConfig) { render(); return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    const ok = await loadProfile(session.user);
    if (ok) render();
    else renderLogin();
  } else renderLogin();
  supabase.auth.onAuthStateChange((event, sessionNow) => {
    if (event === "SIGNED_OUT") {
      state.session = null; state.profile = null; state.screen = "login";
      renderLogin();
    }
    if (event === "TOKEN_REFRESHED" && sessionNow) state.session = sessionNow;
  });
}

init().catch((error) => {
  console.error(error);
  renderLogin("No se pudo iniciar la aplicación. Verifica la conexión con Supabase y vuelve a cargar.");
});
