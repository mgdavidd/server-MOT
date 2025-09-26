const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const db = require("./db");

const createDriveFolder = async (drive, userName) => {
  const folderResponse = await drive.files.create({
    requestBody: {
      name: `Mot-folder - ${userName}`,
      mimeType: "application/vnd.google-apps.folder",
    },
  });
  return folderResponse.data.id;
};

/**
 * Obtiene el cliente de Google Drive de un administrador
 * Puede buscar tanto por ID de usuario como por nombre de usuario
 */
const getAdminDriveClient = async (identifier) => {
  let result;

  // Si es número → buscar por ID
  if (!isNaN(identifier)) {
    result = await db.execute(
      "SELECT google_token, google_drive_folder_id, nombre FROM usuarios WHERE id = ? AND rol = 'profesor'",
      [identifier]
    );
  } else {
    // Si no, buscar por nombre
    result = await db.execute(
      "SELECT google_token, google_drive_folder_id, nombre FROM usuarios WHERE nombre = ? AND rol = 'profesor'",
      [identifier]
    );
  }

  const admin = result.rows[0];
  if (!admin) throw new Error("Usuario administrador no encontrado");

  const auth = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(JSON.parse(admin.google_token));
  const drive = google.drive({ version: "v3", auth });

  let folderId = admin.google_drive_folder_id;
  if (!folderId) {
    folderId = await createDriveFolder(drive, admin.nombre);
    await db.execute(
      "UPDATE usuarios SET google_drive_folder_id = ? WHERE nombre = ?",
      [folderId, admin.nombre]
    );
  }

  return { auth, folderId };
};

module.exports = { getAdminDriveClient };
