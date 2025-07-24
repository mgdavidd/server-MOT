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

const getAdminDriveClient = async (adminUserName) => {
  const result = await db.execute(
    "SELECT google_token, google_drive_folder_id FROM usuarios WHERE nombre = ? AND rol = 'profesor'",
    [adminUserName]
  );

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
    folderId = await createDriveFolder(drive, adminUserName);
    await db.execute(
      "UPDATE usuarios SET google_drive_folder_id = ? WHERE nombre = ?",
      [folderId, adminUserName]
    );
  }

  return { auth, folderId };
};

module.exports = { getAdminDriveClient };
