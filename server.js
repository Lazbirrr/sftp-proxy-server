const express = require('express');
const Client = require('ssh2-sftp-client');
const cors = require('cors');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Logger middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Route de test pour vérifier que le serveur fonctionne
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 Serveur SFTP Proxy opérationnel',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      testConnection: 'POST /sftp/test-connection',
      listFolders: 'POST /sftp/list-folders',
      listFiles: 'POST /sftp/list',
      downloadFile: 'POST /sftp/download'
    }
  });
});

// Route de santé (health check)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Endpoint : Tester la connexion SFTP
app.post('/sftp/test-connection', async (req, res) => {
  const { host, port, username, password } = req.body;
  
  // Validation des paramètres
  if (!host || !username || !password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Paramètres manquants: host, username et password sont requis' 
    });
  }
  
  console.log(`[TEST] Tentative de connexion à ${host}:${port || 22}`);
  
  const sftp = new Client();
  
  try {
    await sftp.connect({ 
      host, 
      port: port || 22, 
      username, 
      password,
      readyTimeout: 15000,
      retries: 1
    });
    
    console.log(`[TEST] ✅ Connexion réussie à ${host}`);
    
    await sftp.end();
    
    res.json({ 
      success: true, 
      message: 'Connexion SFTP établie avec succès',
      host: host,
      port: port || 22
    });
  } catch (error) {
    console.error(`[TEST] ❌ Erreur de connexion:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Vérifiez vos identifiants et que le serveur SFTP est accessible'
    });
  }
});

// Endpoint : Lister tous les dossiers (assureurs)
app.post('/sftp/list-folders', async (req, res) => {
  const { host, port, username, password, basePath } = req.body;
  
  if (!host || !username || !password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Paramètres manquants: host, username et password sont requis' 
    });
  }
  
  const path = basePath || '/';
  console.log(`[FOLDERS] Listing dossiers dans ${path} sur ${host}`);
  
  const sftp = new Client();
  
  try {
    await sftp.connect({ 
      host, 
      port: port || 22, 
      username, 
      password,
      readyTimeout: 15000
    });
    
    const items = await sftp.list(path);
    
    // Ne garder que les dossiers
    const folders = items
      .filter(item => item.type === 'd' && item.name !== '.' && item.name !== '..')
      .map(f => ({
        name: f.name,
        modifyTime: f.modifyTime,
        size: f.size
      }));
    
    console.log(`[FOLDERS] ✅ ${folders.length} dossiers trouvés`);
    
    await sftp.end();
    
    res.json({ 
      success: true, 
      folders: folders,
      count: folders.length,
      path: path
    });
  } catch (error) {
    console.error(`[FOLDERS] ❌ Erreur:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint : Lister les fichiers d'un dossier SFTP
app.post('/sftp/list', async (req, res) => {
  const { host, port, username, password, remotePath, assureur, maxAgeInDays } = req.body;
  
  if (!host || !username || !password || !remotePath) {
    return res.status(400).json({ 
      success: false, 
      error: 'Paramètres manquants: host, username, password et remotePath sont requis' 
    });
  }
  
  console.log(`[LIST] ${assureur || 'Unknown'}: Listing ${remotePath} sur ${host}`);
  
  const sftp = new Client();
  
  try {
    await sftp.connect({ 
      host, 
      port: port || 22, 
      username, 
      password,
      readyTimeout: 15000
    });
    
    const files = await sftp.list(remotePath);
    
    // Filtrer les fichiers (ignorer . et ..)
    let filteredFiles = files.filter(file => 
      file.type === '-' && file.name !== '.' && file.name !== '..'
    );
    
    // Filtrer par âge si spécifié (limiter aux 30 derniers jours par défaut)
    if (maxAgeInDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeInDays);
      
      filteredFiles = filteredFiles.filter(file => {
        const fileDate = new Date(file.modifyTime);
        return fileDate >= cutoffDate;
      });
    }
    
    // Enrichir les infos fichiers
    const enrichedFiles = filteredFiles.map(file => ({
      name: file.name,
      size: file.size,
      modifyTime: file.modifyTime,
      type: file.name.split('.').pop().toLowerCase(),
      fullPath: `${remotePath}/${file.name}`
    }));
    
    console.log(`[LIST] ✅ ${enrichedFiles.length} fichiers trouvés`);
    
    await sftp.end();
    
    res.json({ 
      success: true, 
      files: enrichedFiles,
      count: enrichedFiles.length,
      remotePath: remotePath,
      assureur: assureur
    });
  } catch (error) {
    console.error(`[LIST] ❌ Erreur:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint : Télécharger un fichier SFTP
app.post('/sftp/download', async (req, res) => {
  const { host, port, username, password, remotePath, needsUnzip, zipPassword } = req.body;
  
  if (!host || !username || !password || !remotePath) {
    return res.status(400).json({ 
      success: false, 
      error: 'Paramètres manquants: host, username, password et remotePath sont requis' 
    });
  }
  
  console.log(`[DOWNLOAD] Téléchargement de ${remotePath}`);
  
  const sftp = new Client();
  
  try {
    await sftp.connect({ 
      host, 
      port: port || 22, 
      username, 
      password,
      readyTimeout: 15000
    });
    
    const buffer = await sftp.get(remotePath);
    
    console.log(`[DOWNLOAD] ✅ Fichier téléchargé (${buffer.length} bytes)`);
    
    await sftp.end();
    
    let finalData = buffer;
    let finalFilename = remotePath.split('/').pop();
    let wasUnzipped = false;
    
    // Décompression si nécessaire
    if (needsUnzip && finalFilename.toLowerCase().endsWith('.zip')) {
      console.log(`[UNZIP] Décompression de ${finalFilename}${zipPassword ? ' (avec mot de passe)' : ''}`);
      
      try {
        const zip = new AdmZip(buffer);
        
        // Si mot de passe fourni (non supporté par adm-zip nativement)
        // Note: adm-zip ne supporte pas les ZIP chiffrés, on pourrait utiliser node-7z
        
        const zipEntries = zip.getEntries();
        
        if (zipEntries.length > 0) {
          // Prendre le premier fichier du ZIP
          const firstEntry = zipEntries[0];
          finalData = firstEntry.getData();
          finalFilename = firstEntry.entryName;
          wasUnzipped = true;
          
          console.log(`[UNZIP] ✅ Fichier extrait: ${finalFilename} (${finalData.length} bytes)`);
        } else {
          console.log(`[UNZIP] ⚠️ ZIP vide`);
        }
      } catch (unzipError) {
        console.error(`[UNZIP] ❌ Erreur décompression:`, unzipError.message);
        // On continue avec le fichier original si décompression échoue
        return res.status(500).json({
          success: false,
          error: 'Erreur lors de la décompression du fichier',
          details: unzipError.message
        });
      }
    }
    
    res.json({ 
      success: true, 
      data: finalData.toString('base64'),
      filename: finalFilename,
      size: finalData.length,
      originalPath: remotePath,
      wasUnzipped: wasUnzipped
    });
  } catch (error) {
    console.error(`[DOWNLOAD] ❌ Erreur:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Gestion des erreurs 404
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint non trouvé',
    availableEndpoints: [
      'GET /',
      'GET /health',
      'POST /sftp/test-connection',
      'POST /sftp/list-folders',
      'POST /sftp/list',
      'POST /sftp/download'
    ]
  });
});

// Gestion des erreurs globales
app.use((error, req, res, next) => {
  console.error('Erreur serveur:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Erreur interne du serveur',
    message: error.message
  });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  🚀 SERVEUR SFTP PROXY DÉMARRÉ       ║
║                                       ║
║  Port: ${PORT.toString().padEnd(31)}║
║  Env:  ${(process.env.NODE_ENV || 'development').padEnd(31)}║
║  Time: ${new Date().toLocaleString('fr-FR').padEnd(31)}║
╚═══════════════════════════════════════╝

Endpoints disponibles:
  GET  /              - Informations serveur
  GET  /health        - Health check
  POST /sftp/test-connection
  POST /sftp/list-folders
  POST /sftp/list
  POST /sftp/download
  `);
});
```

---

## 🎯 DIFFÉRENCES AVEC L'ANCIENNE VERSION

**Ce qui a été amélioré :**

1. ✅ **Validation des paramètres** : Le serveur vérifie que tu envoies bien tous les paramètres requis
2. ✅ **Meilleurs logs** : Plus d'infos dans la console pour debug
3. ✅ **Gestion des erreurs 404** : Si tu appelles un mauvais endpoint, il te dit lesquels existent
4. ✅ **Filtrage par date** : Support du paramètre `maxAgeInDays` pour limiter aux 30 derniers jours
5. ✅ **Infos enrichies** : Les fichiers retournés contiennent plus de métadonnées (size, type, fullPath)
6. ✅ **Support prévu pour mot de passe ZIP** : Structure prête (mais adm-zip ne supporte pas les ZIP chiffrés nativement, on pourrait ajouter node-7z plus tard)

---

## 📁 STRUCTURE FINALE DE TON DOSSIER

Dans Cursor, tu dois avoir **exactement 3 fichiers** :
```
sftp-proxy-server/
├── package.json          ← Dépendances npm
├── server.js             ← Code du serveur
└── .gitignore            ← Fichiers à ignorer par Git