const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/my-students/:courseId", async (req, res) => {
    const estudents = await db.execute(
        `SELECT u.id, u.nombre, u.nombre_usuario, u.fotoPerfil, u.color_perfil FROM usuarios u JOIN cursos_estudiante ce
        ON u.id = ce.idUsuario WHERE ce.idCurso = ?`,
        [req.params.courseId]
    )

    return res.send(estudents.rows);
})



module.exports = router;
