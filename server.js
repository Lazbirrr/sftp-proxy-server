const express = require("express");
const Client = require("ssh2-sftp-client");
const cors = require("cors");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================
// DÉMARRER LE SERVEUR EN PREMIER
// ============================================
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(60));
  console.log("🚀 SERVEUR SFTP PROXY DEMARRE");
  console.log("📡 Port: " + PORT);
  console.log("🌍 Environnement: " + (process.env.NODE_ENV || "development"));
  console.log("🕐 Time: " + new Date().toLocaleString("fr-FR"));
  console.log("=".repeat(60));
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use((req, res, next) => {
  console.log(new Date().toISOString() + " - " + req.method + " " + req.path);
  next();
});

// ============================================
// ROUTES
// ============================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Serveur SFTP Proxy operationnel",
    version: "1.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    endpoints: {
      health: "GET /health",
      testConnection: "POST /sftp/test-connection",
      listFolders: "POST /sftp/list-folders",
      listFiles: "POST /sftp/list",
      downloadFile: "POST /sftp/download",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.post("/sftp/test-connection", async (req, res) => {
  const { host, port, username, password } = req.body;

  if (!host || !username || !password) {
    return res.status(400).json({
      success: false,
      error: "Parametres manquants: host, username et password sont requis",
    });
  }

  console.log("[TEST] Tentative de connexion a " + host + ":" + (port || 22));

  const sftp = new Client();

  try {
    await sftp.connect({
      host,
      port: port || 22,
      username,
      password,
      readyTimeout: 15000,
      retries: 1,
    });

    console.log("[TEST] Connexion reussie a " + host);

    await sftp.end();

    res.json({
      success: true,
      message: "Connexion SFTP etablie avec succes",
      host: host,
      port: port || 22,
    });
  } catch (error) {
    console.error("[TEST] Erreur de connexion:", error.message);
    await sftp.end().catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message,
      details:
        "Verifiez vos identifiants et que le serveur SFTP est accessible",
    });
  }
});

app.post("/sftp/list-folders", async (req, res) => {
  const { host, port, username, password, basePath } = req.body;

  if (!host || !username || !password) {
    return res.status(400).json({
      success: false,
      error: "Parametres manquants: host, username et password sont requis",
    });
  }

  const path = basePath || "/";
  console.log("[FOLDERS] Listing dossiers dans " + path + " sur " + host);

  const sftp = new Client();

  try {
    await sftp.connect({
      host,
      port: port || 22,
      username,
      password,
      readyTimeout: 15000,
    });

    const items = await sftp.list(path);

    const folders = items
      .filter(
        (item) => item.type === "d" && item.name !== "." && item.name !== ".."
      )
      .map((f) => ({
        name: f.name,
        modifyTime: f.modifyTime,
        size: f.size,
      }));

    console.log("[FOLDERS] " + folders.length + " dossiers trouves");

    await sftp.end();

    res.json({
      success: true,
      folders: folders,
      count: folders.length,
      path: path,
    });
  } catch (error) {
    console.error("[FOLDERS] Erreur:", error.message);
    await sftp.end().catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/sftp/list", async (req, res) => {
  const { host, port, username, password, remotePath, assureur, maxAgeInDays } =
    req.body;

  if (!host || !username || !password || !remotePath) {
    return res.status(400).json({
      success: false,
      error:
        "Parametres manquants: host, username, password et remotePath sont requis",
    });
  }

  console.log(
    "[LIST] " +
      (assureur || "Unknown") +
      ": Listing " +
      remotePath +
      " sur " +
      host
  );

  const sftp = new Client();

  try {
    await sftp.connect({
      host,
      port: port || 22,
      username,
      password,
      readyTimeout: 15000,
    });

    const files = await sftp.list(remotePath);

    let filteredFiles = files.filter(
      (file) => file.type === "-" && file.name !== "." && file.name !== ".."
    );

    if (maxAgeInDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeInDays);

      filteredFiles = filteredFiles.filter((file) => {
        const fileDate = new Date(file.modifyTime);
        return fileDate >= cutoffDate;
      });
    }

    const enrichedFiles = filteredFiles.map((file) => ({
      name: file.name,
      size: file.size,
      modifyTime: file.modifyTime,
      type: file.name.split(".").pop().toLowerCase(),
      fullPath: remotePath + "/" + file.name,
    }));

    console.log("[LIST] " + enrichedFiles.length + " fichiers trouves");

    await sftp.end();

    res.json({
      success: true,
      files: enrichedFiles,
      count: enrichedFiles.length,
      remotePath: remotePath,
      assureur: assureur,
    });
  } catch (error) {
    console.error("[LIST] Erreur:", error.message);
    await sftp.end().catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/sftp/download", async (req, res) => {
  const {
    host,
    port,
    username,
    password,
    remotePath,
    needsUnzip,
    zipPassword,
  } = req.body;

  if (!host || !username || !password || !remotePath) {
    return res.status(400).json({
      success: false,
      error:
        "Parametres manquants: host, username, password et remotePath sont requis",
    });
  }

  console.log("[DOWNLOAD] Telechargement de " + remotePath);

  const sftp = new Client();

  try {
    await sftp.connect({
      host,
      port: port || 22,
      username,
      password,
      readyTimeout: 15000,
    });

    const buffer = await sftp.get(remotePath);

    console.log("[DOWNLOAD] Fichier telecharge (" + buffer.length + " bytes)");

    await sftp.end();

    let finalData = buffer;
    let finalFilename = remotePath.split("/").pop();
    let wasUnzipped = false;

    if (needsUnzip && finalFilename.toLowerCase().endsWith(".zip")) {
      console.log("[UNZIP] Decompression de " + finalFilename);

      try {
        const zip = new AdmZip(buffer);
        const zipEntries = zip.getEntries();

        if (zipEntries.length > 0) {
          const firstEntry = zipEntries[0];
          finalData = firstEntry.getData();
          finalFilename = firstEntry.entryName;
          wasUnzipped = true;

          console.log(
            "[UNZIP] Fichier extrait: " +
              finalFilename +
              " (" +
              finalData.length +
              " bytes)"
          );
        } else {
          console.log("[UNZIP] ZIP vide");
        }
      } catch (unzipError) {
        console.error("[UNZIP] Erreur decompression:", unzipError.message);
        return res.status(500).json({
          success: false,
          error: "Erreur lors de la decompression du fichier",
          details: unzipError.message,
        });
      }
    }

    res.json({
      success: true,
      data: finalData.toString("base64"),
      filename: finalFilename,
      size: finalData.length,
      originalPath: remotePath,
      wasUnzipped: wasUnzipped,
    });
  } catch (error) {
    console.error("[DOWNLOAD] Erreur:", error.message);
    await sftp.end().catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// ERROR HANDLERS
// ============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint non trouve",
    availableEndpoints: [
      "GET /",
      "GET /health",
      "POST /sftp/test-connection",
      "POST /sftp/list-folders",
      "POST /sftp/list",
      "POST /sftp/download",
    ],
  });
});

app.use((error, req, res, next) => {
  console.error("Erreur serveur:", error);
  res.status(500).json({
    success: false,
    error: "Erreur interne du serveur",
    message: error.message,
  });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
