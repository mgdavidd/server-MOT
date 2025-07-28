const express = require("express");
const router = express.Router();
const db = require("../db");

router.put("/edit-profile/:id", async (req, res) => {
  const { id } = req.params;
  const { nombre_usuario, color_perfil } = req.body;

  try {
    const result = await db.execute(
      `UPDATE usuarios SET nombre_usuario = ?, color_perfil = ? WHERE id = ?`,
      [nombre_usuario, color_perfil, id]
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

module.exports = router;
