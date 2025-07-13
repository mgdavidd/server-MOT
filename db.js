const { createClient } = require("@libsql/client");
const dotenv = require("dotenv");

dotenv.config();

const db = createClient({
  url: process.env.DB_URL,
  authToken: process.env.DB_AUTH_TOKEN,
});

module.exports = db;
