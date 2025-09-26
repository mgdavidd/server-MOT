module.exports = (httpServer) => {
  const { Server } = require('socket.io');
  const db = require('../db');

  const io = new Server(httpServer, {
    cors: {
      origin: ["https://front-mot.onrender.com", "http://localhost:5174"],
      methods: ["GET", "POST"],
      credentials: true,
      transports: ['websocket', 'polling']
    },
    allowEIO3: true
  });

  io.on("connection", (socket) => {

    // Autenticación del socket
    socket.on("authenticate", async ({ userId, userName, userPhoto }) => {
      try {
        const user = await db.execute(
          "SELECT id, nombre, fotoPerfil, rol FROM usuarios WHERE id = ?",
          [userId]
        );

        if (user.rows.length === 0) {
          throw new Error("Usuario no encontrado");
        }

        socket.userData = user.rows[0];
      } catch (err) {
        console.error("Error de autenticación:", err);
        socket.emit("authentication_error", err.message);
      }
    });

    // Chat Privado
    socket.on("join_private_chat", async ({ userId, otherUserId }) => {
      // Validación crítica
      if (userId === otherUserId) {
        console.error("Error: No se puede chatear consigo mismo");
        return;
      }

      // Sala siempre ordenada para evitar duplicados
      const [id1, id2] = [userId, otherUserId].sort();
      const roomId = `private_${id1}_${id2}`;

      socket.join(roomId);

      try {
        // Obtener o crear conversación
        const convResult = await db.execute(
          `SELECT c.id FROM conversaciones_privadas c
           JOIN participantes_conversacion p1 ON p1.conversacion_id = c.id
           JOIN participantes_conversacion p2 ON p2.conversacion_id = c.id
           WHERE p1.usuario_id = ? AND p2.usuario_id = ?`,
          [id1, id2]
        );

        let conversacionId;
        if (convResult.rows.length > 0) {
          conversacionId = convResult.rows[0].id;
        } else {
          const newConv = await db.execute(
            "INSERT INTO conversaciones_privadas DEFAULT VALUES RETURNING id"
          );
          conversacionId = newConv.rows[0].id;
          await db.execute(
            `INSERT INTO participantes_conversacion (conversacion_id, usuario_id)
             VALUES (?, ?), (?, ?)`,
            [conversacionId, id1, conversacionId, id2]
          );
        }

        // Obtener historial
        const result = await db.execute(
          `SELECT mp.*, u.nombre, u.fotoPerfil, u.rol as rol_usuario
           FROM mensajes_privados mp
           JOIN usuarios u ON u.id = mp.remitente_id
           WHERE mp.conversacion_id = ?
           ORDER BY mp.fecha_envio ASC`,
          [conversacionId]
        );

        socket.emit("private_chat_history", result.rows);
      } catch (err) {
        console.error("Error en join_private_chat:", err);
        socket.emit("chat_error", "Error al cargar el chat");
      }
    });

    socket.on("send_private_message", async ({ senderId, receiverId, message }) => {
      // Validación crítica
      if (senderId === receiverId) {
        console.error("Error: senderId === receiverId");
        return;
      }

      const [id1, id2] = [senderId, receiverId].sort();
      const roomId = `private_${id1}_${id2}`;

      try {
        // Obtener conversación
        const convResult = await db.execute(
          `SELECT c.id FROM conversaciones_privadas c
           JOIN participantes_conversacion p1 ON p1.conversacion_id = c.id
           JOIN participantes_conversacion p2 ON p2.conversacion_id = c.id
           WHERE p1.usuario_id = ? AND p2.usuario_id = ?`,
          [id1, id2]
        );

        if (convResult.rows.length === 0) {
          throw new Error("Conversación no encontrada");
        }

        const conversacionId = convResult.rows[0].id;

        // Guardar mensaje
        const msgResult = await db.execute(
          `INSERT INTO mensajes_privados 
           (conversacion_id, remitente_id, mensaje)
           VALUES (?, ?, ?)
           RETURNING *`,
          [conversacionId, senderId, message]
        );

        // Obtener datos del remitente
        const userResult = await db.execute(
          "SELECT nombre, fotoPerfil, rol FROM usuarios WHERE id = ?",
          [senderId]
        );

        const messageData = {
          ...msgResult.rows[0],
          nombre: userResult.rows[0].nombre,
          fotoPerfil: userResult.rows[0].fotoPerfil,
          rol_usuario: userResult.rows[0].rol
        };

        io.to(roomId).emit("new_private_message", messageData);
      } catch (err) {
        console.error("Error en send_private_message:", err);
        socket.emit("message_error", "Error al enviar mensaje");
      }
    });

    // Chat de Curso
    socket.on("join_course_chat", (courseId) => {
      socket.join(`course_${courseId}`);
    });

    socket.on("course_message", async ({ courseId, userId, message }) => {
      try {
        // FIX: Usar CURRENT_TIMESTAMP para la fecha
        const result = await db.execute(
          `INSERT INTO mensajes_curso 
           (curso_id, usuario_id, rol_usuario, mensaje, fecha_envio)
           VALUES (?, ?, (SELECT rol FROM usuarios WHERE id = ?), ?, CURRENT_TIMESTAMP)
           RETURNING *`,
          [courseId, userId, userId, message]
        );

        const userResult = await db.execute(
          "SELECT nombre, fotoPerfil, rol FROM usuarios WHERE id = ?",
          [userId]
        );

        const messageData = {
          ...result.rows[0],
          nombre: userResult.rows[0].nombre,
          fotoPerfil: userResult.rows[0].fotoPerfil,
          rol_usuario: userResult.rows[0].rol
        };

        io.to(`course_${courseId}`).emit("course_message", messageData);
      } catch (err) {
        console.error("Error en course_message:", err);
        // Agregar manejo de error para el cliente
        socket.emit("course_message_error", "Error al enviar mensaje al curso");
      }
    });
  });
};