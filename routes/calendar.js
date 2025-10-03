const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");

// Cache en memoria (se mantiene como en tu versión)
const roomCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minuto

// --- Lock simple in-memory para serializar llamadas al servicio externo ---
let externalLock = false;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function acquireLock() {
  const POLL = 100; // ms
  while (externalLock) {
    await sleep(POLL);
  }
  externalLock = true;
}
function releaseLock() {
  externalLock = false;
}

/**
 * sendToVideochatWithRetry
 * - Envía un único POST con varias sesiones al servicio de videollamadas.
 * - Respeta Retry-After si viene en headers.
 * - Reintentos exponenciales con jitter para 429.
 */
async function sendToVideochatWithRetry(url, payload, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelay = options.baseDelay ?? 500; // ms
  let attempt = 0;
  const headers = options.headers || {};

  while (attempt <= maxRetries) {
    try {
      const resp = await axios.post(url, payload, {
        headers,
        timeout: options.timeout ?? 15000,
      });
      return resp.data;
    } catch (err) {
      attempt++;
      const status = err?.response?.status;

      // Si no es 429 -> re-lanzamos el error inmediatamente
      if (status !== 429) {
        throw err;
      }

      // Manejar Retry-After si viene
      const retryAfterRaw = err.response.headers["retry-after"];
      let waitFor = null;

      if (retryAfterRaw) {
        const parsed = Number(retryAfterRaw);
        if (!Number.isNaN(parsed)) {
          waitFor = parsed * 1000;
        } else {
          const retryDate = Date.parse(retryAfterRaw);
          if (!Number.isNaN(retryDate)) {
            waitFor = Math.max(0, retryDate - Date.now());
          }
        }
      }

      // si no hay Retry-After -> backoff exponencial con jitter
      if (waitFor === null) {
        const jitter = Math.floor(Math.random() * 200);
        waitFor = Math.min(60000, baseDelay * Math.pow(2, attempt - 1) + jitter);
      }

      console.warn(`Videochat 429 (attempt ${attempt}/${maxRetries}). Esperando ${waitFor} ms antes de retry.`);
      await sleep(waitFor);

      if (attempt > maxRetries) {
        const message = `Máximo reintentos alcanzado (${maxRetries}) al llamar a videochat`;
        const e = new Error(message);
        e.original = err;
        throw e;
      }
    }
  }
}

