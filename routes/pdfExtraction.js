const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten archivos PDF"));
    }
  }
});

// Ruta para extraer texto de PDF
router.post("/extract-pdf-text", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }

    console.log(`Procesando PDF: ${req.file.originalname} (${(req.file.size / 1024).toFixed(2)} KB)`);

    // Extraer texto del PDF
    const data = await pdfParse(req.file.buffer);
    
    const extractedText = data.text.trim();

    if (!extractedText || extractedText.length < 50) {
      return res.status(400).json({ 
        error: "El PDF no contiene texto extraíble o es muy corto" 
      });
    }

    console.log(`✓ Texto extraído: ${extractedText.length} caracteres, ${data.numpages} páginas`);

    res.json({
      success: true,
      text: extractedText,
      pages: data.numpages,
      info: data.info
    });

  } catch (error) {
    console.error("Error extrayendo texto del PDF:", error);
    res.status(500).json({ 
      error: "Error al procesar el PDF",
      detalles: error.message 
    });
  }
});

module.exports = router;