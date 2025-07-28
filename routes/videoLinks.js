const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../db');
const { getAdminDriveClient } = require('../driveUtils');
const JWT_SECRET = process.env.JWT_SECRET || 'clave_super_segura';

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
    userPayload = jwt.verify(userJwt, JWT_SECRET); // token del usuario que se conecta
  } catch (err) {
    return res.status(401).json({ error: 'Usuario no autenticado' });
  }

  const userEmail = userPayload.email;

  try {
    // Obtener curso asociado y fechas programadas
    db.get(`SELECT * FROM fechas WHERE link_mot = ?`, [roomId], async (err, fecha) => {
      if (err || !fecha) return res.status(404).json({ error: 'Sala no encontrada' });

      const now = new Date();
      const inicio = new Date(fecha.inicio);
      const final = new Date(fecha.final);

      if (now < inicio || now > final) {
        return res.status(403).json({ error: 'Videollamada fuera de horario permitido' });
      }

      // Validar si el usuario está inscrito al curso
      db.get(
        `SELECT usuarios.email FROM usuarios
         JOIN cursos_estudiante ON cursos_estudiante.idUsuario = usuarios.id
         WHERE usuarios.email = ? AND cursos_estudiante.idCurso = ?`,
        [userEmail, fecha.idCurso],
        (err, user) => {
          if (err || !user) return res.status(403).json({ error: 'Acceso no autorizado al curso' });

          return res.json({
            roomId,
            courseId: fecha.idCurso,
            userEmail,
            startTime: fecha.inicio,
            endTime: fecha.final,
            allowedEmails: [userEmail]
          });
        }
      );
    });
  } catch (err) {
    console.error('Error interno:', err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});


// router.get("/api/google-drive-folder/:adminUserName", (req, res) => {
//   const { adminUserName } = req.params
//   const folderUser = db.execute(
//     "SELECT google_drive_folder_id FROM usuarios WHERE nombre = ?",[ adminUserName ]
//   )
//   folderUser.then((result) => {
//     if (result.length > 0) {
//       res.json({ folderId: result[0].google_drive_folder_id });
//     } else {
//       const folder = getAdminDriveClient(adminUserName);
//       folder.then((driveFolder) => {
//         if (driveFolder) {
//           res.json({ folderId: driveFolder.id });
//         } else {
//           res.status(404).json({ error: 'Carpeta no encontrada en Google Drive' });
//         }
//       });
//     }
//   }).catch((err) => {
//     console.error('Error al obtener la carpeta de Google Drive:', err);
//     res.status(500).json({ error: 'Error en el servidor' });
//   });
// })

module.exports = router;
