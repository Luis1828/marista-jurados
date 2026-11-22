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
  screen: "public",
  publicResults: null,
  publicLoading: false,
  publicError: "",
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
// El promedio usa la suma entera de todos los criterios activos. Como todas
// las bandas comparten el mismo denominador, comparar esta suma detecta
// empates exactos sin confundirlos con valores que sólo se redondean igual.
const scoreTotal = (band) => {
  const scores = bandScores(band);
  return activeCriteria().reduce((sum, item) => sum + (Number(scores[item.id]) || 0), 0);
};
const averageScore = (band) => {
  const count = activeCriteria().length;
  return count ? scoreTotal(band) / count : 0;
};
const compareBands = (a, b) => {
  const scoreDifference = scoreTotal(b) - scoreTotal(a);
  if (scoreDifference) return scoreDifference;
  const aOrder = a.tie_break_order == null ? null : Number(a.tie_break_order);
  const bOrder = b.tie_break_order == null ? null : Number(b.tie_break_order);
  if (Number.isInteger(aOrder) && Number.isInteger(bOrder) && aOrder !== bOrder) return aOrder - bOrder;
  return a.name.localeCompare(b.name, "es");
};
const sortBandList = (bands) => [...bands].sort(compareBands);
function buildTieGroups(bands) {
  const ordered = sortBandList(bands);
  const groups = [];
  for (let index = 0; index < ordered.length;) {
    const total = scoreTotal(ordered[index]);
    let end = index + 1;
    while (end < ordered.length && scoreTotal(ordered[end]) === total) end += 1;
    const members = ordered.slice(index, end);
    if (members.length > 1) {
      const orders = members.map((band) => band.tie_break_order == null ? null : Number(band.tie_break_order));
      const resolved = orders.every(Number.isInteger) && new Set(orders).size === members.length &&
        Math.min(...orders) === 1 && Math.max(...orders) === members.length;
      groups.push({
        scoreTotal: total,
        average: activeCriteria().length ? total / activeCriteria().length : 0,
        bands: members,
        startRank: index + 1,
        endRank: end,
        resolved,
      });
    }
    index = end;
  }
  return groups;
}
const visibleBands = () => {
  if (isJuror()) return state.bands.filter((band) => band.created_by === state.profile.id);
  if (isAdmin() && state.selectedJurorId) return state.bands.filter((band) => band.created_by === state.selectedJurorId);
  return [];
};
const sortedBands = () => sortBandList(visibleBands());
const currentTieGroups = () => buildTieGroups(visibleBands());
const tieGroupForBand = (band, groups = currentTieGroups()) => groups.find((group) => group.bands.some((item) => item.id === band.id)) ?? null;
const selectedJuror = () => state.adminUsers.find((user) => user.id === state.selectedJurorId) ?? null;

function tieWarningsHtml(groups) {
  if (!groups.length) return "";
  return `<div class="tie-warning-list">${groups.map((group) => {
    const names = group.bands.map((band) => esc(band.name)).join(" · ");
    const stateText = group.resolved
      ? `El jurado ya decidió el orden. Las bandas conservan el empate de promedio.`
      : (isJuror()
          ? "Elige manualmente el orden. Esta decisión no modifica ninguna calificación."
          : "Desempate pendiente: el jurado debe definir el orden desde su propia cuenta.");
    const action = !group.resolved && isJuror()
      ? `<button class="tie-resolve-button" data-action="resolve-tie" data-score-total="${group.scoreTotal}">Resolver empate →</button>`
      : `<span class="tie-status ${group.resolved ? "resolved" : "pending"}">${group.resolved ? "Orden decidido" : "Pendiente"}</span>`;
    return `<section class="tie-warning ${group.resolved ? "resolved" : "pending"}">
      <div class="tie-warning-icon">⚖</div>
      <div class="tie-warning-copy"><strong>${group.resolved ? "EMPATE DE PROMEDIO · ORDEN DEFINIDO" : "EMPATE DETECTADO · REQUIERE DECISIÓN"}</strong>
        <p>${group.bands.length} bandas comparten exactamente ${group.average.toFixed(2)} / 5 y ocupan ${group.startRank === group.endRank ? `el puesto ${group.startRank}` : `los puestos ${group.startRank}–${group.endRank}`}.</p>
        <div class="tie-band-names">${names}</div><small>${stateText}</small>
      </div>${action}
    </section>`;
  }).join("")}</div>`;
}
const fmtDate = (value) => new Date(value).toLocaleString("es-BO", { dateStyle: "medium", timeStyle: "short" });

