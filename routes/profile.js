const express = require("express");
const router = express.Router();
const db = require("../db");

router.put("/edit-profile/:id", async (req, res) => {
  const { id } = req.params;
  const { nombre_usuario, color_perfil, area, fotoPerfil } = req.body;

  try {
    const result = await db.execute(
      `UPDATE usuarios SET nombre_usuario = ?, color_perfil = ?, area = ?, fotoPerfil = ? WHERE id = ?`,
      [nombre_usuario, color_perfil, area, fotoPerfil || null, id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.status(200).json({ message: "Perfil actualizado correctamente" });
  } catch (error) {
    console.error("Error al actualizar perfil:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Obtener usuario por ID (sin cambios)
router.get("/users/:userId", async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT id, nombre, nombre_usuario, email, area, rol, color_perfil, fotoPerfil
       FROM usuarios WHERE id = ?`,
      [req.params.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener usuario" });
  }
});

router.get("/users/:id/foto", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.execute(
      "SELECT fotoPerfil FROM usuarios WHERE id = ?",
      [id]
    );

    if (result.rows.length > 0) {
      const fotoPerfil = result.rows[0].fotoPerfil;
      if (fotoPerfil) {
        return res.json({ fotoPerfil });
      } else {
        return res.json({ fotoPerfil: null });
      }
    } else {
      res.status(404).json({ error: "Usuario no encontrado" });
    }
  } catch (err) {
    console.error("Error obteniendo foto de perfil:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/users/:courseId/docente", async (req, res) => {
  const { courseId } = req.params;
  try {
    const result = await db.execute(
      `SELECT u.id, u.nombre, u.fotoPerfil, u.color_perfil
       FROM usuarios u
       JOIN cursos c ON u.id = c.admin
       WHERE c.id = ?`,
      [courseId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Docente no encontrado para este curso" });
    }
    res.json(result.rows[0])
  } catch (error) {
    console.error("Error al obtener el docente del curso:", error);
    res.status(500).json({ error: "Error del servidor" });
  }

})

module.exports = router;