// helper: valida acceso del usuario al curso
async function validateUserCourseAccess(userId, courseId) {
  try {
    const result = await db.execute(
      `SELECT 1 FROM cursos_estudiante WHERE idUsuario = ? AND idCurso = ? 
       UNION 
       SELECT 1 FROM cursos WHERE id = ? AND admin = ?`,
      [userId, courseId, courseId, userId]
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error("Error validando acceso al curso:", err);
    return false;
  }
}

router.get("/courses/:selectedCourseId/dates", async (req, res) => {
  const { selectedCourseId } = req.params;

  try {
    const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [
      selectedCourseId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Curso no existe" });
    }

    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

    const fechas = await db.execute(
      `SELECT
         f.id, 
         f.inicio, 
         f.final, 
         f.tipo_encuentro AS tipo,
         f.titulo, 
         f.link_mot AS join_link,
         g.link AS recording_url,
         f.room_id
       FROM fechas f
       LEFT JOIN grabaciones g ON g.idFecha = f.id
       WHERE f.idCurso = ? AND f.final >= ?
       ORDER BY f.inicio ASC`,
      [selectedCourseId, limiteInferior]
    );

    const fechasFormateadas = fechas.rows.map((fecha) => ({
      ...fecha,
      join_link: fecha.room_id
        ? `/courses/${selectedCourseId}/join/${fecha.room_id}`
        : null,
    }));

    return res.json(fechasFormateadas);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

// Proxy de acceso seguro (sin cambios funcionales)
router.get("/courses/:courseId/join/:roomId", async (req, res) => {
  const { courseId, roomId } = req.params;

  const token =
    req.query.auth ||
    req.headers.authorization?.split(" ")[1] ||
    req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const userPayload = jwt.verify(token, JWT_SECRET);
    const hasAccess = await validateUserCourseAccess(userPayload.id, courseId);
    if (!hasAccess) {
      return res.status(403).json({ error: "Sin acceso al curso" });
    }

    const roomResult = await db.execute(
      `SELECT room_id, link_mot FROM fechas WHERE room_id = ? AND idCurso = ?`,
      [roomId, courseId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: "Sala no encontrada" });
    }

    const roomData = roomResult.rows[0];
    let roomToken;
    try {
      const urlParts = roomData.link_mot?.split("?");
      if (urlParts?.length > 1) {
        const urlParams = new URLSearchParams(urlParts[1]);
        roomToken = urlParams.get("token");
      }
    } catch (_) {}

    if (!roomToken) {
      roomToken = jwt.sign({ room_id: roomId, course_id: courseId }, JWT_SECRET);
    }

    const redirectUrl = `${process.env.VIDEOCHAT_URL}/join?token=${roomToken}&user_token=${encodeURIComponent(
      token
    )}`;
    return res.redirect(redirectUrl);
  } catch (err) {
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Token inválido" });
    }
    console.error("Error en proxy:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

/**
 * POST /courses/:selectedCourseId/dates
 * - Recibe un array "sessions" (todas las sesiones seleccionadas).
 * - Reduce llamadas externas: primero reutiliza salas existentes (si las hay),
 *   solo envía UN request al servicio de videollamadas para las sesiones que NO tienen sala.
 * - Inserta/actualiza todas las fechas en DB.
 */
router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;

  const token = req.headers.authorization?.split(" ")[1];
  let userPayload;
  try {
    userPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const isOwner =
      (
        await db.execute(
          `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
          [selectedCourseId, userPayload.id]
        )
      ).rows.length > 0;

    if (!isOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // Validar y normalizar sesiones entrantes
    const normalized = sessions
      .map((s) => {
        const timezone = s.timezone || "America/Bogota";
        const startUTC = DateTime.fromISO(s.inicio, { zone: timezone }).toUTC();
        const endUTC = DateTime.fromISO(s.final, { zone: timezone }).toUTC();
        if (!startUTC.isValid || !endUTC.isValid || endUTC <= startUTC) {
          return null;
        }
        const localDate = DateTime.fromISO(s.inicio, { zone: timezone }).toISODate();
        return {
          ...s,
          inicio: startUTC.toISO(),
          final: endUTC.toISO(),
          timezone,
          localDate,
        };
      })
      .filter(Boolean);

    if (normalized.length === 0) {
      return res.status(400).json({ error: "No hay sesiones válidas" });
    }

    // 1) Buscar en DB las fechas/room_id existentes para estas fechas (consulta única)
    const distinctDates = [...new Set(normalized.map((n) => n.localDate))];
    const placeholders = distinctDates.map(() => "?").join(",");
    const existingQuery = await db.execute(
      `SELECT room_id, DATE(start_time) as session_date FROM llamadas_mot WHERE course_id = ? AND DATE(start_time) IN (${placeholders})`,
      [selectedCourseId, ...distinctDates]
    );

    const existingMap = new Map(); // session_date -> room_id
    for (const row of existingQuery.rows) {
      existingMap.set(row.session_date, row.room_id);
    }

    // 2) Separar sesiones en:
    //    - reuseSessions: ya tienen room_id en DB -> no necesitamos llamar a videochat para crear.
    //    - toCreateSessions: no tienen room_id -> enviaremos UN request para todas.
    const reuseSessions = [];
    const toCreateSessions = [];

    for (const s of normalized) {
      const existingRoom = existingMap.get(s.localDate) || s.room_id || null;
      if (existingRoom) {
        reuseSessions.push({ ...s, room_id: existingRoom });
      } else {
        // si el frontend envio room_id (actualización), respétala
        if (s.room_id) {
          reuseSessions.push(s);
        } else {
          // prepare payload for remote creation (keep original ISO datetimes + timezone)
          toCreateSessions.push({
            inicio: s.inicio,
            final: s.final,
            titulo: s.titulo || "Clase",
            type: s.type || "Clase en vivo",
            timezone: s.timezone,
            // localDate included to map back later
            __localDate: s.localDate,
          });
        }
      }
    }

    const results = [];

    // 3) Para sesiones que ya tienen room -> insertar/actualizar DB local directamente
    for (const s of reuseSessions) {
      const localDate = s.localDate;
      const startUTC = DateTime.fromISO(s.inicio, { zone: "utc" }).toISO();
      const endUTC = DateTime.fromISO(s.final, { zone: "utc" }).toISO();
      const title = s.titulo || "Clase";
      const type = s.type || "Clase en vivo";
      const room_id = s.room_id || null;
      const link = room_id ? `/join?token=${jwt.sign({ room_id, course_id: selectedCourseId }, JWT_SECRET)}` : null;

      await db.execute(
        `INSERT INTO fechas (
          inicio, final, tipo_encuentro, idCurso, titulo, link_mot, fecha_date, room_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idCurso, fecha_date) DO UPDATE SET
          inicio = excluded.inicio,
          final = excluded.final,
          titulo = excluded.titulo,
          tipo_encuentro = excluded.tipo_encuentro,
          link_mot = COALESCE(excluded.link_mot, fechas.link_mot),
          room_id = COALESCE(excluded.room_id, fechas.room_id)`,
        [startUTC, endUTC, type, selectedCourseId, title, link, localDate, room_id]
      );

      results.push({
        inicio: s.inicio,
        final: s.final,
        titulo: title,
        type,
        timezone: s.timezone,
        room_id,
        link,
        status: "reused",
      });
    }

    // 4) Para sesiones que necesitan creación en el servicio externo -> 1 sola llamada (si hay)
    if (toCreateSessions.length > 0) {
      const { VIDEOCHAT_URL } = process.env;
      const videoUrl = `${VIDEOCHAT_URL}/api/calls`;

      // JWT para el servicio de videochat (igual que antes)
      const serviceToken = jwt.sign({ course_id: selectedCourseId }, JWT_SECRET);
      const headers = { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" };

      try {
        await acquireLock();
        const data = await sendToVideochatWithRetry(
          videoUrl,
          { course_id: selectedCourseId, sessions: toCreateSessions },
          { headers, maxRetries: 5, baseDelay: 500, timeout: 20000 }
        );

        // data.results expected array aligned with toCreateSessions (generateRooms devuelve details)
        for (const r of (data.results || [])) {
          // map back to localDate (generateRooms returns inicio with original ISO)
          const localDate = DateTime.fromISO(r.inicio, { zone: r.timezone || "America/Bogota" }).toISODate();
          const startUTC = DateTime.fromISO(r.inicio, { zone: "utc" }).toISO();
          const endUTC = DateTime.fromISO(r.final, { zone: "utc" }).toISO();
          const title = r.titulo || "Clase";
          const type = r.type || "Clase en vivo";
          const room_id = r.room_id || null;
          const link = r.link || (room_id ? `/join?token=${jwt.sign({ room_id, course_id: selectedCourseId }, JWT_SECRET)}` : null);

          await db.execute(
            `INSERT INTO fechas (
              inicio, final, tipo_encuentro, idCurso, titulo, link_mot, fecha_date, room_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idCurso, fecha_date) DO UPDATE SET
              inicio = excluded.inicio,
              final = excluded.final,
              titulo = excluded.titulo,
              tipo_encuentro = excluded.tipo_encuentro,
              link_mot = COALESCE(excluded.link_mot, fechas.link_mot),
              room_id = COALESCE(excluded.room_id, fechas.room_id)`,
            [startUTC, endUTC, type, selectedCourseId, title, link, localDate, room_id]
          );

          results.push({
            inicio: r.inicio,
            final: r.final,
            titulo: title,
            type,
            timezone: r.timezone,
            room_id,
            link,
            status: r.status || "created",
          });
        }
      } finally {
        releaseLock();
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error("Error crítico:", err);
    return res.status(500).json({ error: "Error al procesar solicitud" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of roomCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      roomCache.delete(key);
    }
  }
}, CACHE_TTL);

module.exports = router;