// Normaliza mayúsculas, tildes, espacios y signos para reconocer variantes de escritura.
function normalizePublicBandName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function editDistance(a, b) {
  const rows = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = rows[j];
      rows[j] = Math.min(
        rows[j] + 1,
        rows[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  return rows[b.length];
}

function publicImageUrl(path) {
  if (!path || !supabase) return "";
  const { data } = supabase.storage.from("band-photos").getPublicUrl(path);
  return data?.publicUrl ?? "";
}

function buildPublicStandings(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const criteriaCount = Number(payload?.criteria_count) || 0;
  const exactMap = new Map();
  entries.forEach((entry) => {
    const normalized = normalizePublicBandName(entry.name);
    if (!normalized || criteriaCount < 1) return;
    if (!exactMap.has(normalized)) exactMap.set(normalized, { normalized, entries: [], names: [] });
    const group = exactMap.get(normalized);
    group.entries.push(entry);
    if (!group.names.includes(entry.name)) group.names.push(entry.name);
  });

  // Unir primero variantes exactas tras normalizar tildes, mayúsculas y signos.
  const baseGroups = [...exactMap.values()];
  const adjacency = baseGroups.map(() => []);
  for (let i = 0; i < baseGroups.length; i += 1) {
    for (let j = i + 1; j < baseGroups.length; j += 1) {
      const a = baseGroups[i].normalized;
      const b = baseGroups[j].normalized;
      const distance = editDistance(a, b);
      const minLength = Math.min(a.length, b.length);
      const jurorsA = new Set(baseGroups[i].entries.map((entry) => String(entry.judge_key ?? "unknown")));
      const jurorsB = new Set(baseGroups[j].entries.map((entry) => String(entry.judge_key ?? "unknown")));
      const sameJurorEnteredBoth = [...jurorsA].some((key) => jurorsB.has(key));
      if (distance === 1 && minLength >= 8 && !sameJurorEnteredBoth) {
        adjacency[i].push({ index: j });
        adjacency[j].push({ index: i });
      }
    }
  }

  const parent = baseGroups.map((_, index) => index);
  const find = (value) => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const union = (a, b) => {
    const rootA = find(a), rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  adjacency.forEach((neighbors, index) => {
    if (neighbors.length !== 1) return;
    const other = neighbors[0].index;
    if (adjacency[other].length === 1 && adjacency[other][0].index === index) union(index, other);
  });

  const clustered = new Map();
  baseGroups.forEach((group, index) => {
    const root = find(index);
    if (!clustered.has(root)) clustered.set(root, { entries: [], names: [], normalizedKeys: [] });
    const target = clustered.get(root);
    target.entries.push(...group.entries);
    group.names.forEach((name) => { if (!target.names.includes(name)) target.names.push(name); });
    target.normalizedKeys.push(group.normalized);
  });

  const reviewCandidates = [];
  for (let i = 0; i < baseGroups.length; i += 1) {
    for (let j = i + 1; j < baseGroups.length; j += 1) {
      const a = baseGroups[i].normalized;
      const b = baseGroups[j].normalized;
      if (a.length < 6 || b.length < 6) continue;
      const similarity = 1 - editDistance(a, b) / Math.max(a.length, b.length);
      if (find(i) !== find(j) && similarity >= 0.72) {
        reviewCandidates.push({ a: baseGroups[i].names[0], b: baseGroups[j].names[0], similarity });
      }
    }
  }

  const standings = [...clustered.values()].map((group) => {
    // Un jurado cuenta una sola vez por banda. Si escribió una variante más de
    // una vez, primero se promedian sus entradas dentro de ese mismo jurado.
    const totalsByJuror = new Map();
    const criteriaByJuror = new Map();
    group.entries.forEach((entry) => {
      const judgeKey = String(entry.judge_key ?? "unknown");
      const total = Number(entry.score_total) / criteriaCount;
      if (Number.isFinite(total)) {
        if (!totalsByJuror.has(judgeKey)) totalsByJuror.set(judgeKey, []);
        totalsByJuror.get(judgeKey).push(total);
      }
      if (!criteriaByJuror.has(judgeKey)) criteriaByJuror.set(judgeKey, new Map());
      const jurorCriteria = criteriaByJuror.get(judgeKey);
      (Array.isArray(entry.criterion_scores) ? entry.criterion_scores : []).forEach((item) => {
        const label = String(item?.label ?? "").trim();
        const value = Number(item?.score);
        if (!label || !Number.isFinite(value)) return;
        if (!jurorCriteria.has(label)) jurorCriteria.set(label, []);
        jurorCriteria.get(label).push(value);
      });
    });
    const judgeAverages = [...totalsByJuror.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    const average = judgeAverages.length
      ? judgeAverages.reduce((sum, value) => sum + value, 0) / judgeAverages.length
      : 0;

    const criterionLabels = new Map();
    (payload?.criteria ?? []).forEach((item) => {
      if (item?.label) criterionLabels.set(String(item.label), Number(item.sort_order) || 0);
    });
    const criteria = [...criterionLabels.entries()].map(([label, sortOrder]) => {
      const jurorValues = [];
      criteriaByJuror.forEach((jurorCriteria) => {
        const values = jurorCriteria.get(label);
        if (values?.length) jurorValues.push(values.reduce((sum, value) => sum + value, 0) / values.length);
      });
      const criterionAverage = jurorValues.length
        ? jurorValues.reduce((sum, value) => sum + value, 0) / jurorValues.length
        : 0;
      return { label, sort_order: sortOrder, average: criterionAverage, jurorCount: jurorValues.length };
    }).sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label, "es"));

    const nameFrequency = new Map();
    group.entries.forEach((entry) => nameFrequency.set(entry.name, (nameFrequency.get(entry.name) ?? 0) + 1));
    const nameQuality = (value) => {
      const capitals = (String(value).match(/[A-ZÁÉÍÓÚÜÑ]/g) ?? []).length;
      const punctuation = (String(value).match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
      return capitals - punctuation * 2;
    };
    const displayName = [...nameFrequency.entries()]
      .sort((a, b) => b[1] - a[1] || nameQuality(b[0]) - nameQuality(a[0]) || a[0].localeCompare(b[0], "es"))[0]?.[0] ?? group.names[0] ?? "Banda";

    const notes = [...new Set(group.entries.map((entry) => String(entry.notes ?? "").trim()).filter(Boolean))];
    const photoMap = new Map();
    group.entries.forEach((entry) => {
      const path = String(entry.photo_path ?? "").trim();
      if (!path) return;
      const existing = photoMap.get(path);
      const timestamp = entry.updated_at ? new Date(entry.updated_at).getTime() : 0;
      if (!existing || timestamp > existing.timestamp) {
        photoMap.set(path, { path, timestamp, url: publicImageUrl(path) });
      }
    });
    const photos = [...photoMap.values()].sort((a, b) => b.timestamp - a.timestamp);

    return {
      name: displayName,
      aliases: [...new Set(group.names)].filter((name) => name !== displayName),
      average,
      jurorCount: totalsByJuror.size,
      autoMatched: group.normalizedKeys.length > 1,
      criteria,
      notes,
      photos,
      photoUrl: photos[0]?.url ?? "",
    };
  }).sort((a, b) => b.average - a.average || a.name.localeCompare(b.name, "es"));

  let previousAverage = null;
  let currentRank = 0;
  standings.forEach((item, index) => {
    if (previousAverage === null || Math.abs(item.average - previousAverage) > 1e-9) currentRank = index + 1;
    item.rank = currentRank;
    previousAverage = item.average;
    item.tied = standings.filter((other) => Math.abs(other.average - item.average) <= 1e-9).length > 1;
  });

  reviewCandidates.sort((a, b) => b.similarity - a.similarity);
  return {
    standings,
    reviewCandidates: reviewCandidates.slice(0, 6),
    incompleteCount: Number(payload?.incomplete_count) || 0,
    participatingJurors: Number(payload?.jurors_count) || 0,
  };
}

function publicBandDetailsHtml(band) {
  const photos = band.photos?.length
    ? `<div class="public-photo-gallery">${band.photos.map((photo, index) => `<img src="${esc(photo.url)}" alt="Fotografía ${index + 1} de ${esc(band.name)}" loading="lazy">`).join("")}</div>`
    : `<div class="public-no-photo">No se registró fotografía.</div>`;
  const radarCriteria = (band.criteria ?? []).map((item, index) => ({ id: item.label, label: item.label, sort_order: index }));
  const radarScores = Object.fromEntries((band.criteria ?? []).map((item) => [item.label, item.average]));
  const skills = (band.criteria ?? []).map((item) => `<div class="public-skill-row"><span>${esc(item.label)}</span><strong>${item.average.toFixed(2)} / 5</strong></div>`).join("");
  const notes = band.notes?.length
    ? band.notes.map((note) => `<p>${esc(note)}</p>`).join("")
    : `<p>No se registraron comentarios adicionales.</p>`;
  return `<details class="public-band-details"><summary>Ver fotografías, habilidades y comentarios</summary>
    <div class="public-detail-grid">
      <section class="public-detail-section"><h4>Fotografías de la banda</h4>${photos}</section>
      <section class="public-detail-section"><h4>Habilidades consolidadas</h4><div class="public-radar-wrap">${radarSvg(radarScores, radarCriteria, true)}</div><div class="public-skill-list">${skills}</div></section>
      <section class="public-detail-section public-notes-section"><h4>Comentarios y notas</h4>${notes}</section>
    </div>
  </details>`;
}

async function loadPublicResults() {
  if (!supabase) return;
  state.publicLoading = true;
  state.publicError = "";
  renderPublicHome();
  const { data, error } = await supabase.rpc("get_public_festival_results");
  state.publicLoading = false;
  if (error) {
    console.error("No se pudieron cargar los resultados públicos:", error);
    state.publicError = "No se pudieron cargar los resultados. Comprueba que se haya aplicado la migración de resultados públicos en Supabase.";
    state.publicResults = null;
  } else {
    state.publicResults = data ?? { entries: [], criteria_count: 0 };
  }
  renderPublicHome();
}

function renderPublicHome() {
  if (!validConfig) {
    render();
    return;
  }
  const result = buildPublicStandings(state.publicResults);
  // Si hay varios empatados dentro de los tres primeros puestos, se muestran todos.
  const leaders = result.standings.filter((band) => band.rank <= 3);
  const podiumMarkup = leaders.length
    ? `<div class="public-podium-grid">${leaders.map((band) => {
        const medal = band.rank === 1 ? "🥇" : band.rank === 2 ? "🥈" : "🥉";
        const rankLabel = band.tied ? `Puesto ${band.rank} · EMPATE` : `${medal} Puesto ${band.rank}`;
        const cover = band.photoUrl
          ? `<img class="public-podium-cover" src="${esc(band.photoUrl)}" alt="Fotografía de ${esc(band.name)}" loading="lazy">`
          : `<div class="public-podium-cover public-photo-placeholder">♫</div>`;
        return `<article class="public-podium-card place-${Math.min(band.rank, 3)}">${cover}<div class="public-podium-medal">${medal}</div><div class="public-podium-rank">${rankLabel}</div><h3>${esc(band.name)}</h3><strong class="public-podium-score">${band.average.toFixed(2)} <small>/ 5</small></strong><span class="public-podium-judges">${band.jurorCount} ${band.jurorCount === 1 ? "jurado evaluó" : "jurados evaluaron"} esta banda</span>${band.aliases.length ? `<small class="public-aliases">También registrada como: ${band.aliases.map(esc).join(" · ")}</small>` : ""}${publicBandDetailsHtml(band)}</article>`;
      }).join("")}</div>`
    : `<div class="public-empty"><div class="public-empty-icon">♫</div><h2>Aún no hay resultados disponibles</h2><p>Cuando los jurados registren y completen sus evaluaciones, aquí aparecerá la clasificación consolidada del festival.</p></div>`;

  const rows = result.standings.map((band) => {
    const thumbnail = band.photoUrl
      ? `<img class="public-standing-thumb" src="${esc(band.photoUrl)}" alt="" loading="lazy">`
      : `<div class="public-standing-thumb public-photo-placeholder">♫</div>`;
    return `<div class="public-standing-item"><article class="public-standing-row">${thumbnail}<div class="public-standing-rank ${band.rank <= 3 ? `rank-${band.rank}` : ""}">${band.tied ? `⚖ ${band.rank}` : band.rank}</div><div class="public-standing-main"><strong>${esc(band.name)}</strong>${band.aliases.length ? `<small>Variantes: ${band.aliases.map(esc).join(" · ")}</small>` : ""}${band.autoMatched ? `<span class="public-match-tag">Nombres similares unificados</span>` : ""}</div><div class="public-standing-judges">${band.jurorCount} ${band.jurorCount === 1 ? "jurado" : "jurados"}</div><strong class="public-standing-score">${band.average.toFixed(2)} / 5 ${band.tied ? `<small>EMPATE</small>` : ""}</strong></article>${publicBandDetailsHtml(band)}</div>`;
  }).join("");

  const candidateMarkup = result.reviewCandidates.length
    ? `<section class="public-review-note"><strong>Posibles nombres similares para revisar</strong><p>Estos nombres se parecen, pero no se combinaron automáticamente porque la coincidencia no es suficientemente segura. Se mantienen separados para evitar unir bandas distintas.</p><ul>${result.reviewCandidates.map((pair) => `<li>${esc(pair.a)} <span>↔</span> ${esc(pair.b)}</li>`).join("")}</ul><small>Los casos dudosos se mantienen separados hasta verificar que se trata de la misma banda.</small></section>`
    : "";

  app.innerHTML = `<div class="public-shell">
    <header class="public-topbar"><div class="brand"><div class="brand-symbol">M</div><div class="brand-copy"><strong>FESTIVAL MARISTA</strong><span>Intercolegial</span></div></div><button class="public-login-button" data-action="open-login">Iniciar sesión para jurados <span>→</span></button></header>
    <main class="public-wrap">
      <section class="public-hero"><div class="public-kicker">COLEGIO MARISTA · FESTIVAL INTERCOLEGIAL</div><h1>El talento se encuentra en el escenario.</h1><p>Resultados generales · Evaluación consolidada de los jurados</p><div class="public-hero-meta"><span>✦ ${result.participatingJurors} ${result.participatingJurors === 1 ? "jurado participante" : "jurados participantes"}</span><span>♬ ${result.standings.length} ${result.standings.length === 1 ? "banda" : "bandas"} clasificadas</span></div></section>
      ${state.publicLoading ? `<div class="public-status">Cargando resultados del festival…</div>` : ""}
      ${state.publicError ? `<div class="public-error"><strong>No se pudieron cargar los resultados</strong><p>${esc(state.publicError)}</p><button class="secondary-button" data-action="refresh-public-results">Reintentar</button></div>` : ""}
      ${!state.publicError && !state.publicLoading ? `<section class="public-section"><div class="public-section-heading"><div><span>LOS GANADORES</span><h2>Podio general</h2></div><button class="public-refresh-button" data-action="refresh-public-results">↻ Actualizar</button></div>${podiumMarkup}</section>
      ${result.standings.length ? `<section class="public-section public-full-ranking"><div class="public-section-heading"><div><span>TODAS LAS BANDAS</span><h2>Clasificación completa</h2></div><small>Promedios consolidados y fichas públicas</small></div><div class="public-standing-list">${rows}</div></section>` : ""}
      ${candidateMarkup}
      ${result.incompleteCount > 0 ? `<p class="public-incomplete-note">${result.incompleteCount} ${result.incompleteCount === 1 ? "evaluación no participa" : "evaluaciones no participan"} en el cálculo porque todavía no tiene todos los criterios activos calificados.</p>` : ""}
      <p class="public-matching-note">Se muestran las fotografías, habilidades consolidadas y notas registradas por los jurados. Los nombres se normalizan para detectar variantes; las coincidencias dudosas permanecen separadas.</p></section>` : ""}
      <footer class="public-footer">Festival Intercolegial · Colegio Marista <span>Resultados públicos</span></footer>
    </main>
  </div>`;
}

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
      <button class="top-link small-hide" data-action="open-public-view">Resultados</button>
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
    <section class="login-panel"><button class="login-back-public" type="button" data-action="public-home">← Volver a resultados</button><form class="login-box" id="login-form">
      <h2>Acceso para jurados</h2><p>Ingresa con el usuario y contraseña asignados.</p>
      ${error ? `<div class="form-error">${esc(error)}</div>` : ""}
      <div class="field"><label for="login-username">Usuario</label><input id="login-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="24" placeholder="Tu usuario" data-autofocus></div>
      <div class="field"><label for="login-password">Contraseña</label><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Tu contraseña"></div>
      <button class="primary-button" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "Ingresando…" : "Ingresar al panel"} <span>→</span></button>
      <div class="subtle-note">El acceso no requiere correo electrónico ni registro público. Solicita tus credenciales al administrador del festival.</div>
    </form></section>
  </main>`;
}

function bandCard(band, index, groups = currentTieGroups()) {
  const rank = index + 1;
  const tie = tieGroupForBand(band, groups);
  const unresolvedTie = Boolean(tie && !tie.resolved);
  const medalClass = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
  const photo = band.photo_url ? `<img class="card-photo" src="${esc(band.photo_url)}" alt="Fotografía de ${esc(band.name)}" loading="lazy">` : `<div class="photo-placeholder">♫</div>`;
  const canEditPhoto = isJuror() ? `<button class="photo-edit" aria-label="Retomar fotografía de ${esc(band.name)}" title="Retomar fotografía" data-action="quick-retake" data-id="${band.id}">✎</button>` : "";
  const scoreMap = bandScores(band);
  const medal = tie && unresolvedTie
    ? `<span class="rank-medal rank-tie">⚖</span>`
    : rank <= 3 ? `<span class="rank-medal ${medalClass}">${rank}</span>` : "";
  const positionText = tie
    ? (tie.resolved ? `EMPATE · Puesto ${rank}` : `EMPATE · Puestos ${tie.startRank}–${tie.endRank}`)
    : (rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `Puesto ${rank}`);
  return `<article class="band-card" data-action="open-band" data-id="${band.id}" tabindex="0" role="button" aria-label="Ver detalles de ${esc(band.name)}">
    <div class="card-photo-wrap">${photo}${medal}${canEditPhoto}</div>
    <div class="card-body"><div class="card-title-row"><h3 class="card-title">${esc(band.name)}</h3><span class="card-average">${averageScore(band).toFixed(2)} / 5</span></div>
      ${tie ? `<span class="tie-tag">⚖ ${tie.resolved ? "EMPATE · ORDEN DEFINIDO" : "EMPATE DETECTADO"}</span>` : ""}
      ${radarSvg(scoreMap, activeCriteria())}
      <div class="card-foot"><span>${activeCriteria().length} criterios de habilidad</span><strong class="${tie ? "tie-foot-label" : ""}">${positionText}</strong></div>
    </div>
  </article>`;
}

function renderAdminDashboard() {
  const jurors = state.adminUsers.filter((user) => user.role === "juror");
  const cards = jurors.map((user) => {
    const bands = sortBandList(state.bands.filter((band) => band.created_by === user.id));
    const jurorTieGroups = buildTieGroups(bands);
    const leaders = bands.slice(0, 3);
    const preview = leaders.length
      ? `<div class="juror-preview-list">${leaders.map((band, index) => {
          const tie = tieGroupForBand(band, jurorTieGroups);
          return `<span class="juror-preview-chip"><b>${tie ? "⚖" : `${index + 1}.`}</b> ${esc(band.name)} <small>${averageScore(band).toFixed(2)}${tie ? " · EMPATE" : ""}</small></span>`;
        }).join("")}</div>`
      : `<div class="juror-preview-empty">Todavía no ha registrado bandas.</div>`;
    const tieSummary = jurorTieGroups.length
      ? `<div class="juror-tie-summary" role="note"><strong>⚖ ${jurorTieGroups.length === 1 ? "EMPATE DETECTADO" : `${jurorTieGroups.length} EMPATES DETECTADOS`}</strong><span>${jurorTieGroups.map((group) => `${group.bands.map((band) => esc(band.name)).join(" / ")} · ${group.average.toFixed(2)} / 5${group.resolved ? " · orden definido" : " · pendiente"}`).join("; ")}</span></div>`
      : "";
    return `<button class="juror-dashboard-card" type="button" data-action="select-juror" data-id="${user.id}">
      <div class="juror-dashboard-top"><span class="status ${user.is_active ? "active" : "inactive"}">${user.is_active ? "● Acceso habilitado" : "● Acceso deshabilitado"}</span><span class="juror-open-link">Ver evaluación →</span></div>
      <h2>${esc(user.username)}</h2>
      <p>${bands.length} ${bands.length === 1 ? "banda registrada" : "bandas registradas"}</p>
      ${tieSummary}
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
  const groups = buildTieGroups(bands);
  const juror = isAdmin() ? selectedJuror() : null;
  if (isAdmin() && !juror) {
    state.selectedJurorId = null;
    renderAdminDashboard();
    return;
  }
  const title = juror ? `Bandas de ${juror.username}` : "Mis bandas";
  const back = juror ? `<div class="backline"><button class="back-button" data-action="back-jurors">← Volver a todos los jurados</button></div>` : "";
  const cards = bands.length ? `<div class="band-grid">${bands.map((band, index) => bandCard(band, index, groups)).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">♫</div><h3>Aún no hay bandas registradas</h3><p>${juror ? `${esc(juror.username)} todavía no ha creado bandas.` : "Registra la primera banda para iniciar tu evaluación."}</p>${isJuror() ? `<button class="primary-button" data-action="new-band">＋ Crear primera banda</button>` : ""}</div>`;
  layout(`<main class="page-wrap">
    ${back}
    <section class="hero"><div><div class="eyebrow">${juror ? "Vista individual del jurado · Sólo lectura" : "Evaluación individual"}</div><h1>${esc(title)}</h1><p>${bands.length} ${bands.length === 1 ? "banda registrada" : "bandas registradas"} · Clasificación independiente por promedio</p></div>
      ${isJuror() ? `<button class="primary-button" data-action="new-band">＋ Crear banda</button>` : `<span class="step-pill">Vista de administración · Sólo lectura</span>`}
    </section>
    ${tieWarningsHtml(groups)}
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
  const tie = tieGroupForBand(band, buildTieGroups(currentBands));
  const rankLabel = tie
    ? (tie.resolved ? `Puesto ${rank} · Empate de promedio` : `Empate de promedio · Puestos ${tie.startRank}–${tie.endRank}`)
    : (rank <= 3 ? `Puesto ${rank} · ${["Primer lugar", "Segundo lugar", "Tercer lugar"][rank-1]}` : `Puesto ${rank} de ${currentBands.length}`);
  const scores = bandScores(band);
  const rows = activeCriteria().map((criterion) => `<div class="score-row"><strong>${esc(criterion.label)}</strong><span class="stars">${"★".repeat(scores[criterion.id] || 0)}${"☆".repeat(5 - (scores[criterion.id] || 0))} <b style="color:#34465b;font-size:12px;letter-spacing:0">${scores[criterion.id] || 0}/5</b></span></div>`).join("");
  const detailBackLabel = isAdmin() ? `← Volver a bandas de ${selectedJuror()?.username ?? "jurado"}` : "← Volver a mis bandas";
  layout(`<main class="page-wrap"><div class="backline"><button class="back-button" data-action="back-home">${esc(detailBackLabel)}</button></div>
    <section class="content-card"><div class="detail-header">
      <div>${band.photo_url ? `<img class="detail-photo" src="${esc(band.photo_url)}" alt="Fotografía de ${esc(band.name)}">` : `<div class="detail-photo photo-placeholder">♫</div>`}</div>
      <div><div class="detail-label">${rankLabel}</div><h1 class="detail-title">${esc(band.name)}</h1><p class="muted" style="font-size:13px;margin:0 0 14px">Calificación promedio: <strong style="color:#9a711e">${averageScore(band).toFixed(2)} / 5</strong></p>${tie ? `<div class="tie-inline-note">⚖ Esta banda comparte exactamente el mismo promedio con ${tie.bands.length - 1} ${tie.bands.length - 1 === 1 ? "banda" : "bandas"}. ${tie.resolved ? "El orden de presentación fue decidido por el jurado; las calificaciones siguen empatadas." : "El orden de presentación todavía está pendiente de decisión del jurado."}</div>` : ""}
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
      tie_break: "Resolvió un empate",
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
    } else if (log.action === "tie_break") {
      const ordered = (log.details?.ordered_bands ?? []).map((band) => `${band.position}. ${band.name}`).join(" → ");
      details = `Promedio compartido: ${Number(log.details?.average ?? 0).toFixed(2)} / 5. Orden decidido por el jurado: ${ordered}. Las calificaciones permanecen empatadas.`;
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
  if (m.type === "tie-break") {
    const group = currentTieGroups().find((item) => item.scoreTotal === Number(m.scoreTotal));
    const allowedIds = new Set((group?.bands ?? []).map((band) => band.id));
    const ids = (m.bandIds ?? []).filter((id) => allowedIds.has(id));
    const rows = ids.map((id, index) => {
      const band = group.bands.find((item) => item.id === id);
      return `<li class="tie-order-row"><span class="tie-order-position">${index + 1}</span><span class="tie-order-name">${esc(band?.name ?? "Banda")}</span><div class="tie-order-controls"><button class="small-button" data-action="tie-move" data-id="${id}" data-direction="-1" aria-label="Subir" ${index === 0 ? "disabled" : ""}>↑</button><button class="small-button" data-action="tie-move" data-id="${id}" data-direction="1" aria-label="Bajar" ${index === ids.length - 1 ? "disabled" : ""}>↓</button></div></li>`;
    }).join("");
    body = group && ids.length === group.bands.length
      ? `<div class="tie-modal-explainer"><strong>Las ${group.bands.length} bandas tienen el mismo promedio: ${group.average.toFixed(2)} / 5.</strong><p>Ordena las bandas con las flechas. Esta decisión sólo define la posición de presentación; no cambia las puntuaciones y el sistema seguirá mostrando el empate.</p></div><ol class="tie-order-list">${rows}</ol><div class="button-row"><button class="primary-button" data-action="save-tie-break">Guardar orden decidido</button><button class="secondary-button" data-action="close-modal">Cancelar</button></div>`
      : `<div class="form-error">El grupo de empate cambió desde que abriste esta ventana. Cierra y actualiza la página.</div><div class="button-row"><button class="secondary-button" data-action="close-modal">Cerrar</button></div>`;
  }
  if (m.type === "new-user") body = `<form id="modal-form"><div class="field"><label for="modal-username">Nombre de usuario</label><input id="modal-username" name="username" minlength="3" maxlength="24" pattern="[a-zA-Z0-9._-]{3,24}" autocapitalize="none" required placeholder="ej. jurado01"></div><div class="field"><label for="modal-password">Contraseña inicial</label><input id="modal-password" name="password" type="password" minlength="10" required placeholder="Mínimo 10 caracteres"></div><div class="button-row"><button class="primary-button" type="submit">Crear cuenta</button><button class="secondary-button" type="button" data-action="close-modal">Cancelar</button></div></form>`;
  if (m.type === "password") body = `<form id="modal-form"><p class="muted" style="font-size:13px">Establece una nueva contraseña para <strong>${esc(m.username)}</strong>. La persona deberá utilizarla en su próximo inicio de sesión.</p><div class="field"><label for="modal-password">Nueva contraseña</label><input id="modal-password" name="password" type="password" minlength="10" required placeholder="Mínimo 10 caracteres"></div><div class="button-row"><button class="primary-button" type="submit">Actualizar contraseña</button><button class="secondary-button" type="button" data-action="close-modal">Cancelar</button></div></form>`;
  if (m.type === "confirm-access") body = `<p class="muted" style="font-size:13px">${m.active ? "¿Deseas deshabilitar" : "¿Deseas habilitar"} el acceso de <strong>${esc(m.username)}</strong>?</p><div class="button-row"><button class="primary-button" data-action="confirm-user-access">${m.active ? "Deshabilitar acceso" : "Habilitar acceso"}</button><button class="secondary-button" data-action="close-modal">Cancelar</button></div>`;
  if (m.type === "confirm-delete-user") body = `<div class="confirm-panel"><h3>Eliminar cuenta</h3><p>Se eliminará la cuenta de ${esc(m.username)}. Esta operación sólo está permitida cuando no tiene bandas registradas. Para conservar evaluaciones existentes, deshabilita el acceso en lugar de eliminar la cuenta.</p></div><div class="button-row"><button class="danger-button" data-action="confirm-delete-user">Eliminar cuenta</button><button class="secondary-button" data-action="close-modal">Cancelar</button></div>`;
  const modalTitle = m.type === "tie-break" ? "Resolver empate" : m.type === "new-user" ? "Crear usuario" : m.type === "password" ? "Cambiar contraseña" : m.type === "confirm-access" ? "Administrar acceso" : "Confirmar eliminación";
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal ${m.type === "tie-break" ? "tie-break-modal" : ""}" style="max-width:${m.type === "tie-break" ? "560px" : "480px"}"><div class="modal-head"><h2>${modalTitle}</h2><button class="modal-close" data-action="close-modal">×</button></div>${body}</section></div>`);
}

function renderAward() {
  app.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
  const bands = sortedBands().slice(0, 3);
  const third = bands[2], second = bands[1], first = bands[0];
  const juryLabel = isAdmin() ? selectedJuror()?.username : state.profile.username;
  const podiumHasTie = currentTieGroups().some((group) => group.resolved && group.startRank <= 3);
  const podiumTieNote = podiumHasTie ? `<div class="podium-tie-note">⚖ Hay bandas con el mismo promedio. El podio respeta el orden decidido por el jurado, pero las calificaciones siguen empatadas.</div>` : "";
  const podiumSlot = (band, place, className, emoji) => `<div class="podium-slot ${className}" id="podium-${place}"><img class="podium-photo" src="${esc(band?.photo_url ?? "")}" alt="" onerror="this.style.opacity='0'"><div class="podium-name">${esc(band?.name ?? "Por definir")}</div><div class="podium-block">${emoji}</div></div>`;
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal podium-modal"><div class="award-subtitle">Festival Intercolegial · ${esc(juryLabel ? `Evaluación de ${juryLabel}` : "Resultados")}</div><h2>¡Llegó el momento de premiar!</h2><p>El podio de este jurado se revela de menor a mayor posición.</p><div class="podium-stage">${podiumSlot(second, 2, "second", "2.º")}${podiumSlot(first, 1, "first", "1.º")}${podiumSlot(third, 3, "third", "3.º")}</div>${podiumTieNote}<div class="spin-note" id="award-caption">Preparando resultados…</div><div class="podium-actions"><button class="primary-button" data-action="close-award" disabled id="award-close">Cerrar ceremonia</button></div></section></div>`);
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
  if (!state.profile) {
    if (state.screen === "login") renderLogin();
    else renderPublicHome();
    return;
  }
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
    supabase.from("bands").select("id,name,photo_path,notes,created_by,created_at,updated_at,tie_break_order,band_scores(criterion_id,score)").order("created_at", { ascending: false }),
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
  state.profile = null; state.session = null; state.screen = "public";
  await loadPublicResults();
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

function openTieBreak(scoreTotalValue) {
  if (!isJuror()) {
    showToast("Sólo el jurado puede decidir el orden de sus propios empates.", "warning");
    return;
  }
  const group = currentTieGroups().find((item) => item.scoreTotal === Number(scoreTotalValue));
  if (!group || group.bands.length < 2) {
    showToast("El empate ya no existe. Actualiza la clasificación.", "warning");
    return;
  }
  state.modal = { type: "tie-break", scoreTotal: group.scoreTotal, bandIds: group.bands.map((band) => band.id) };
  renderModal();
}

async function saveTieBreak() {
  const modal = state.modal;
  if (!isJuror() || modal?.type !== "tie-break") return;
  const currentGroup = currentTieGroups().find((item) => item.scoreTotal === Number(modal.scoreTotal));
  if (!currentGroup || currentGroup.bands.length !== modal.bandIds.length ||
      !currentGroup.bands.every((band) => modal.bandIds.includes(band.id))) {
    showToast("El grupo de empate cambió. Actualiza la página y vuelve a intentarlo.", "error");
    return;
  }
  const saveButton = document.querySelector('[data-action="save-tie-break"]');
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Guardando decisión…"; }
  try {
    const { error } = await supabase.rpc("save_tie_break_order", { p_band_ids: modal.bandIds });
    if (error) throw error;
    state.modal = null;
    await refreshData();
    await fetchAuditLogs();
    render();
    showToast("Orden de desempate guardado. Las bandas siguen empatadas en promedio.");
  } catch (error) {
    showToast(error.message ?? "No se pudo guardar el desempate.", "error", 6000);
    if (state.modal?.type === "tie-break") renderModal();
  }
}

async function handleClick(event) {
  const actionNode = event.target.closest("[data-action]");
  if (!actionNode) return;
  const action = actionNode.dataset.action;
  const id = actionNode.dataset.id;
  if (action === "open-login") { state.screen = "login"; renderLogin(); }
  else if (action === "public-home") {
    if (state.profile) await logout();
    else { state.screen = "public"; await loadPublicResults(); }
  }
  else if (action === "open-public-view") await logout();
  else if (action === "refresh-public-results") await loadPublicResults();
  else if (action === "new-band") openNewWizard();
  else if (action === "open-band") { if (event.target.closest(".photo-edit")) return; if (!sortedBands().some((band) => band.id === id)) return; state.selectedBandId = id; state.screen = "detail"; render(); }
  else if (action === "back-home") { resetWizard(); state.modal = null; state.screen = "home"; render(); }
  else if (action === "back-jurors") { state.selectedJurorId = null; state.selectedBandId = null; state.screen = "home"; render(); }
  else if (action === "select-juror") { if (!isAdmin() || !state.adminUsers.some((user) => user.id === id)) return; state.selectedJurorId = id; state.selectedBandId = null; state.screen = "home"; render(); }
  else if (action === "refresh-dashboard") { try { await refreshData(); await fetchAdminUsers(); renderHome(); showToast("Evaluaciones actualizadas."); } catch (error) { showToast(error.message, "error"); } }
  else if (action === "resolve-tie") openTieBreak(actionNode.dataset.scoreTotal);
  else if (action === "tie-move") {
    if (state.modal?.type !== "tie-break") return;
    const from = state.modal.bandIds.indexOf(id);
    const to = from + Number(actionNode.dataset.direction);
    if (from < 0 || to < 0 || to >= state.modal.bandIds.length) return;
    const reordered = [...state.modal.bandIds];
    [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
    state.modal.bandIds = reordered;
    renderModal();
  }
  else if (action === "save-tie-break") saveTieBreak();
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
  else if (action === "award") {
    if (!sortedBands().length) { showToast("Todavía no hay bandas para premiar.", "warning"); return; }
    const pendingTopTie = currentTieGroups().find((group) => !group.resolved && group.startRank <= 3);
    if (pendingTopTie) {
      if (isJuror()) openTieBreak(pendingTopTie.scoreTotal);
      else showToast("Hay un empate pendiente que el jurado debe resolver antes de premiar.", "warning", 6000);
      return;
    }
    renderAward();
  }
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
    else { state.screen = "public"; await loadPublicResults(); }
  } else {
    state.screen = "public";
    await loadPublicResults();
  }
  supabase.auth.onAuthStateChange((event, sessionNow) => {
    if (event === "SIGNED_OUT") {
      state.session = null; state.profile = null; state.screen = "public";
      loadPublicResults().catch((error) => console.error("No se pudieron cargar resultados públicos:", error));
    }
    if (event === "TOKEN_REFRESHED" && sessionNow) state.session = sessionNow;
  });
}

init().catch((error) => {
  console.error(error);
  state.screen = "public";
  state.publicError = "No se pudo iniciar la aplicación. Verifica la conexión con Supabase y vuelve a cargar.";
  renderPublicHome();
});
