const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../db');
const JWT_SECRET = process.env.JWT_SECRET || 'clave_super_segura';

// Nueva ruta para validar acceso a cursos
router.get('/api/validate-course-access/:userId/:courseId', async (req, res) => {
  const { userId, courseId } = req.params;

  try {
    // Verificar si el usuario es dueño del curso
    const isOwner = await db.execute(
      `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
      [courseId, userId]
    );

    if (isOwner.rows.length > 0) {
      return res.json({ allowed: true });
    }

    // Verificar si el usuario está inscrito en el curso
    const isStudent = await db.execute(
      `SELECT 1 FROM cursos_estudiante 
       WHERE idCurso = ? AND idUsuario = ?`,
      [courseId, userId]
    );

    return res.json({ allowed: isStudent.rows.length > 0 });
  } catch (err) {
    console.error('Error validando acceso al curso:', err);
    return res.status(500).json({ allowed: false });
  }
});

router.get('/api/video-links/:token', async (req, res) => {
  const { token } = req.params;
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: 'Token de usuario faltante' });

  const userJwt = authHeader.split(' ')[1];

  let decodedToken;
  try {
    decodedToken = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const { room_id: roomId, course_id: courseId } = decodedToken;

  let userPayload;
  try {
    userPayload = jwt.verify(userJwt, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Usuario no autenticado' });
  }

  try {
    // Buscar sala usando room_id en lugar de link_mot
    const fecha = await db.execute(
      `SELECT * FROM fechas WHERE room_id = ?`,
      [roomId]
    );

    if (!fecha.rows || fecha.rows.length === 0) {
      return res.status(404).json({ error: 'Sala no encontrada' });
    }

    const sessionData = fecha.rows[0];
    const now = new Date();
    const inicio = new Date(sessionData.inicio);
    const final = new Date(sessionData.final);

    // Validar horario de la sesión
    if (now < inicio) {
      return res.status(403).json({ error: 'La sesión aún no ha comenzado' });
    }

    if (now > final) {
      return res.status(403).json({ error: 'La sesión ha finalizado' });
    }

    // Validar acceso al curso
    const accessCheck = await db.execute(
      `SELECT 1 FROM cursos c
       LEFT JOIN cursos_estudiante ce ON ce.idCurso = c.id AND ce.idUsuario = ?
       WHERE c.id = ? AND (c.admin = ? OR ce.idUsuario IS NOT NULL)`,
      [userPayload.id, sessionData.idCurso, userPayload.id]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'No tienes acceso a este curso' });
    }

    return res.json({
      roomId,
      courseId: sessionData.idCurso,
      userEmail: userPayload.email,
      startTime: sessionData.inicio,
      endTime: sessionData.final
    });

  } catch (err) {
    console.error('Error interno:', err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

module.exports = router;