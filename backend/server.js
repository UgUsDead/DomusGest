const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const dotenvPath = path.join(__dirname, '.env');
if (fs.existsSync(dotenvPath)) {
  require('dotenv').config({ path: dotenvPath });
}

const app = express();
const PORT = Number(process.env.PORT) || 3002;

// Middleware
// Enable CORS and allow custom headers used by the frontend (admin-permissions, maintenance-id, etc.)
app.use(cors({
  origin: true,
  allowedHeaders: ['Origin','X-Requested-With','Content-Type','Accept','admin-permissions','admin-id','admin-username','maintenance-id']
}));
// Ensure preflight requests are handled for all routes
app.options('*', cors());
app.use(express.json());

// Database setup (will be done later in the file)
let db;

// Helper: normalize allowed_condominiums into an array of Numbers
function normalizeAllowedCondominiums(raw) {
  try {
    if (!raw) return [];
    let arr = raw;
    if (typeof arr === 'string') {
      try { arr = JSON.parse(arr); } catch (e) { arr = [arr]; }
    }
    if (!Array.isArray(arr)) arr = [arr];
    return arr.map(x => Number(x)).filter(n => !Number.isNaN(n));
  } catch (e) {
    console.warn('normalizeAllowedCondominiums parse error', e && e.message);
    return [];
  }
}

// Helper: get admin-allowed condos with type normalization
function getAdminAllowedCondos(req) {
  try {
    const perms = req.headers['admin-permissions'];
    if (!perms) return null; // null = full access
    
    const parsed = typeof perms === 'string' ? JSON.parse(perms) : perms;
    if (parsed.scope === 'full') return null; // null = full access
    
    if (parsed.scope === 'limited' && parsed.allowed_condominiums) {
      const normalized = normalizeAllowedCondominiums(parsed.allowed_condominiums);
      return normalized.length > 0 ? normalized : [];
    }
    return []; // empty array = no access
  } catch (e) {
    console.error('Error parsing admin permissions:', e);
    return []; // empty array = no access
  }
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'assembleia-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// Multer for admin messages: accept PDF and common image types (jpg, jpeg, png)
const adminMessageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'adminmsg-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadAny = multer({
  storage: adminMessageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and JPG/PNG images are allowed'), false);
  }
});

// Multer instance for images (jpeg/png)
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ocorrencia-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadImages = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG/PNG images are allowed'), false);
  }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

const publicDir = path.join(__dirname, 'public');
const hasPublicDir = fs.existsSync(publicDir);
if (hasPublicDir) {
  app.use(express.static(publicDir));
} else {
  console.warn('⚠️ Public build folder not found at', publicDir);
}

// Database setup
const defaultDbPath = path.join(__dirname, 'domusgest.db');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDbPath;

db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('✅ Connected to SQLite database at:', dbPath);
    initializeDatabase();
    
    // Setup routers after database is connected
    const userOcorrenciasRouter = require('./user-ocorrencias')(db);
    app.use(userOcorrenciasRouter);
  }
});

// Initialize database tables
function initializeDatabase() {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grupo TEXT,
      nome TEXT NOT NULL,
      nif TEXT UNIQUE NOT NULL,
      telemovel TEXT,
      telefone TEXT,
      permite_telefone TEXT,
      email1 TEXT,
      email2 TEXT,
      email3 TEXT,
      permite_email TEXT,
      conjuge TEXT,
      data_criacao TEXT,
      data_alteracao TEXT,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createAdminsTable = `
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      scope TEXT DEFAULT 'full',
      allowed_condominiums TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createMaintenanceTable = `
    CREATE TABLE IF NOT EXISTS maintenance_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nome TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createOcorrenciasTable = `
    CREATE TABLE IF NOT EXISTS ocorrencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condominium_id INTEGER NOT NULL,
  condominium_nipc TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      created_by_admin INTEGER NOT NULL,
  reporter_user_id INTEGER,
  reporter_user_nif TEXT,
  reporter_note TEXT,
      assigned_to_maintenance INTEGER,
      maintenance_report TEXT,
      admin_verification TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_admin) REFERENCES admins (id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_to_maintenance) REFERENCES maintenance_users (id) ON DELETE SET NULL
    )
  `;

  const createAssembleiasTable = `
    CREATE TABLE IF NOT EXISTS assembleias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condominium_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      date DATE NOT NULL,
      time TIME NOT NULL,
      location TEXT,
      status TEXT DEFAULT 'scheduled',
      admin_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE
    )
  `;

  const createAssembleiaFilesTable = `
    CREATE TABLE IF NOT EXISTS assembleia_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assembleia_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assembleia_id) REFERENCES assembleias (id) ON DELETE CASCADE
    )
  `;

  const createOcorrenciaImagesTable = `
    CREATE TABLE IF NOT EXISTS ocorrencia_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ocorrencia_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ocorrencia_id) REFERENCES ocorrencias (id) ON DELETE CASCADE
    )
  `;

  const createUserMessagesTable = `
    CREATE TABLE IF NOT EXISTS user_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      condominium_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('complaint', 'request')),
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
      admin_response TEXT,
      admin_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE,
      FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE SET NULL
    )
  `;

  const createCondominiumsTable = `
    CREATE TABLE IF NOT EXISTS condominiums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
  nipc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createUserCondominiumsTable = `
    CREATE TABLE IF NOT EXISTS user_condominiums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      condominium_id INTEGER NOT NULL,
      apartment TEXT,
      role TEXT DEFAULT 'resident',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE,
      UNIQUE(user_id, condominium_id)
    )
  `;

  db.run(createUsersTable, (err) => {
    if (err) {
      console.error('Error creating users table:', err.message);
    } else {
      console.log('✅ Users table ready');
    }
  });

  db.run(createAdminsTable, (err) => {
    if (err) {
      console.error('Error creating admins table:', err.message);
    } else {
      console.log('✅ Admins table ready');
      createDefaultAdmin();
    }
  });

  // Ensure admin_notifications table exists for linking notifications
  const createAdminNotifications = `
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      notification_id INTEGER NOT NULL,
      read_status INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;
  db.run(createAdminNotifications, (err) => {
    if (err) console.error('Error creating admin_notifications table:', err.message);
    else console.log('✅ admin_notifications table ready');
  });

  db.run(createMaintenanceTable, (err) => {
    if (err) {
      console.error('Error creating maintenance_users table:', err.message);
    } else {
      console.log('✅ Maintenance users table ready');
      createDefaultMaintenanceUser();
    }
  });

  db.run(createOcorrenciasTable, (err) => {
    if (err) {
      console.error('Error creating ocorrencias table:', err.message);
    } else {
      console.log('✅ Ocorrencias table ready');
    }
  });

  // Runtime migration: add phone column to maintenance_users table
  db.all("PRAGMA table_info('maintenance_users')", [], (err, rows) => {
    if (err) {
      console.error('Error reading maintenance_users table info for migration:', err.message);
      return;
    }

    const cols = rows.map(r => r.name);
    if (!cols.includes('phone')) {
      db.run("ALTER TABLE maintenance_users ADD COLUMN phone TEXT", [], (err) => {
        if (err) console.error('Error adding phone column to maintenance_users:', err.message);
        else console.log('✅ Added phone column to maintenance_users table');
      });
    }
  });

  // Runtime migration: ensure new columns exist on ocorrencias table (safe to run repeatedly)
  db.all("PRAGMA table_info('ocorrencias')", [], (err, rows) => {
    if (err) {
      console.error('Error reading ocorrencias table info for migration:', err.message);
      return;
    }
    const cols = (rows || []).map(r => r.name);
    const adds = [];
    if (!cols.includes('condominium_nipc')) adds.push("ALTER TABLE ocorrencias ADD COLUMN condominium_nipc TEXT");
    if (!cols.includes('reporter_user_id')) adds.push("ALTER TABLE ocorrencias ADD COLUMN reporter_user_id INTEGER");
    if (!cols.includes('reporter_user_nif')) adds.push("ALTER TABLE ocorrencias ADD COLUMN reporter_user_nif TEXT");
    if (!cols.includes('reporter_note')) adds.push("ALTER TABLE ocorrencias ADD COLUMN reporter_note TEXT");

    if (adds.length > 0) {
      console.log('Running ocorrencias migration, adding columns:', adds.map(s => s.replace('ALTER TABLE ocorrencias ADD COLUMN ', '')).join(', '));
      (async () => {
        for (const sql of adds) {
          await new Promise((resolve) => {
            db.run(sql, (e) => {
              if (e) console.error('Migration error:', e.message);
              else console.log('Migration applied:', sql);
              resolve();
            });
          });
        }
      })();
    }
  });

  db.run(createAssembleiasTable, (err) => {
    if (err) {
      console.error('Error creating assembleias table:', err.message);
    } else {
      console.log('✅ Assembleias table ready');
    }
  });

  db.run(createAssembleiaFilesTable, (err) => {
    if (err) {
      console.error('Error creating assembleia_files table:', err.message);
    } else {
      console.log('✅ Assembleia files table ready');
    }
  });

  db.run(createOcorrenciaImagesTable, (err) => {
    if (err) {
      console.error('Error creating ocorrencia_images table:', err.message);
    } else {
      console.log('✅ Ocorrencia images table ready');
    }
  });

  // Create table for admins if not exists handled above; add endpoints to create admins/maintenance users below

  db.run(createUserMessagesTable, (err) => {
    if (err) {
      console.error('Error creating user_messages table:', err.message);
    } else {
      console.log('✅ User messages table ready');
    }
  });

  db.run(createCondominiumsTable, (err) => {
    if (err) {
      console.error('Error creating condominiums table:', err.message);
    } else {
      console.log('✅ Condominiums table ready');
      // Ensure nipc column exists (migration for older DBs)
      db.all("PRAGMA table_info(condominiums)", [], (piErr, cols) => {
        if (piErr) {
          console.error('Error checking condominiums schema:', piErr.message);
          return;
        }
        const hasNipc = (cols || []).some(c => c && c.name === 'nipc');
        if (!hasNipc) {
          db.run("ALTER TABLE condominiums ADD COLUMN nipc TEXT", (alterErr) => {
            if (alterErr) console.error('Error adding nipc column to condominiums:', alterErr.message);
            else console.log('✅ Added nipc column to condominiums table');
          });
        }
      });
    }
  });

  db.run(createUserCondominiumsTable, (err) => {
    if (err) {
      console.error('Error creating user_condominiums table:', err.message);
    } else {
      console.log('✅ User condominiums table ready');
    }
  });

  // Create admin notes table
  const createAdminNotesTable = `
    CREATE TABLE IF NOT EXISTS admin_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condominium_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by_admin INTEGER,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_admin) REFERENCES admins (id) ON DELETE SET NULL
    )
  `;

  db.run(createAdminNotesTable, (err) => {
    if (err) {
      console.error('Error creating admin_notes table:', err.message);
    } else {
      console.log('✅ Admin notes table ready');
    }
  });

  // Create notifications table for admin alerts
  const createNotificationsTable = `
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, -- 'profile_change', 'reclamacao', 'pedido', etc.
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      related_id INTEGER, -- Can store user_id, message_id, etc. for context
      condominium_id INTEGER, -- The condominium this notification is related to
      user_id INTEGER, -- Optional user associated with this notification
      user_name TEXT, -- Cached user name for quick display
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Create user notifications table for regular users
  const createUserNotificationsTable = `
    CREATE TABLE IF NOT EXISTS user_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      notification_id INTEGER NOT NULL,
      read_status INTEGER DEFAULT 0, -- 0 = unread, 1 = read
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
      UNIQUE(user_id, notification_id)
    )
  `;

  db.run(createNotificationsTable, (err) => {
    if (err) {
      console.error('Error creating notifications table:', err.message);
    } else {
      console.log('✅ Notifications table ready');
    }
  });

  db.run(createUserNotificationsTable, (err) => {
    if (err) {
      console.error('Error creating user notifications table:', err.message);
    } else {
      console.log('✅ User notifications table ready');
    }
  });

  // Ensure notifications table has related_id column (migration for older DBs)
  db.all("PRAGMA table_info('notifications')", [], (err, rows) => {
    if (err) {
      console.error('Error reading notifications table info for migration:', err.message);
      return;
    }
    const cols = (rows || []).map(r => r.name);
    const addColumnIfMissing = (columnName, definition) => {
      if (!cols.includes(columnName)) {
        db.run(`ALTER TABLE notifications ADD COLUMN ${columnName} ${definition}`, (alterErr) => {
          if (alterErr) console.error(`Error adding ${columnName} to notifications:`, alterErr.message);
          else console.log(`✅ Added ${columnName} column to notifications table`);
        });
      }
    };

    addColumnIfMissing('related_id', 'INTEGER');
    addColumnIfMissing('condominium_id', 'INTEGER');
    addColumnIfMissing('user_id', 'INTEGER');
    addColumnIfMissing('user_name', 'TEXT');
  });

  // Create a linking table to track which admin has read which notification
  const createAdminNotificationsTable = `
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      notification_id INTEGER NOT NULL,
      read_status INTEGER DEFAULT 0, -- 0 = unread, 1 = read
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE,
      FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
      UNIQUE(admin_id, notification_id)
    )
  `;
  db.run(createAdminNotificationsTable, (err) => {
    if (err) {
      console.error('Error creating admin_notifications table:', err.message);
    } else {
      console.log('✅ Admin Notifications link table ready');
    }
  });

  // Create profile changes log table
  const createProfileChangesTable = `
    CREATE TABLE IF NOT EXISTS profile_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `;

  db.run(createProfileChangesTable, (err) => {
    if (err) {
      console.error('Error creating profile_changes table:', err.message);
    } else {
      console.log('✅ Profile changes table ready');
    }
  });

  // Create tables for admin messages
  const createAdminMessagesTable = `
    CREATE TABLE IF NOT EXISTS admin_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT DEFAULT 'general', -- 'general' or 'opcao_natal'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createAdminMessageTargets = `
    CREATE TABLE IF NOT EXISTS admin_message_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      condominium_id INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES admin_messages (id) ON DELETE CASCADE,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE
    )
  `;

  const createAdminMessageFiles = `
    CREATE TABLE IF NOT EXISTS admin_message_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES admin_messages (id) ON DELETE CASCADE
    )
  `;

  // Create admin_message_condominiums junction table (used for filtering notifications)
  const createAdminMessageCondominiums = `
    CREATE TABLE IF NOT EXISTS admin_message_condominiums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      condominium_id INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES admin_messages (id) ON DELETE CASCADE,
      FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE
    )
  `;

  db.run(createAdminMessagesTable, (err) => { if (err) console.error('Error creating admin_messages table:', err.message); else console.log('✅ admin_messages table ready'); });
  db.run(createAdminMessageTargets, (err) => { if (err) console.error('Error creating admin_message_targets table:', err.message); else console.log('✅ admin_message_targets table ready'); });
  db.run(createAdminMessageCondominiums, (err) => { if (err) console.error('Error creating admin_message_condominiums table:', err.message); else console.log('✅ admin_message_condominiums table ready'); });
  db.run(createAdminMessageFiles, (err) => { if (err) console.error('Error creating admin_message_files table:', err.message); else console.log('✅ admin_message_files table ready'); });
}

// Create default admin user
async function createDefaultAdmin() {
  const adminUsername = 'admin';
  const adminPassword = 'admin!!';
  
  try {
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    
    db.run(
      'INSERT OR REPLACE INTO admins (username, password) VALUES (?, ?)',
      [adminUsername, hashedPassword],
      function(err) {
        if (err) {
          console.error('Error creating admin user:', err.message);
        } else {
          console.log('✅ Default admin user created (admin/admin!!)');
        }
      }
    );
  } catch (error) {
    console.error('Error hashing admin password:', error);
  }
}

// Create default maintenance user
async function createDefaultMaintenanceUser() {
  const manutUsername = 'Manut';
  const manutPassword = 'Manut!!';
  const manutName = 'Maintenance User';
  
  try {
    const hashedPassword = await bcrypt.hash(manutPassword, 10);

    // Create primary Manut
    db.run(
      'INSERT OR REPLACE INTO maintenance_users (username, password, nome) VALUES (?, ?, ?)',
      [manutUsername, hashedPassword, manutName],
      function(err) {
        if (err) console.error('Error creating maintenance user Manut:', err.message);
        else console.log('✅ Default maintenance user created (Manut/Manut!!)');
      }
    );

    // Create Manut2 and Manut3
    const manut2Password = 'Manut2!!';
    const manut3Password = 'Manut3!!';
    const hashed2 = await bcrypt.hash(manut2Password, 10);
    const hashed3 = await bcrypt.hash(manut3Password, 10);

    db.run(
      'INSERT OR REPLACE INTO maintenance_users (username, password, nome) VALUES (?, ?, ?)',
      ['Manut2', hashed2, 'Maintenance User 2'],
      function(err) {
        if (err) console.error('Error creating maintenance user Manut2:', err.message);
        else console.log('✅ Default maintenance user created (Manut2/Manut2!!)');
      }
    );

    db.run(
      'INSERT OR REPLACE INTO maintenance_users (username, password, nome) VALUES (?, ?, ?)',
      ['Manut3', hashed3, 'Maintenance User 3'],
      function(err) {
        if (err) console.error('Error creating maintenance user Manut3:', err.message);
        else console.log('✅ Default maintenance user created (Manut3/Manut3!!)');
      }
    );
  } catch (error) {
    console.error('Error hashing maintenance password:', error);
  }
}

// ====== HELPER FUNCTIONS ======

/**
 * Links a notification to appropriate admins based on user's condominiums and admin permissions
 * @param {number} notificationId - The ID of the notification to link
 * @param {number} userId - The ID of the user who triggered the notification
 * @param {function} callback - Callback function (err, linkedAdminCount)
 */
function linkNotificationToAdmins(notificationId, userId, callback) {
  console.log(`🔗 Linking notification ${notificationId} for user ${userId}...`);

  // First, get the user's condominiums
  const userCondosSql = `
    SELECT DISTINCT uc.condominium_id
    FROM user_condominiums uc
    WHERE uc.user_id = ?
  `;

  db.all(userCondosSql, [userId], (condoErr, userCondos) => {
    if (condoErr) {
      console.error('Error getting user condominiums for notification linking:', condoErr.message);
      return callback(condoErr);
    }

    const condoIds = userCondos.map(c => c.condominium_id);
    console.log(`🏢 User ${userId} belongs to condominiums: ${condoIds}`);

    // Get all admins and their permissions
    const adminsSql = 'SELECT id, username, scope, allowed_condominiums FROM admins';
    db.all(adminsSql, [], (adminErr, admins) => {
      if (adminErr) {
        console.error('Error getting admins for notification linking:', adminErr.message);
        return callback(adminErr);
      }

      const adminLinksToCreate = [];

      // Determine which admins should receive this notification
      for (const admin of admins) {
        if (admin.scope === 'full') {
          // Full access admin - should receive all notifications
          adminLinksToCreate.push(admin.id);
          console.log(`👮 Admin ${admin.username} (full) should receive notification`);
        } else if (admin.scope === 'limited') {
          // Limited access admin - check if they have access to any of the user's condominiums
          try {
            const allowedCondos = normalizeAllowedCondominiums(admin.allowed_condominiums);
            const numericCondoIds = condoIds.map(x => Number(x));
            const hasOverlap = numericCondoIds.some(condoId => allowedCondos.includes(condoId));
            
            if (hasOverlap) {
              adminLinksToCreate.push(admin.id);
              const overlappingCondos = numericCondoIds.filter(condoId => allowedCondos.includes(condoId));
              console.log(`👮 Admin ${admin.username} (limited) should receive notification for condos: ${overlappingCondos}`);
            } else {
              console.log(`👮 Admin ${admin.username} (limited) should NOT receive notification - no matching condos`);
            }
          } catch (parseErr) {
            console.error(`Error parsing allowed_condominiums for admin ${admin.username}:`, parseErr);
          }
        }
      }

      if (adminLinksToCreate.length === 0) {
        console.log('⚠️ No admins found to receive this notification');
        return callback(null, 0);
      }

      // Create admin_notifications links
      const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;
      let linksCreated = 0;
      let linkErrors = 0;

      for (const adminId of adminLinksToCreate) {
        db.run(linkSql, [adminId, notificationId], (linkErr) => {
          if (linkErr) {
            console.error(`Error linking notification ${notificationId} to admin ${adminId}:`, linkErr.message);
            linkErrors++;
          } else {
            console.log(`✅ Linked notification ${notificationId} to admin ${adminId}`);
            linksCreated++;
          }

          // Check if this is the last link attempt
          if (linksCreated + linkErrors === adminLinksToCreate.length) {
            if (linksCreated > 0) {
              console.log(`✅ Successfully linked notification to ${linksCreated} admin(s)`);
              // Broadcast SSE to linked admins so they receive the event immediately
              try {
                for (const aid of adminLinksToCreate) sendSseToAdmin(aid, 'notification_created', { notification_id: notificationId, related_user_id: userId });
              } catch (e) { console.warn('Error broadcasting SSE from linkNotificationToAdmins', e.message); }

              callback(null, linksCreated);
            } else {
              callback(new Error('Failed to link notification to any admins'), 0);
            }
          }
        });
      }
    });
  });
}

/**
 * Links a notification to ALL admins (for system-wide notifications)
 * @param {number} notificationId - The ID of the notification to link
 * @param {function} callback - Callback function (err, linkedAdminCount)
 */
/**
 * Links a notification to all users in the given condominiums
 * @param {number} notificationId - The ID of the notification to link
 * @param {number[]} condominiumIds - Array of condominium IDs
 * @param {function} callback - Callback function (err, linkedUsersCount)
 */
/**
 * Links a notification to admins that manage any of the provided condominiums
 * @param {number} notificationId - The ID of the notification to link
 * @param {number[]|string[]} condominiumIds - Condominium identifiers related to the notification
 * @param {function} [callback] - Optional node-style callback (err, { linkedCount, adminIds })
 * @returns {Promise<{linkedCount: number, adminIds: number[]}>}
 */
function linkNotificationToAdminsByCondominiums(notificationId, condominiumIds, callback) {
  const promise = new Promise((resolve, reject) => {
    if (!notificationId) {
      const err = new Error('Notification ID is required to link admins');
      return reject(err);
    }

    const normalizedCondoIds = (Array.isArray(condominiumIds) ? condominiumIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id));

    if (normalizedCondoIds.length === 0) {
      console.log('⚠️ linkNotificationToAdminsByCondominiums called without condominium ids');
      return resolve({ linkedCount: 0, adminIds: [] });
    }

    db.all('SELECT id, username, scope, allowed_condominiums FROM admins', [], (adminErr, admins) => {
      if (adminErr) {
        console.error('Error getting admins for condominium-based notification linking:', adminErr.message);
        return reject(adminErr);
      }

      const adminIds = [];

      for (const admin of admins || []) {
        if (admin.scope === 'full') {
          adminIds.push(admin.id);
          continue;
        }

        if (admin.scope === 'limited') {
          try {
            const allowed = normalizeAllowedCondominiums(admin.allowed_condominiums);
            if (!Array.isArray(allowed) || allowed.length === 0) continue;

            const hasOverlap = normalizedCondoIds.some((condoId) => allowed.includes(Number(condoId)));
            if (hasOverlap) {
              adminIds.push(admin.id);
            }
          } catch (parseErr) {
            console.error(`Error parsing allowed_condominiums for admin ${admin.username}:`, parseErr.message || parseErr);
          }
        }
      }

      if (adminIds.length === 0) {
        console.log('⚠️ No admins matched for condominium-based notification linking');
        return resolve({ linkedCount: 0, adminIds: [] });
      }

      const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;
      let completed = 0;
      let success = 0;

      adminIds.forEach((adminId) => {
        db.run(linkSql, [adminId, notificationId], (linkErr) => {
          completed += 1;
          if (linkErr) {
            console.error(`Error linking notification ${notificationId} to admin ${adminId}:`, linkErr.message);
          } else {
            success += 1;
          }

          if (completed === adminIds.length) {
            resolve({ linkedCount: success, adminIds });
          }
        });
      });
    });
  });

  if (typeof callback === 'function') {
    promise
      .then((result) => callback(null, result))
      .catch((err) => callback(err, { linkedCount: 0, adminIds: [] }));
  }

  return promise;
}

function linkNotificationToUsers(notificationId, condominiumIds, callback) {
  console.log(`🔗 Linking notification ${notificationId} to users in condominiums:`, condominiumIds);

  if (!condominiumIds || !Array.isArray(condominiumIds) || condominiumIds.length === 0) {
    console.log('⚠️ No condominiums specified for notification');
    return callback(null, 0);
  }

  const placeholders = condominiumIds.map(() => '?').join(',');
  const sql = `
    INSERT INTO user_notifications (user_id, notification_id, read_status, created_at)
    SELECT DISTINCT uc.user_id, ?, 0, CURRENT_TIMESTAMP
    FROM user_condominiums uc
    WHERE uc.condominium_id IN (${placeholders})
  `;

  const params = [notificationId, ...condominiumIds];
  db.run(sql, params, function(err) {
    if (err) {
      console.error('Error linking notification to users:', err.message);
      return callback(err);
    }
    const linksCreated = this.changes;
    console.log(`✅ Linked notification ${notificationId} to ${linksCreated} users`);
    callback(null, linksCreated);
  });
}

function linkNotificationToAllAdmins(notificationId, callback) {
  console.log(`🔗 Linking notification ${notificationId} to ALL admins...`);

  const adminsSql = 'SELECT id, username FROM admins';
  db.all(adminsSql, [], (adminErr, admins) => {
    if (adminErr) {
      console.error('Error getting admins for notification linking:', adminErr.message);
      return callback(adminErr);
    }

    if (admins.length === 0) {
      console.log('⚠️ No admins found');
      return callback(null, 0);
    }

    // Create admin_notifications links
    const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;
    let linksCreated = 0;
    let linkErrors = 0;

    for (const admin of admins) {
      db.run(linkSql, [admin.id, notificationId], (linkErr) => {
        if (linkErr) {
          console.error(`Error linking notification ${notificationId} to admin ${admin.id}:`, linkErr.message);
          linkErrors++;
        } else {
          console.log(`✅ Linked notification ${notificationId} to admin ${admin.username}`);
          linksCreated++;
        }

        // Check if this is the last link attempt
        if (linksCreated + linkErrors === admins.length) {
          if (linksCreated > 0) {
            console.log(`✅ Successfully linked notification to ${linksCreated} admin(s)`);
            callback(null, linksCreated);
          } else {
            callback(new Error('Failed to link notification to any admins'), 0);
          }
        }
      });
    }
  });
}

// --- Server-Sent Events (SSE) support for admin notification streaming
const sseClients = new Map(); // adminId -> [res, ...]

function addSseClient(adminId, res) {
  const key = String(adminId);
  if (!sseClients.has(key)) sseClients.set(key, []);
  sseClients.get(key).push(res);
  console.log(`🔔 SSE client added for admin ${key} (total: ${sseClients.get(key).length})`);
}

function removeSseClient(adminId, res) {
  const key = String(adminId);
  if (!sseClients.has(key)) return;
  const list = sseClients.get(key).filter(r => r !== res);
  if (list.length === 0) sseClients.delete(key);
  else sseClients.set(key, list);
  console.log(`🔕 SSE client removed for admin ${key} (remaining: ${list.length})`);
}

function sendSseToAdmin(adminId, eventName, payload) {
  const key = String(adminId);
  const clients = sseClients.get(key) || [];
  if (clients.length === 0) return;
  const data = JSON.stringify(payload || {});
  for (const res of clients) {
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (e) {
      console.warn('Error sending SSE to admin', adminId, e.message);
    }
  }
  console.log(`📣 Sent SSE event '${eventName}' to admin ${key} (${clients.length} connections)`);
}

// SSE endpoint admins can subscribe to for real-time notifications
app.get('/api/notifications/stream', (req, res) => {
  const adminId = req.headers['admin-id'] || req.query.admin_id;
  if (!adminId) {
    return res.status(400).json({ error: 'admin-id header or admin_id query param is required' });
  }

  // Set SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders?.();

  // Send initial connected message
  res.write('event: connected\n');
  res.write(`data: ${JSON.stringify({ message: 'connected', adminId: String(adminId) })}\n\n`);

  addSseClient(adminId, res);

  req.on('close', () => {
    removeSseClient(adminId, res);
  });
});

// Helper: check if the requester is the MAIN admin (username 'admin')
function checkIsMainAdmin(req) {
  return new Promise((resolve) => {
    const adminIdHdr = req.headers['admin-id'];
    const adminUsernameHdr = req.headers['admin-username'];

    if (adminUsernameHdr && adminUsernameHdr.toString() === 'admin') return resolve(true);

    if (!adminIdHdr) return resolve(false);

    const id = parseInt(adminIdHdr, 10);
    if (isNaN(id)) return resolve(false);

    db.get('SELECT username FROM admins WHERE id = ?', [id], (err, row) => {
      if (err || !row) return resolve(false);
      resolve(row.username === 'admin');
    });
  });
}

// ====== API ROUTES ======

// Root route
app.get('/', (req, res) => {
  if (hasPublicDir) {
    const indexPath = path.join(publicDir, 'index.html');
    return res.sendFile(indexPath, (err) => {
      if (err) {
        console.warn('⚠️ Failed to send index.html:', err.message);
        if (!res.headersSent) {
          res.status(500).send('Failed to load frontend');
        }
      }
    });
  }

  res.json({
    message: 'DomusGest Database Server',
    status: 'Running',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      login: 'POST /api/login',
      changePassword: 'POST /api/change-password',
      users: 'GET /api/users'
    },
    database: 'SQLite',
    timestamp: new Date().toISOString()
  });
});

if (hasPublicDir) {
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();

    const indexPath = path.join(publicDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.warn('⚠️ Failed to send SPA fallback index.html:', err.message);
        if (!res.headersSent) {
          res.status(500).send('Failed to load frontend');
        }
      }
    });
  });
}

// Admin login endpoint
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username e password são obrigatórios' });
  }

  const sql = 'SELECT * FROM admins WHERE username = ?';
  db.get(sql, [username.trim()], async (err, admin) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ error: 'Erro na base de dados' });
    }

    if (!admin) {
      return res.status(401).json({ error: 'Credenciais de administrador inválidas' });
    }

    try {
      const isPasswordValid = await bcrypt.compare(password, admin.password);
      
      if (isPasswordValid) {
        // Don't send password in response but include scope and allowed_condominiums
        const { password: _, ...adminWithoutPassword } = admin;
        res.json({
          success: true,
          message: 'Login de administrador realizado com sucesso',
          admin: adminWithoutPassword,
          isAdmin: true
        });
      } else {
        res.status(401).json({ error: 'Credenciais de administrador inválidas' });
      }
    } catch (error) {
      console.error('Error comparing admin password:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });
});

// Get admin messages for a user (messages targeted to any condominium the user belongs to)
app.get('/api/users/:id/admin-messages', (req, res) => {
  const userId = req.params.id;
  // Find condominiums for user
  const sql = `
    SELECT am.id, am.admin_id, am.title, am.body, am.type, am.created_at
    FROM admin_messages am
    JOIN admin_message_targets amt ON amt.message_id = am.id
    JOIN user_condominiums uc ON uc.condominium_id = amt.condominium_id
    WHERE uc.user_id = ?
    GROUP BY am.id
    ORDER BY am.created_at DESC
  `;

  db.all(sql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error fetching admin messages' });

    // Attach files metadata for each message
    const getFilesSql = 'SELECT id, filename, original_filename, mime_type, file_size FROM admin_message_files WHERE message_id = ?';
    const results = [];
    let pending = rows.length;
    if (pending === 0) return res.json([]);
    rows.forEach(r => {
      db.all(getFilesSql, [r.id], (fErr, files) => {
        if (fErr) files = [];
        results.push({ ...r, files: files || [] });
        pending -= 1;
        if (pending === 0) res.json(results);
      });
    });
  });
});

// Get a specific admin message for a user (ensures condominium membership)
app.get('/api/users/:userId/admin-messages/:messageId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const messageId = parseInt(req.params.messageId, 10);

  if (Number.isNaN(userId) || Number.isNaN(messageId)) {
    return res.status(400).json({ error: 'Invalid user or message id' });
  }

  const sql = `
    SELECT 
      am.id,
      am.admin_id,
      am.title,
      am.body,
      am.type,
      am.created_at,
      GROUP_CONCAT(DISTINCT c.id) AS condominium_ids,
      GROUP_CONCAT(DISTINCT c.name) AS condominium_names
    FROM admin_messages am
    JOIN admin_message_targets amt ON amt.message_id = am.id
    JOIN user_condominiums uc ON uc.condominium_id = amt.condominium_id
    JOIN condominiums c ON c.id = amt.condominium_id
    WHERE uc.user_id = ? AND am.id = ?
    GROUP BY am.id
  `;

  db.get(sql, [userId, messageId], (err, message) => {
    if (err) {
      console.error('Error fetching admin message detail:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!message) {
      return res.status(404).json({ error: 'Mensagem não encontrada' });
    }

    const getFilesSql = 'SELECT id, filename, original_filename, mime_type, file_size, uploaded_at FROM admin_message_files WHERE message_id = ? ORDER BY uploaded_at DESC';
    db.all(getFilesSql, [message.id], (fileErr, files) => {
      if (fileErr) {
        console.error('Error fetching admin message files:', fileErr.message);
        return res.status(500).json({ error: 'Database error' });
      }

      const condoIds = message.condominium_ids ? message.condominium_ids.split(',').map(Number) : [];
      const condoNames = message.condominium_names ? message.condominium_names.split(',') : [];
      res.json({
        id: message.id,
        admin_id: message.admin_id,
        title: message.title,
        body: message.body,
        type: message.type,
        created_at: message.created_at,
        condominiums: condoIds.map((id, idx) => ({ id, name: condoNames[idx] })),
        files: files || []
      });
    });
  });
});

// Get messages (admin view) - admins can see messages they sent; full-scope admins see all
app.get('/api/admin/messages', (req, res) => {
  const adminIdHdr = req.headers['admin-id'];
  const adminPermissions = req.headers['admin-permissions'];
  const { type, status } = req.query;

  // If the request is for user messages (complaints/requests), handle here
  if (type === 'complaint' || type === 'request') {
    // This branch returns rows from user_messages table filtered by admin permissions
    const adminPerm = adminPermissions;
    let sql = `
      SELECT 
        m.id, m.user_id, m.condominium_id, m.type, m.subject, m.message, m.status,
        m.admin_response, m.admin_id, m.created_at, m.updated_at,
        u.nome as user_name,
        c.name as condominium_name
      FROM user_messages m
      JOIN users u ON m.user_id = u.id
      JOIN condominiums c ON m.condominium_id = c.id
    `;
    const params = [];
    const conditions = [];

    if (adminPerm) {
      try {
        const permissions = JSON.parse(adminPerm);
        if (permissions.scope === 'limited') {
          const allowedIds = normalizeAllowedCondominiums(permissions.allowed_condominiums);
          if (allowedIds && allowedIds.length > 0) {
            const placeholders = allowedIds.map(() => '?').join(',');
            conditions.push(`m.condominium_id IN (${placeholders})`);
            params.push(...allowedIds.map(x => Number(x)));
          } else {
            return res.json([]);
          }
        }
      } catch (e) {
        console.error('Error parsing admin permissions for user messages:', e && e.message);
        return res.status(400).json({ error: 'Invalid admin permissions format' });
      }
    }

    if (type) {
      conditions.push('m.type = ?');
      params.push(type === 'complaint' ? 'complaint' : 'request');
    }

    if (status) {
      conditions.push('m.status = ?');
      params.push(status);
    }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY m.created_at DESC';

    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Error fetching admin user messages:', err && err.message);
        return res.status(500).json({ error: 'Database error fetching messages' });
      }
      return res.json(rows || []);
    });
    return;
  }

  // Otherwise handle admin->user messages (admin_messages)
  // If no admin-info provided, deny
  if (!adminIdHdr && !adminPermissions) return res.status(400).json({ error: 'admin-id header or admin-permissions required' });

  // Determine permissions robustly
  let isFull = false;
  let allowedCondos = [];
  let adminId = adminIdHdr ? parseInt(adminIdHdr, 10) : null;
  if (adminPermissions) {
    try {
      const p = JSON.parse(adminPermissions);
      if (p.scope === 'full') isFull = true;
      if (p.scope === 'limited') {
        // Normalize values to numeric IDs
        allowedCondos = normalizeAllowedCondominiums(p.allowed_condominiums || p.allowedCondos || []);
      }
      console.log('🔐 /api/admin/messages parsed permissions:', { scope: p.scope, allowedCondos });
    } catch (e) {
      console.warn('Warning: could not parse admin-permissions header', e && e.message);
    }
  }

  // Build SQL for admin_messages
  let sql = `
    SELECT am.id, am.admin_id, am.title, am.body, am.type, am.created_at
    FROM admin_messages am
  `;
  const params = [];

  if (isFull) {
    sql += ` ORDER BY am.created_at DESC`;
  } else if (Array.isArray(allowedCondos) && allowedCondos.length > 0) {
    // Return messages that target any allowed condos OR messages sent by this admin
    const placeholders = allowedCondos.map(() => '?').join(',');
    sql += `
      JOIN admin_message_targets amt ON amt.message_id = am.id
      WHERE amt.condominium_id IN (${placeholders}) OR am.admin_id = ?
      GROUP BY am.id
      ORDER BY am.created_at DESC
    `;
    params.push(...allowedCondos.map(x => Number(x)));
    params.push(adminId);
  } else if (adminId) {
    // limited with no allowed condos (fallback) - show only messages sent by this admin
    sql += ` WHERE am.admin_id = ? ORDER BY am.created_at DESC`;
    params.push(adminId);
  } else {
    return res.status(403).json({ error: 'No permissions to view messages' });
  }

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error fetching admin messages' });

    // Attach files for each message
    const getFilesSql = 'SELECT id, filename, original_filename, mime_type, file_size FROM admin_message_files WHERE message_id = ?';
    const results = [];
    let pending = rows.length;
    if (pending === 0) return res.json([]);
    rows.forEach(r => {
      db.all(getFilesSql, [r.id], (fErr, files) => {
        if (fErr) files = [];
        results.push({ ...r, files: files || [] });
        pending -= 1;
        if (pending === 0) res.json(results);
      });
    });
  });
});

// Serve admin message file
app.get('/api/admin/messages/:id/files/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  db.get('SELECT * FROM admin_message_files WHERE id = ?', [fileId], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'File not found' });
    const absPath = path.resolve(row.file_path);
    const mime = row.mime_type || 'application/octet-stream';
    // Set inline disposition so browsers can open PDFs/images directly
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${row.original_filename.replace(/\"/g, '')}"`);
    res.sendFile(absPath, (sendErr) => {
      if (sendErr) console.error('Error sending file', sendErr);
    });
  });
});

// Maintenance login endpoint
app.post('/api/maintenance/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username e password são obrigatórios' });
  }

  const sql = 'SELECT * FROM maintenance_users WHERE username = ?';
  db.get(sql, [username.trim()], async (err, maintenance) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ error: 'Erro na base de dados' });
    }

    if (!maintenance) {
      return res.status(401).json({ error: 'Credenciais de manutenção inválidas' });
    }

    try {
      const isPasswordValid = await bcrypt.compare(password, maintenance.password);
      
      if (isPasswordValid) {
        // Don't send password in response
        const { password: _, ...maintenanceWithoutPassword } = maintenance;
        res.json({
          success: true,
          message: 'Login de manutenção realizado com sucesso',
          maintenance: maintenanceWithoutPassword,
          isMaintenance: true
        });
      } else {
        res.status(401).json({ error: 'Credenciais de manutenção inválidas' });
      }
    } catch (error) {
      console.error('Error comparing maintenance password:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });
});

// Get all users (for admin purposes only, filtered by admin permissions)
app.get('/api/users', (req, res) => {
  // Check if admin permissions are provided via headers or query
  const adminPermissions = req.headers['admin-permissions'] || req.query.adminPermissions;
  
  console.log('🔍 /api/users endpoint called');
  console.log('   admin-permissions header:', adminPermissions);
  
  let sql;
  let params = [];
  
  // If admin has limited scope, filter by allowed condominiums
  if (adminPermissions) {
    try {
      const permissions = JSON.parse(adminPermissions);
      console.log('   Parsed permissions:', permissions);
      
      if (permissions.scope === 'limited' && permissions.allowed_condominiums) {
        const allowedIds = permissions.allowed_condominiums; // Already an array, don't parse again
        console.log('   Filtering by allowed condominiums:', allowedIds);
        const placeholders = allowedIds.map(() => '?').join(',');
        
        // Only show users who have at least one condominium in the allowed list
        sql = `
          SELECT 
            u.*,
            GROUP_CONCAT(c.name) as condominiums,
            GROUP_CONCAT(c.id || ':' || c.name || ':' || COALESCE(uc.apartment, '')) as condominium_details
          FROM users u
          INNER JOIN user_condominiums uc ON u.id = uc.user_id
          INNER JOIN condominiums c ON uc.condominium_id = c.id
          WHERE uc.condominium_id IN (${placeholders})
          GROUP BY u.id
          ORDER BY u.nome
        `;
        params = allowedIds;
      } else {
        // Full access admin - show all users
        console.log('   Admin has full access - showing all users');
        sql = `
          SELECT 
            u.*,
            GROUP_CONCAT(c.name) as condominiums,
            GROUP_CONCAT(c.id || ':' || c.name || ':' || COALESCE(uc.apartment, '')) as condominium_details
          FROM users u
          LEFT JOIN user_condominiums uc ON u.id = uc.user_id
          LEFT JOIN condominiums c ON uc.condominium_id = c.id
          GROUP BY u.id
          ORDER BY u.nome
        `;
      }
    } catch (error) {
      console.error('Error parsing admin permissions:', error);
      // Fallback to showing all users
      sql = `
        SELECT 
          u.*,
          GROUP_CONCAT(c.name) as condominiums,
          GROUP_CONCAT(c.id || ':' || c.name || ':' || COALESCE(uc.apartment, '')) as condominium_details
        FROM users u
        LEFT JOIN user_condominiums uc ON u.id = uc.user_id
        LEFT JOIN condominiums c ON uc.condominium_id = c.id
        GROUP BY u.id
        ORDER BY u.nome
      `;
    }
  } else {
    // No admin permissions header - show all users
    console.log('   No admin permissions header - showing all users');
    sql = `
      SELECT 
        u.*,
        GROUP_CONCAT(c.name) as condominiums,
        GROUP_CONCAT(c.id || ':' || c.name || ':' || COALESCE(uc.apartment, '')) as condominium_details
      FROM users u
      LEFT JOIN user_condominiums uc ON u.id = uc.user_id
      LEFT JOIN condominiums c ON uc.condominium_id = c.id
      GROUP BY u.id
      ORDER BY u.nome
    `;
  }
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching users:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      // Don't send passwords in the response and format condominium data
      const usersWithoutPasswords = rows.map(user => {
        const { password, condominium_details, ...userWithoutPassword } = user;
        
        // Parse condominium details
        const condominiumList = [];
        if (condominium_details && condominium_details.trim() !== '') {
          const details = condominium_details.split(',');
          details.forEach(detail => {
            const [id, name, apartment] = detail.split(':');
            if (id && name && id !== 'null' && name !== 'null') {
              condominiumList.push({
                id: parseInt(id),
                name: name,
                apartment: apartment || ''
              });
            }
          });
        }
        
        // Debug logging for the problematic user
        if (user.nif === '501460888') {
          console.log('🔍 DEBUG - User 501460888:');
          console.log('   Raw condominium_details:', condominium_details);
          console.log('   Parsed condominiumList:', condominiumList);
          console.log('   condominiumList length:', condominiumList.length);
        }
        
        return {
          ...userWithoutPassword,
          condominiumsList: condominiumList
        };
      });
      res.json(usersWithoutPasswords);
    }
  });
});

// Search users by NIF or name (respects admin-permissions header)
app.get('/api/users/search', (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const adminPermissions = req.headers['admin-permissions'] || req.query.adminPermissions;

  if (!search) return res.json([]);

  console.log('🔎 /api/users/search called with:', search);
  console.log('   admin-permissions header:', adminPermissions);

  try {
    let params = [];
    let whereClause = '(u.nif = ? OR u.nome LIKE ?)';
    params.push(search, `%${search}%`);

    if (adminPermissions) {
      try {
        const permissions = JSON.parse(adminPermissions);
        if (permissions.scope === 'limited' && Array.isArray(permissions.allowed_condominiums) && permissions.allowed_condominiums.length > 0) {
          const allowed = permissions.allowed_condominiums;
          const placeholders = allowed.map(() => '?').join(',');
          whereClause += ` AND uc.condominium_id IN (${placeholders})`;
          params = params.concat(allowed);
        }
      } catch (err) {
        console.error('Error parsing admin-permissions in /api/users/search:', err);
      }
    }

    const sql = `
      SELECT 
        u.*, 
        GROUP_CONCAT(c.name) as condominiums,
        GROUP_CONCAT(c.id || ':' || c.name || ':' || COALESCE(uc.apartment, '')) as condominium_details
      FROM users u
      LEFT JOIN user_condominiums uc ON u.id = uc.user_id
      LEFT JOIN condominiums c ON uc.condominium_id = c.id
      WHERE ${whereClause}
      GROUP BY u.id
      ORDER BY u.nome
    `;

    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Error searching users:', err.message);
        return res.status(500).json({ error: 'Database error' });
      }

      const usersWithoutPasswords = rows.map(user => {
        const { password, condominium_details, ...userWithoutPassword } = user;
        const condominiumList = [];
        if (condominium_details && condominium_details.trim() !== '') {
          const details = condominium_details.split(',');
          details.forEach(detail => {
            const [id, name, apartment] = detail.split(':');
            if (id && name && id !== 'null' && name !== 'null') {
              condominiumList.push({ id: parseInt(id), name: name, apartment: apartment || '' });
            }
          });
        }
        return { ...userWithoutPassword, condominiumsList: condominiumList };
      });

      res.json(usersWithoutPasswords);
    });
  } catch (err) {
    console.error('Unexpected error in /api/users/search:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user by ID (for admin purposes only)
app.get('/api/users/:id', (req, res) => {
  console.log('🔍 /api/users/:id endpoint called, id=', req.params.id);

  // Support a query search parameter for quick lookup across names/NIFs
  const search = req.query.search;
  if (search) {
    const q = `%${search.trim()}%`;
    const sql = `SELECT * FROM users WHERE nome LIKE ? OR nif LIKE ? ORDER BY nome`;
    db.all(sql, [q, q], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      const users = rows.map(u => { const { password, ...rest } = u; return rest; });
      return res.json(users);
    });
    return;
  }

  // If caller explicitly wants the full list, support /api/users/all or /api/users/list
  const idParam = req.params.id;
  if (idParam === 'all' || idParam === 'list') {
    const sql = 'SELECT * FROM users ORDER BY nome';
    db.all(sql, [], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      const users = rows.map(u => { const { password, ...rest } = u; return rest; });
      return res.json(users);
    });
    return;
  }

  // Otherwise treat :id as a numeric user id
  const userId = parseInt(idParam, 10);
  if (isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const sql = 'SELECT * FROM users WHERE id = ?';
  db.get(sql, [userId], (err, user) => {
    if (err) {
      console.error('Error fetching user:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!user) return res.status(404).json({ error: 'Utilizador não encontrado' });

    // Don't send password in the response and format condominium data
    const { password, condominium_details, ...userWithoutPassword } = user;
    const condominiumList = [];

    // 1) Parse denormalized `condominium_details` if present
    if (condominium_details) {
      const details = condominium_details.split(',').map(s => s.trim()).filter(Boolean);
      details.forEach(detail => {
        const [id, name, apartment] = detail.split(':');
        if (id && name) {
          const parsedId = parseInt(id, 10);
          const condoObj = { id: parsedId, name: name, apartment: apartment || '' };
          // Provide Portuguese keys expected by frontend (`nome`, `apartamento`) while
          // keeping English keys for backward compatibility.
          condoObj.nome = condoObj.name;
          condoObj.apartamento = condoObj.apartment;
          condominiumList.push(condoObj);
        }
      });
    }

    // 2) Also query normalized `user_condominiums` table and join with `condominiums`
    //    to include associations created via the normalized model.
    const joinSql = `
      SELECT c.id as id, COALESCE(c.name, c.nome) as name, uc.apartment as apartment
      FROM user_condominiums uc
      JOIN condominiums c ON uc.condominium_id = c.id
      WHERE uc.user_id = ?
    `;

    db.all(joinSql, [userId], (err2, rows) => {
      if (err2) {
        console.error('Error fetching user_condominiums for user', userId, err2.message);
        // Return what we have from condominium_details even if this fails
        return res.json({ ...userWithoutPassword, condominiumsList: condominiumList });
      }

      // Merge rows into condominiumList, avoid duplicates by id
      rows.forEach(r => {
        const existing = condominiumList.find(c => c.id === r.id);
        if (!existing) {
          const condoObj = { id: r.id, name: r.name || '', apartment: r.apartment || '' };
          condoObj.nome = condoObj.name;
          condoObj.apartamento = condoObj.apartment;
          condominiumList.push(condoObj);
        } else {
          // If existing has no apartment, prefer the one from user_condominiums
          if ((!existing.apartment || existing.apartment === '') && r.apartment) {
            existing.apartment = r.apartment;
            existing.apartamento = r.apartment;
          }
        }
      });

      return res.json({ ...userWithoutPassword, condominiumsList: condominiumList });
    });
  });
});

// Update user by ID (for admin purposes only)
app.put('/api/users/:id', async (req, res) => {
  const userId = req.params.id;
  const userData = req.body;
  
  try {
    // Build the UPDATE query dynamically based on provided fields
    const updateFields = [];
    const updateValues = [];
    
    // List of allowed fields to update
    const allowedFields = [
      'nome', 'nif', 'telemovel', 'telefone', 'permite_telefone',
      'email1', 'email2', 'email3', 'permite_email', 'conjuge', 
      'data_criacao', 'data_alteracao'
    ];
    
    // Add fields to update
    allowedFields.forEach(field => {
      if (userData[field] !== undefined) {
        updateFields.push(`${field} = ?`);
        updateValues.push(userData[field]);
      }
    });
    
    // Handle password update separately if provided
    if (userData.newPassword && userData.newPassword.trim() !== '') {
      const hashedPassword = await bcrypt.hash(userData.newPassword, 10);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }
    
    // Add updated timestamp
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(userId);
    
    if (updateFields.length === 1) { // Only timestamp was added
      return res.status(400).json({ error: 'Nenhum campo válido para atualizar' });
    }
    
    const sql = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
    
    db.run(sql, updateValues, function(err) {
      if (err) {
        console.error('Error updating user:', err.message);
        if (err.message.includes('UNIQUE constraint failed')) {
          res.status(400).json({ error: 'NIF já existe na base de dados' });
        } else {
          res.status(500).json({ error: 'Erro ao atualizar utilizador' });
        }
      } else if (this.changes === 0) {
        res.status(404).json({ error: 'Utilizador não encontrado' });
      } else {
        // Return updated user data
        db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
          if (err) {
            console.error('Error fetching updated user:', err.message);
            res.status(500).json({ error: 'Utilizador atualizado mas erro ao carregar dados' });
          } else {
            const { password, ...userWithoutPassword } = user;
            res.json({ 
              success: true, 
              message: 'Utilizador atualizado com sucesso',
              user: userWithoutPassword 
            });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error in user update:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { nif, password } = req.body;
  
  console.log(`🔐 Login attempt: NIF=${nif}, Password length=${password?.length}`);

  if (!nif || !password) {
    return res.status(400).json({ error: 'NIF e password são obrigatórios' });
  }

  const sql = 'SELECT * FROM users WHERE nif = ?';
  db.get(sql, [nif.toString().trim()], async (err, user) => {
    if (err) {
      console.error('🔥 Database error during user lookup:', err.message);
      return res.status(500).json({ error: 'Erro na base de dados' });
    }

    if (!user) {
      console.log(`❌ User not found for NIF: ${nif}`);
      return res.status(401).json({ error: 'NIF ou password incorretos' });
    }
    
    console.log(`👤 User found: ${user.nome} (ID: ${user.id})`);

    try {
      // For initial setup, passwords might be plain text from CSV
      // Check if password is hashed (starts with $2b$) or plain text
      let passwordMatch = false;
      
      if (user.password.startsWith('$2b$')) {
        // Password is hashed, use bcrypt
        passwordMatch = await bcrypt.compare(password, user.password);
      } else {
        // Password is plain text (from CSV import), compare directly
        passwordMatch = password === user.password;
        
        // If match, update to hashed password for security
        if (passwordMatch) {
          const hashedPassword = await bcrypt.hash(password, 10);
          const updateSql = 'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
          db.run(updateSql, [hashedPassword, user.id]);
          console.log(`Password hashed for user: ${user.nome}`);
        }
      }

      if (passwordMatch) {
        // Fetch condominiums for this user
        const condominiumsSql = `
          SELECT c.name as condominium_name, uc.apartment, c.id as condominium_id
          FROM user_condominiums uc 
          JOIN condominiums c ON uc.condominium_id = c.id 
          WHERE uc.user_id = ?
          ORDER BY c.name
        `;
        
        db.all(condominiumsSql, [user.id], (condErr, condominiums) => {
          if (condErr) {
            console.error('Error fetching condominiums:', condErr);
            return res.status(500).json({ error: 'Erro ao carregar informações do condomínio' });
          }
          
          // Format condominiums list
          const condominiumsList = condominiums.map(condo => ({
            id: condo.condominium_id,
            nome: condo.condominium_name,
            apartamento: condo.apartamento
          }));
          
          // Create a display string for backward compatibility
          const grupoDisplay = condominiums.length > 0 
            ? condominiums.map(c => `${c.condominium_name}${c.apartamento ? ` (${c.apartamento})` : ''}`).join(', ')
            : 'Não disponível';
          
          // Transform database fields to match frontend expectations
          const userForFrontend = {
            id: user.id,
            Grupo: grupoDisplay, // For backward compatibility
            condominiumsList: condominiumsList, // New field for multiple condominiums
            Nome: user.nome,
            NIF: user.nif,
            Telemóvel: user.telemovel,
            Telefone: user.telefone,
            'Permite telefone': user.permite_telefone,
            'E-mail 1': user.email1,
            'e-mail 1': user.email1, // Alternative format
            'E-mail 2': user.email2,
            'e-mail 2': user.email2, // Alternative format
            'E-mail 3': user.email3,
            'e-mail 3': user.email3, // Alternative format
            'Permite e-mail': user.permite_email,
            Cônjuge: user.conjuge,
            'Data de criação': user.data_criacao,
            'Data de alteração': user.data_alteracao,
            Telemovel: user.telemovel, // Alternative format without accent
            created_at: user.created_at,
            updated_at: user.updated_at
          };
          
          console.log(`✅ User login successful: ${user.nome} (NIF: ${user.nif}) with ${condominiums.length} condominium(s)`);
          if (condominiums.length > 1) {
            console.log(`🏢 Multiple condominiums: ${grupoDisplay}`);
          }
          
          res.json({ 
            success: true, 
            user: userForFrontend,
            message: 'Login efetuado com sucesso'
          });
        });
      } else {
        res.status(401).json({ error: 'NIF ou password incorretos' });
      }
    } catch (bcryptError) {
      console.error('Bcrypt error:', bcryptError);
      res.status(500).json({ error: 'Erro de autenticação' });
    }
  });
});

// Change password endpoint
app.post('/api/change-password', async (req, res) => {
  const { nif, currentPassword, newPassword } = req.body;

  if (!nif || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  const sql = 'SELECT * FROM users WHERE nif = ?';
  db.get(sql, [nif.toString().trim()], async (err, user) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ error: 'Erro na base de dados' });
    }

    if (!user) {
      return res.status(404).json({ error: 'Utilizador não encontrado' });
    }

    try {
      // Verify current password
      let currentPasswordMatch = false;
      
      if (user.password.startsWith('$2b$')) {
        currentPasswordMatch = await bcrypt.compare(currentPassword, user.password);
      } else {
        currentPasswordMatch = currentPassword === user.password;
      }

      if (!currentPasswordMatch) {
        return res.status(401).json({ error: 'Password atual incorreta' });
      }

      // Hash new password
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      
      // Update password in database
      const updateSql = 'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE nif = ?';
      db.run(updateSql, [hashedNewPassword, nif.toString().trim()], function(err) {
        if (err) {
          console.error('Error updating password:', err.message);
          res.status(500).json({ error: 'Erro ao atualizar password' });
        } else {
          console.log(`Password updated for user NIF: ${nif}`);
          res.json({ 
            success: true, 
            message: 'Password alterada com sucesso' 
          });
        }
      });

    } catch (bcryptError) {
      console.error('Bcrypt error:', bcryptError);
      res.status(500).json({ error: 'Erro ao processar password' });
    }
  });
});

// Add user endpoint (for importing from CSV)
app.post('/api/users', (req, res) => {
  const {
    grupo, nome, nif, telemovel, telefone, permite_telefone,
    email1, email2, email3, permite_email, conjuge,
    data_criacao, data_alteracao, password
  } = req.body;

  // Only NIF is mandatory; default nome and password if not provided
  if (!nif) {
    return res.status(400).json({ error: 'NIF é obrigatório' });
  }
  const finalNome = nome && nome.trim() ? nome.trim() : `Morador ${nif}`;
  const finalPassword = password && password.trim() ? password : '123456';

  const sql = `
    INSERT INTO users (
      grupo, nome, nif, telemovel, telefone, permite_telefone,
      email1, email2, email3, permite_email, conjuge,
      data_criacao, data_alteracao, password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const values = [
    grupo, finalNome, nif.toString().trim(), telemovel, telefone, permite_telefone,
    email1, email2, email3, permite_email, conjuge,
    data_criacao, data_alteracao, finalPassword
  ];

  db.run(sql, values, function(err) {
    if (err) {
      console.error('Error inserting user (full schema):', err.message);
      // Fallback: try minimal insert for older DB schemas
      const fallbackSql = `INSERT OR IGNORE INTO users (nome, nif, telemovel, telefone, password) VALUES (?, ?, ?, ?, ?)`;
      const fbValues = [nome, nif.toString().trim(), telemovel || '', telefone || '', password || '123456'];
      db.run(fallbackSql, fbValues, function(fbErr) {
        if (fbErr) {
          if (fbErr.message && fbErr.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Utilizador com este NIF já existe' });
          }
          console.error('Fallback insert also failed:', fbErr.message);
          return res.status(500).json({ error: 'Erro ao criar utilizador' });
        }
        console.log(`User created with ID (fallback): ${this.lastID}`);
        return res.status(201).json({ success: true, id: this.lastID, message: 'Utilizador criado com sucesso (fallback)' });
      });
    } else {
      console.log(`User created with ID: ${this.lastID}`);
      res.status(201).json({ 
        success: true, 
        id: this.lastID,
        message: 'Utilizador criado com sucesso'
      });
    }
  });
});

// Get single condominium
app.get('/api/condominiums/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid condominium id' });

  db.get('SELECT id, name, address, nif, nipc, created_at, updated_at FROM condominiums WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(404).json({ error: 'Condominium not found' });
    res.json({ success: true, condominium: row });
  });
});

// Delete condominium (admin only - check main admin)
app.delete('/api/condominiums/:id', async (req, res) => {
  const isMain = await checkIsMainAdmin(req);
  if (!isMain) return res.status(403).json({ error: 'Apenas o admin principal pode apagar condominios' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid condominium id' });

  db.run('DELETE FROM condominiums WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Condominium not found' });
    res.json({ success: true, deleted: id });
  });
});

// Import CSV data endpoint
app.post('/api/import-csv', (req, res) => {
  const { users } = req.body;

  if (!users || !Array.isArray(users)) {
    return res.status(400).json({ error: 'Dados de utilizadores inválidos' });
  }

  let imported = 0;
  let errors = 0;

  const importUser = (index) => {
    if (index >= users.length) {
      return res.json({
        success: true,
        message: `Importação concluída: ${imported} utilizadores importados, ${errors} erros`,
        imported,
        errors
      });
    }

    const user = users[index];
    const sql = `
      INSERT OR IGNORE INTO users (
        grupo, nome, nif, telemovel, telefone, permite_telefone,
        email1, email2, email3, permite_email, conjuge,
        data_criacao, data_alteracao, password
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      user.Grupo || '', user.Nome || '', (user.NIF || '').toString().trim(),
      user.Telemovel || '', user.Telefone || '', user['Permite telefone'] || '',
      user['e-mail 1'] || '', user['e-mail 2'] || '', user['e-mail 3'] || '',
      user['Permite e-mail'] || '', user.Cônjuge || '',
      user['Data de criação'] || '', user['Data de alteração'] || '',
      user.Password || '123456' // Default password if none provided
    ];

    db.run(sql, values, function(err) {
      if (err) {
        console.error(`Error importing user ${user.Nome}:`, err.message);
        errors++;
      } else if (this.changes > 0) {
        imported++;
        console.log(`Imported user: ${user.Nome}`);
      }
      importUser(index + 1);
    });
  };

  importUser(0);
});

// Enhanced CSV import with proper condominium handling
app.post('/api/import-csv-enhanced', (req, res) => {
  const { users } = req.body;
  
  if (!users || !Array.isArray(users)) {
    return res.status(400).json({ error: 'Dados de utilizadores inválidos' });
  }

  // First, collect all unique condominiums
  const condominiums = new Set();
  const userCondominiumMap = new Map();

  users.forEach(user => {
    const grupo = user.Grupo ? user.Grupo.toString().trim() : '';
    if (grupo) {
      // Extract condominium name from grupo field
      const condoName = grupo.split(' - ')[0] || grupo;
      const apartment = grupo.includes(' - ') ? grupo.split(' - ')[1] : '';
      
      condominiums.add(condoName);
      
      const nif = (user.NIF || '').toString().trim();
      if (!userCondominiumMap.has(nif)) {
        userCondominiumMap.set(nif, []);
      }
      userCondominiumMap.get(nif).push({
        condoName,
        apartment,
        userData: user
      });
    }
  });

  let importedUsers = 0;
  let importedCondos = 0;
  let importedRelations = 0;
  let errors = 0;

  // Step 1: Insert condominiums
  const condoArray = Array.from(condominiums);
  let condoIndex = 0;

  const insertCondominiums = () => {
    if (condoIndex >= condoArray.length) {
      // Step 2: Insert users (deduplicated by NIF)
      const uniqueUsers = new Map();
      users.forEach(user => {
        const nif = (user.NIF || '').toString().trim();
        if (nif && !uniqueUsers.has(nif)) {
          uniqueUsers.set(nif, user);
        }
      });

      const userArray = Array.from(uniqueUsers.values());
      let userIndex = 0;

      const insertUsers = () => {
        if (userIndex >= userArray.length) {
          // Step 3: Insert user-condominium relationships
          const relationships = [];
          userCondominiumMap.forEach((condos, nif) => {
            condos.forEach(condo => {
              relationships.push({ nif, ...condo });
            });
          });

          let relationIndex = 0;
          const insertRelationships = () => {
            if (relationIndex >= relationships.length) {
              return res.json({
                success: true,
                message: `Importação concluída: ${importedUsers} utilizadores, ${importedCondos} condomínios, ${importedRelations} relações, ${errors} erros`,
                importedUsers,
                importedCondos,
                importedRelations,
                errors
              });
            }

            const relation = relationships[relationIndex];
            
            // Get user and condominium IDs
            const getUserSql = 'SELECT id FROM users WHERE nif = ?';
            const getCondoSql = 'SELECT id FROM condominiums WHERE name = ?';
            
            db.get(getUserSql, [relation.nif], (err, user) => {
              if (err || !user) {
                console.error(`User not found for NIF ${relation.nif}`);
                errors++;
                relationIndex++;
                return insertRelationships();
              }

              db.get(getCondoSql, [relation.condoName], (err, condo) => {
                if (err || !condo) {
                  console.error(`Condominium not found: ${relation.condoName}`);
                  errors++;
                  relationIndex++;
                  return insertRelationships();
                }

                const insertRelationSql = `
                  INSERT OR IGNORE INTO user_condominiums (user_id, condominium_id, apartment, role)
                  VALUES (?, ?, ?, 'resident')
                `;

                db.run(insertRelationSql, [user.id, condo.id, relation.apartment || ''], function(err) {
                  if (err) {
                    console.error(`Error inserting relationship for ${relation.nif}:`, err.message);
                    errors++;
                  } else if (this.changes > 0) {
                    importedRelations++;
                  }
                  
                  relationIndex++;
                  insertRelationships();
                });
              });
            });
          };

          insertRelationships();
          return;
        }

        const user = userArray[userIndex];
        const sql = `
          INSERT OR IGNORE INTO users (
            grupo, nome, nif, telemovel, telefone, permite_telefone,
            email1, email2, email3, permite_email, conjuge,
            data_criacao, data_alteracao, password
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
          user.Grupo || '', user.Nome || '', (user.NIF || '').toString().trim(),
          user.Telemovel || '', user.Telefone || '', user['Permite telefone'] || '',
          user['e-mail 1'] || '', user['e-mail 2'] || '', user['e-mail 3'] || '',
          user['Permite e-mail'] || '', user.Cônjuge || '',
          user['Data de criação'] || '', user['Data de alteração'] || '',
          user.Password || 'Teste' // Default password
        ];

        db.run(sql, values, function(err) {
          if (err) {
            console.error(`Error importing user ${user.Nome}:`, err.message);
            errors++;
          } else if (this.changes > 0) {
            importedUsers++;
            console.log(`Imported user: ${user.Nome}`);
          }
          
          userIndex++;
          insertUsers();
        });
      };

      insertUsers();
      return;
    }

    const condoName = condoArray[condoIndex];
    const insertCondoSql = 'INSERT OR IGNORE INTO condominiums (name) VALUES (?)';
    
    db.run(insertCondoSql, [condoName], function(err) {
      if (err) {
        console.error(`Error inserting condominium ${condoName}:`, err.message);
        errors++;
      } else if (this.changes > 0) {
        importedCondos++;
        console.log(`Imported condominium: ${condoName}`);
      }
      
      condoIndex++;
      insertCondominiums();
    });
  };

  insertCondominiums();
});

// Reset all data and reimport
app.post('/api/reset-and-import', (req, res) => {
  const { users } = req.body;
  
  if (!users || !Array.isArray(users)) {
    return res.status(400).json({ error: 'Dados de utilizadores inválidos' });
  }

  // Clear all tables
  const clearTables = [
    'DELETE FROM user_condominiums',
    'DELETE FROM user_messages', 
    'DELETE FROM assembleia_files',
    'DELETE FROM assembleias',
    'DELETE FROM users',
    'DELETE FROM condominiums'
  ];

  let clearIndex = 0;
  const clearNext = () => {
    if (clearIndex >= clearTables.length) {
      // Now import with enhanced method
      req.url = '/api/import-csv-enhanced';
      return app._router.handle(req, res);
    }

    db.run(clearTables[clearIndex], (err) => {
      if (err) {
        console.error(`Error clearing table: ${err.message}`);
      } else {
        console.log(`Cleared table: ${clearTables[clearIndex]}`);
      }
      clearIndex++;
      clearNext();
    });
  };

  clearNext();
});

// Health check endpoint
// Condominium management endpoints

// Get all condominiums (filtered by admin permissions if provided)
app.get('/api/condominiums', (req, res) => {
  // Check if admin permissions are provided via headers or query
  const adminPermissions = req.headers['admin-permissions'] || req.query.adminPermissions;
  
  console.log('🔍 /api/condominiums endpoint called');
  console.log('   admin-permissions header:', adminPermissions);
  
  let sql = 'SELECT * FROM condominiums';
  let params = [];
  
  // If admin has limited scope, filter by allowed condominiums
  if (adminPermissions) {
    try {
      const permissions = JSON.parse(adminPermissions);
      console.log('   Parsed permissions:', permissions);
      
      if (permissions.scope === 'limited' && permissions.allowed_condominiums) {
        const allowedIds = permissions.allowed_condominiums; // Already an array, don't parse again
        console.log('   Filtering condominiums by allowed ids:', allowedIds);
        const placeholders = allowedIds.map(() => '?').join(',');
        sql += ` WHERE id IN (${placeholders})`;
        params = allowedIds;
      } else {
        console.log('   Admin has full access - showing all condominiums');
      }
    } catch (error) {
      console.error('Error parsing admin permissions:', error);
    }
  } else {
    console.log('   No admin permissions header - showing all condominiums');
  }
  
  sql += ' ORDER BY name';
  console.log('   Final SQL:', sql);
  console.log('   Params:', params);
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching condominiums:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json(rows);
    }
  });
});

// Get user's condominiums
app.get('/api/users/:id/condominiums', (req, res) => {
  const userId = req.params.id;
  
  const sql = `
    SELECT c.id, c.name, uc.apartment, uc.role
    FROM user_condominiums uc
    JOIN condominiums c ON uc.condominium_id = c.id
    WHERE uc.user_id = ?
    ORDER BY c.name
  `;
  
  db.all(sql, [userId], (err, rows) => {
    if (err) {
      console.error('Error fetching user condominiums:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json(rows);
    }
  });
});

// Debug: return both denormalized `condominium_details` and normalized `user_condominiums` for a user
app.get('/api/debug/user-condos/:id', (req, res) => {
  const idParam = req.params.id;
  const userId = parseInt(idParam, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const result = { denormalized: [], normalized: [] };

  // 1) Recreate the denormalized `condominium_details` like the users-list queries do
  const denormSql = `
    SELECT
      GROUP_CONCAT(c.id || ':' || c.name || ':' || COALESCE(uc.apartment, '')) as condominium_details
    FROM users u
    LEFT JOIN user_condominiums uc ON u.id = uc.user_id
    LEFT JOIN condominiums c ON uc.condominium_id = c.id
    WHERE u.id = ?
    GROUP BY u.id
  `;

  db.get(denormSql, [userId], (err, row) => {
    if (err) {
      console.error('Error building denormalized condominium_details for debug endpoint:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (row && row.condominium_details) {
      const details = row.condominium_details.split(',').map(s => s.trim()).filter(Boolean);
      details.forEach(detail => {
        const [id, name, apartment] = detail.split(':');
        if (id && name) result.denormalized.push({ id: parseInt(id, 10), name, apartment: apartment || '' });
      });
    }

    // 2) Fetch normalized associations
    const assocSql = `
      SELECT c.id, c.name, uc.apartment, uc.role
      FROM user_condominiums uc
      JOIN condominiums c ON uc.condominium_id = c.id
      WHERE uc.user_id = ?
      ORDER BY c.name
    `;

    db.all(assocSql, [userId], (err2, rows) => {
      if (err2) {
        console.error('Error fetching normalized user_condominiums for debug endpoint:', err2.message);
        return res.status(500).json({ error: 'Database error' });
      }
      result.normalized = rows || [];
      return res.json(result);
    });
  });
  });

// Remove user from condominium
app.delete('/api/users/:userId/condominiums/:condominiumId', (req, res) => {
  const { userId, condominiumId } = req.params;
  
  const sql = 'DELETE FROM user_condominiums WHERE user_id = ? AND condominium_id = ?';
  db.run(sql, [userId, condominiumId], function(err) {
    if (err) {
      console.error('Error removing user from condominium:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json({ 
        success: true, 
        message: 'User removed from condominium successfully',
        changes: this.changes 
      });
    }
  });
});

// Update user-condominium relationship
app.put('/api/users/:userId/condominiums/:condominiumId', (req, res) => {
  const { userId, condominiumId } = req.params;
  const { apartment, role } = req.body;
  
  const sql = 'UPDATE user_condominiums SET apartment = ?, role = ? WHERE user_id = ? AND condominium_id = ?';
  db.run(sql, [apartment || '', role || 'resident', userId, condominiumId], function(err) {
    if (err) {
      console.error('Error updating user-condominium relationship:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json({ 
        success: true, 
        message: 'User-condominium relationship updated successfully',
        changes: this.changes 
      });
    }
  });
});

// Get users by condominium
app.get('/api/condominiums/:id/users', (req, res) => {
  const condominiumId = req.params.id;
  const sql = `
    SELECT 
      u.*,
      uc.apartment,
      uc.role,
      uc.created_at as linked_at
    FROM users u
    JOIN user_condominiums uc ON u.id = uc.user_id
    WHERE uc.condominium_id = ?
    ORDER BY u.nome
  `;
  
  db.all(sql, [condominiumId], (err, rows) => {
    if (err) {
      console.error('Error fetching condominium users:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      // Remove passwords from response
      const usersWithoutPasswords = rows.map(user => {
        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
      });
      res.json(usersWithoutPasswords);
    }
  });
});

// Edit condominium info
app.put('/api/condominiums/:id', (req, res) => {
  const { id } = req.params;
  const { name, nipc, address, city, postal_code } = req.body;

  const updates = [];
  const params = [];

  if (typeof name !== 'undefined') { updates.push('name = ?'); params.push(name); }
  if (typeof nipc !== 'undefined') { updates.push('nipc = ?'); params.push(nipc); }
  if (typeof address !== 'undefined') { updates.push('address = ?'); params.push(address); }
  if (typeof city !== 'undefined') { updates.push('city = ?'); params.push(city); }
  if (typeof postal_code !== 'undefined') { updates.push('postal_code = ?'); params.push(postal_code); }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  const sql = `UPDATE condominiums SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  params.push(id);

  db.run(sql, params, function(err) {
    if (err) {
      console.error('Error updating condominium:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Condominium not found' });

    db.get('SELECT * FROM condominiums WHERE id = ?', [id], (err2, row) => {
      if (err2) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true, condominium: row });
    });
  });
});

// Create a user and link to condominium in one request (manual add)
app.post('/api/admin/condominiums/:id/users', (req, res) => {
  const condominiumId = parseInt(req.params.id, 10);
  const user = req.body || {};

  if (!user.nif) {
    return res.status(400).json({ error: 'Missing required user field: nif' });
  }

  // Allow nome optional; if not provided, use placeholder using NIF
  const nome = user.nome && user.nome.trim() ? user.nome.trim() : `Morador ${user.nif}`;
  const nif = (user.nif || '').toString().trim();

  // Try to insert user or find existing by NIF
  const insertSql = `INSERT OR IGNORE INTO users (nome, nif, telemovel, telefone, email1, email2, email3, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [nome, nif, user.telemovel || '', user.telefone || '', user.email1 || '', user.email2 || '', user.email3 || '', user.password || '123456'];

  db.run(insertSql, values, function(err) {
    if (err) {
      console.error('Error creating user:', err.message);
      return res.status(500).json({ error: 'Database error creating user' });
    }

    const finalize = (userId) => {
      db.run('INSERT OR IGNORE INTO user_condominiums (user_id, condominium_id, apartment, role) VALUES (?, ?, ?, ?)', [userId, condominiumId, user.apartment || '', user.role || 'resident'], function(err2) {
        if (err2) {
          console.error('Error linking user to condominium:', err2.message);
          return res.status(500).json({ error: 'Database error linking user to condominium' });
        }
        db.get('SELECT id, nome, nif, telemovel, telefone, email1 FROM users WHERE id = ?', [userId], (err3, row) => {
          if (err3) return res.status(500).json({ error: 'Database error' });
          res.status(201).json({ success: true, user: row });
        });
      });
    };

    if (this.lastID && this.lastID > 0) {
      // New user inserted
      finalize(this.lastID);
    } else {
      // User already existed, find by NIF
      db.get('SELECT id FROM users WHERE nif = ?', [nif], (e, row) => {
        if (e || !row) {
          console.error('Error finding existing user after insert:', e && e.message);
          return res.status(500).json({ error: 'Database error finding user' });
        }
        finalize(row.id);
      });
    }
  });
});

// Bulk import users for a condominium (accepts JSON array of users)
app.post('/api/admin/condominiums/:id/import-users', async (req, res) => {
  const condominiumId = parseInt(req.params.id, 10);
  const users = req.body.users;

  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'users must be a non-empty array' });
  }

  let imported = 0;
  let errors = 0;

  for (const user of users) {
    try {
      // Insert or ignore user
      const insertSql = `INSERT OR IGNORE INTO users (grupo, nome, nif, telemovel, telefone, permite_telefone, email1, email2, email3, permite_email, conjuge, data_criacao, data_alteracao, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const values = [user.grupo || '', user.nome || '', (user.nif || '').toString().trim(), user.telemovel || '', user.telefone || '', user.permite_telefone || '', user.email1 || '', user.email2 || '', user.email3 || '', user.permite_email || '', user.conjuge || '', user.data_criacao || null, user.data_alteracao || null, user.password || '123456'];

      const userId = await new Promise((resolve, reject) => {
        db.run(insertSql, values, function(err) {
          if (err) return reject(err);
          if (this.lastID) return resolve(this.lastID);
          // If insert ignored because exists, try to find by nif
          db.get('SELECT id FROM users WHERE nif = ?', [(user.nif || '').toString().trim()], (e, row) => {
            if (e) return reject(e);
            if (row && row.id) return resolve(row.id);
            return reject(new Error('Could not determine user id after insert'));
          });
        });
      });

      // Link to condominium
      await new Promise((resolve, reject) => {
        db.run('INSERT OR IGNORE INTO user_condominiums (user_id, condominium_id, apartment, role) VALUES (?, ?, ?, ?)', [userId, condominiumId, user.apartment || '', user.role || 'resident'], function(err) {
          if (err) return reject(err);
          resolve();
        });
      });

      imported++;
    } catch (e) {
      console.error('Error importing user for condominium:', e.message);
      errors++;
    }
  }

  res.json({ success: true, imported, errors });
});

// Assembleias endpoints
// Get all assembleias for a condominium
app.get('/api/condominiums/:id/assembleias', (req, res) => {
  const condominiumId = req.params.id;
  
  const sql = `
    WITH notes AS (
      SELECT an.condominium_id, GROUP_CONCAT(an.note, '||') as notes
      FROM admin_notes an
      WHERE an.created_at <= DATE('now')
      GROUP BY an.condominium_id
    )
    SELECT 
      a.*, 
      c.name as condominium_name,
      n.notes as admin_notes
    FROM assembleias a
    JOIN condominiums c ON a.condominium_id = c.id
    LEFT JOIN notes n ON n.condominium_id = a.condominium_id
    WHERE a.condominium_id = ?
    ORDER BY a.date ASC, a.time ASC
  `;
  
  db.all(sql, [condominiumId], (err, assembleias) => {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    res.json(assembleias);
  });
});

// Get all assembleias (for admin, filtered by admin permissions)
app.get('/api/assembleias', (req, res) => {
  // Check if admin permissions are provided via headers or query
  const adminPermissions = req.headers['admin-permissions'] || req.query.adminPermissions;
  
  console.log('🔍 /api/assembleias endpoint called');
  console.log('   admin-permissions header:', adminPermissions);
  
  let sql = `
    WITH notes AS (
      SELECT an.condominium_id, GROUP_CONCAT(an.note, '||') as notes
      FROM admin_notes an
      WHERE an.created_at <= DATE('now')
      GROUP BY an.condominium_id
    )
    SELECT 
      a.*, 
      c.name as condominium_name,
      n.notes as admin_notes
    FROM assembleias a
    JOIN condominiums c ON a.condominium_id = c.id
    LEFT JOIN notes n ON n.condominium_id = a.condominium_id
  `;
  let params = [];
  
  // If admin has limited scope, filter by allowed condominiums
  if (adminPermissions) {
    try {
      const permissions = JSON.parse(adminPermissions);
      console.log('   Parsed permissions:', permissions);
      
      if (permissions.scope === 'limited' && permissions.allowed_condominiums) {
        const allowedIds = permissions.allowed_condominiums; // Already an array, don't parse again
        console.log('   Filtering assembleias by allowed condominiums:', allowedIds);
        const placeholders = allowedIds.map(() => '?').join(',');
        sql += ` WHERE a.condominium_id IN (${placeholders})`;
        params = allowedIds;
      } else {
        console.log('   Admin has full access - showing all assembleias');
      }
    } catch (error) {
      console.error('Error parsing admin permissions:', error);
    }
  } else {
    console.log('   No admin permissions header - showing all assembleias');
  }
  
  sql += ' ORDER BY a.date ASC, a.time ASC';
  console.log('   Final SQL:', sql);
  console.log('   Params:', params);
  
  db.all(sql, params, (err, assembleias) => {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    console.log(`   Returning ${assembleias.length} assembleias`);
    res.json(assembleias);
  });
});

// User-facing assembleia endpoints: list assembleias for condominiums the user belongs to
// Next assembleia for a user
    let condoPrimary = null;
app.get('/users/:id/next-assembleia', (req, res) => {
  const userId = req.params.id;
  // Find condominiums for this user
  db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const condoIds = rows.map(r => r.condominium_id);
    if (!condoIds || condoIds.length === 0) return res.json(null);

    const placeholders = condoIds.map(() => '?').join(',');
    const sql = `
      WITH notes AS (
        SELECT an.condominium_id, GROUP_CONCAT(an.note, '||') as notes
        FROM admin_notes an
        WHERE an.created_at <= DATE('now')
        GROUP BY an.condominium_id
      )
      SELECT 
        a.*, 
        c.name as condominium_name,
        n.notes as admin_notes
      FROM assembleias a
      JOIN condominiums c ON a.condominium_id = c.id
      LEFT JOIN notes n ON n.condominium_id = a.condominium_id
    WHERE a.condominium_id IN (${placeholders})
    AND DATE(a.date) >= DATE('now')
    AND (a.status IS NULL OR a.status != 'completed')
      ORDER BY a.date ASC, a.time ASC
      LIMIT 1
    `;

    db.get(sql, condoIds, (err, assembleia) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(assembleia || null);
    });
  });
});

// All upcoming assembleias for a user
app.get('/users/:id/assembleias', (req, res) => {
  const userId = req.params.id;
  db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const condoIds = rows.map(r => r.condominium_id);
    if (!condoIds || condoIds.length === 0) return res.json([]);

    const placeholders = condoIds.map(() => '?').join(',');
    const sql = `
      WITH notes AS (
        SELECT an.condominium_id, GROUP_CONCAT(an.note, '||') as notes
        FROM admin_notes an
        WHERE an.created_at <= DATE('now')
        GROUP BY an.condominium_id
      )
      SELECT 
        a.*, 
        c.name as condominium_name,
        n.notes as admin_notes
      FROM assembleias a
      JOIN condominiums c ON a.condominium_id = c.id
      LEFT JOIN notes n ON n.condominium_id = a.condominium_id
      WHERE a.condominium_id IN (${placeholders})
        AND DATE(a.date) >= DATE('now')
        AND (a.status IS NULL OR a.status != 'completed')
      ORDER BY a.date ASC, a.time ASC
    `;

    db.all(sql, condoIds, (err, assembleias) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(assembleias || []);
    });
  });
});

// Previous assembleias for a user
app.get('/users/:id/assembleias-anteriores', (req, res) => {
  const userId = req.params.id;
  db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const condoIds = rows.map(r => r.condominium_id);
    if (!condoIds || condoIds.length === 0) return res.json([]);

    const placeholders = condoIds.map(() => '?').join(',');
    const sql = `
      WITH notes AS (
        SELECT an.condominium_id, GROUP_CONCAT(an.note, '||') as notes
        FROM admin_notes an
        WHERE an.created_at <= DATE('now')
        GROUP BY an.condominium_id
      )
      SELECT 
        a.*, 
        c.name as condominium_name,
        n.notes as admin_notes
      FROM assembleias a
      JOIN condominiums c ON a.condominium_id = c.id
      LEFT JOIN notes n ON n.condominium_id = a.condominium_id 
      WHERE a.condominium_id IN (${placeholders})
        AND (DATE(a.date) < DATE('now') OR a.status = 'completed')
      ORDER BY a.date DESC, a.time DESC
    `;

    db.all(sql, condoIds, (err, assembleias) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(assembleias || []);
    });
  });
});

// Alias API routes with /api prefix so frontend calls (e.g. /api/users/:id/...) work
app.get('/api/users/:id/next-assembleia', (req, res) => {
  const userId = req.params.id;
  db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const condoIds = rows.map(r => r.condominium_id);
    if (!condoIds || condoIds.length === 0) return res.json(null);

    const placeholders = condoIds.map(() => '?').join(',');
    const sql = `
      SELECT a.*, c.name as condominium_name
      FROM assembleias a
      JOIN condominiums c ON a.condominium_id = c.id
      WHERE a.condominium_id IN (${placeholders})
        AND DATE(a.date) >= DATE('now')
        AND (a.status IS NULL OR a.status != 'completed')
      ORDER BY a.date ASC, a.time ASC
      LIMIT 1
    `;

    db.get(sql, condoIds, (err, assembleia) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(assembleia || null);
    });
  });
});

app.get('/api/users/:id/assembleias', (req, res) => {
  const userId = req.params.id;
  db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const condoIds = rows.map(r => r.condominium_id);
    if (!condoIds || condoIds.length === 0) return res.json([]);

    const placeholders = condoIds.map(() => '?').join(',');
    const sql = `
      SELECT a.*, c.name as condominium_name
      FROM assembleias a
      JOIN condominiums c ON a.condominium_id = c.id
      WHERE a.condominium_id IN (${placeholders})
        AND DATE(a.date) >= DATE('now')
        AND (a.status IS NULL OR a.status != 'completed')
      ORDER BY a.date ASC, a.time ASC
    `;

    db.all(sql, condoIds, (err, assembleias) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(assembleias || []);
    });
  });
});

// Get assembleia detail for a user (with attached files)
app.get('/api/users/:userId/assembleias/:assembleiaId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const assembleiaId = parseInt(req.params.assembleiaId, 10);

  if (Number.isNaN(userId) || Number.isNaN(assembleiaId)) {
    return res.status(400).json({ error: 'Invalid user or assembleia id' });
  }

  const sql = `
    SELECT 
      a.*, 
      c.name AS condominium_name
    FROM assembleias a
    JOIN condominiums c ON a.condominium_id = c.id
    JOIN user_condominiums uc ON uc.condominium_id = a.condominium_id
    WHERE uc.user_id = ? AND a.id = ?
    LIMIT 1
  `;

  db.get(sql, [userId, assembleiaId], (err, assembleia) => {
    if (err) {
      console.error('Error fetching assembleia detail:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!assembleia) {
      return res.status(404).json({ error: 'Assembleia não encontrada' });
    }

    const filesSql = `
      SELECT id, assembleia_id, filename, original_filename, file_path, mime_type, file_size, uploaded_at
      FROM assembleia_files
      WHERE assembleia_id = ?
      ORDER BY uploaded_at DESC
    `;

    db.all(filesSql, [assembleiaId], (fileErr, files) => {
      if (fileErr) {
        console.error('Error fetching assembleia files:', fileErr.message);
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        ...assembleia,
        files: files || []
      });
    });
  });
});

// Get assembleia file detail (document) for a user
app.get('/api/users/:userId/documents/:fileId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const fileId = parseInt(req.params.fileId, 10);

  if (Number.isNaN(userId) || Number.isNaN(fileId)) {
    return res.status(400).json({ error: 'Invalid user or document id' });
  }

  const sql = `
    SELECT 
      f.id,
      f.assembleia_id,
      f.filename,
      f.original_filename,
      f.file_path,
      f.mime_type,
      f.file_size,
      f.uploaded_at,
      a.title AS assembleia_title,
      a.date AS assembleia_date,
      a.time AS assembleia_time,
      a.location AS assembleia_location,
      a.condominium_id,
      c.name AS condominium_name
    FROM assembleia_files f
    JOIN assembleias a ON f.assembleia_id = a.id
    JOIN condominiums c ON a.condominium_id = c.id
    JOIN user_condominiums uc ON uc.condominium_id = a.condominium_id
    WHERE uc.user_id = ? AND f.id = ?
    LIMIT 1
  `;

  db.get(sql, [userId, fileId], (err, file) => {
    if (err) {
      console.error('Error fetching assembleia document detail:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!file) {
      return res.status(404).json({ error: 'Documento não encontrado' });
    }

    res.json({
      ...file
    });
  });
});

app.get('/api/users/:id/assembleias-anteriores', (req, res) => {
  const userId = req.params.id;
  db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const condoIds = rows.map(r => r.condominium_id);
    if (!condoIds || condoIds.length === 0) return res.json([]);

    const placeholders = condoIds.map(() => '?').join(',');
    const sql = `
      SELECT a.*, c.name as condominium_name
      FROM assembleias a
      JOIN condominiums c ON a.condominium_id = c.id
      WHERE a.condominium_id IN (${placeholders})
        AND (DATE(a.date) < DATE('now') OR a.status = 'completed')
      ORDER BY a.date DESC, a.time DESC
    `;

    db.all(sql, condoIds, (err, assembleias) => {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      res.json(assembleias || []);
    });
  });
});

// Create new assembleia (with admin permission validation)
app.post('/api/assembleias', (req, res) => {
  const { condominium_id, title, description, date, time, location } = req.body;
  
  if (!condominium_id || !title || !date || !time) {
    return res.status(400).json({ error: 'Condominium ID, title, date, and time are required' });
  }
  
  // Check if admin permissions are provided and validate access to this condominium
  const adminPermissions = req.headers['admin-permissions'] || req.query.adminPermissions;
  
  console.log('🔍 /api/assembleias POST called for condominium:', condominium_id);
  console.log('   admin-permissions header:', adminPermissions);
  
  if (adminPermissions) {
    try {
      const permissions = JSON.parse(adminPermissions);
      console.log('   Parsed permissions:', permissions);
      
      if (permissions.scope === 'limited' && permissions.allowed_condominiums) {
        const allowedIds = permissions.allowed_condominiums; // Already an array, don't parse again
        console.log('   Allowed condominiums:', allowedIds);
        
        if (!allowedIds.includes(parseInt(condominium_id))) {
          console.log('   ❌ Access denied - condominium not in allowed list');
          return res.status(403).json({ error: 'Acesso negado. Não tem permissão para criar assembleias neste condomínio.' });
        } else {
          console.log('   ✅ Access granted - condominium in allowed list');
        }
      } else {
        console.log('   Admin has full access');
      }
    } catch (error) {
      console.error('Error parsing admin permissions:', error);
      return res.status(400).json({ error: 'Invalid admin permissions format' });
    }
  } else {
    console.log('   No admin permissions header - allowing access');
  }
  
  const sql = `
    INSERT INTO assembleias (condominium_id, title, description, date, time, location)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  
  db.run(sql, [condominium_id, title, description, date, time, location], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    const assembleiaId = this.lastID;
    
    // Return the created assembleia
    db.get('SELECT a.*, c.name as condominium_name FROM assembleias a JOIN condominiums c ON a.condominium_id = c.id WHERE a.id = ?', 
      [assembleiaId], async (err, assembleia) => {
        if (err) {
          return res.status(500).json({ error: 'Error retrieving created assembleia', details: err.message });
        }
        console.log('   ✅ Assembleia created successfully:', assembleia.title);
        try {
          const notificationId = await new Promise((resolve, reject) => {
            const notifSql = `INSERT INTO notifications 
              (type, title, message, related_id, condominium_id, created_at)
              VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
            const notifTitle = '📅 Nova Assembleia';
            const notifMessage = `${assembleia.condominium_name}: Assembleia marcada para ${assembleia.date} às ${assembleia.time}`;
            db.run(notifSql, ['assembleia', notifTitle, notifMessage, assembleiaId, assembleia.condominium_id], function(nErr) {
              if (nErr) return reject(nErr);
              resolve(this.lastID);
            });
          });

          // Link to admins responsible for the condominium
          const { adminIds } = await linkNotificationToAdminsByCondominiums(notificationId, [assembleia.condominium_id]);

          // Link to users of the condominium
          await new Promise((resolve, reject) => {
            linkNotificationToUsers(notificationId, [assembleia.condominium_id], (linkErr) => {
              if (linkErr) reject(linkErr);
              else resolve();
            });
          });

          // Notify admins via SSE
          if (adminIds && adminIds.length) {
            for (const aid of adminIds) {
              try {
                sendSseToAdmin(aid, 'notification_created', {
                  notification_id: notificationId,
                  type: 'assembleia',
                  related_id: assembleiaId
                });
              } catch (sseErr) {
                console.warn('Error broadcasting assembleia SSE to admin', aid, sseErr.message || sseErr);
              }
            }
          }
        } catch (notificationErr) {
          console.error('Error creating assembleia notification:', notificationErr);
        }

        res.status(201).json(assembleia);
      });
  });
});

// Update assembleia
app.put('/api/assembleias/:id', (req, res) => {
  const assembleiaId = req.params.id;
  const { title, description, date, time, location, status, admin_notes } = req.body;
  
  const sql = `
    UPDATE assembleias 
    SET title = ?, description = ?, date = ?, time = ?, location = ?, status = ?, admin_notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  
  db.run(sql, [title, description, date, time, location, status, admin_notes, assembleiaId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Assembleia not found' });
    }
    
    // Return the updated assembleia
    db.get('SELECT a.*, c.name as condominium_name FROM assembleias a JOIN condominiums c ON a.condominium_id = c.id WHERE a.id = ?', 
      [assembleiaId], (err, assembleia) => {
        if (err) {
          return res.status(500).json({ error: 'Error retrieving updated assembleia', details: err.message });
        }
        res.json(assembleia);
      });
  });
});

// Delete assembleia
app.delete('/api/assembleias/:id', (req, res) => {
  const assembleiaId = req.params.id;
  
  db.run('DELETE FROM assembleias WHERE id = ?', [assembleiaId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Assembleia not found' });
    }
    
    res.json({ success: true, message: 'Assembleia excluída com sucesso' });
  });
});

// Assembleia files endpoints
// List files for an assembleia
app.get('/api/assembleias/:id/files', (req, res) => {
  const assembleiaId = req.params.id;
  db.all('SELECT id, assembleia_id, filename, original_filename, file_path, mime_type, file_size, uploaded_at FROM assembleia_files WHERE assembleia_id = ? ORDER BY uploaded_at DESC', [assembleiaId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    res.json(rows || []);
  });
});

// Upload a file for an assembleia (PDF only)
app.post('/api/assembleias/:id/files', upload.single('file'), (req, res) => {
  const assembleiaId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filename = req.file.filename;
  const original = req.file.originalname;
  const filePath = req.file.path;
  const mime = req.file.mimetype;
  const size = req.file.size;

  const sql = `INSERT INTO assembleia_files (assembleia_id, filename, original_filename, file_path, mime_type, file_size) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [assembleiaId, filename, original, filePath, mime, size], function(err) {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    const id = this.lastID;
    db.get('SELECT id, assembleia_id, filename, original_filename, file_path, mime_type, file_size, uploaded_at FROM assembleia_files WHERE id = ?', [id], async (selectErr, row) => {
      if (selectErr) return res.status(500).json({ error: 'Database error', details: selectErr.message });

      try {
        const assembleia = await new Promise((resolve, reject) => {
          const assembleiaSql = `
            SELECT a.id, a.title, a.condominium_id, c.name AS condominium_name
            FROM assembleias a
            JOIN condominiums c ON a.condominium_id = c.id
            WHERE a.id = ?
            LIMIT 1
          `;
          db.get(assembleiaSql, [assembleiaId], (aErr, aRow) => {
            if (aErr) return reject(aErr);
            resolve(aRow);
          });
        });

        if (assembleia) {
          const notifTitle = '📎 Novo documento disponível';
          const notifMessage = `${assembleia.condominium_name}: Foi adicionado um documento à assembleia "${assembleia.title}".`;

          const notificationId = await new Promise((resolve, reject) => {
            const notifSql = `INSERT INTO notifications (type, title, message, related_id, condominium_id, created_at)
                              VALUES ('document', ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
            db.run(notifSql, [notifTitle, notifMessage, id, assembleia.condominium_id], function(notifErr) {
              if (notifErr) return reject(notifErr);
              resolve(this.lastID);
            });
          });

          await new Promise((resolve, reject) => {
            linkNotificationToUsers(notificationId, [assembleia.condominium_id], (linkErr) => {
              if (linkErr) return reject(linkErr);
              resolve();
            });
          });

          const { adminIds } = await linkNotificationToAdminsByCondominiums(notificationId, [assembleia.condominium_id]);
          if (Array.isArray(adminIds) && adminIds.length > 0) {
            adminIds.forEach((adminId) => {
              try {
                sendSseToAdmin(adminId, 'notification_created', {
                  notification_id: notificationId,
                  type: 'document',
                  related_id: id
                });
              } catch (sseErr) {
                console.warn('Error sending document SSE to admin', adminId, sseErr.message || sseErr);
              }
            });
          }
        }
      } catch (notifyErr) {
        console.error('Error creating document notification:', notifyErr.message || notifyErr);
      }

      res.status(201).json(row);
    });
  });
});

// Download a file
app.get('/api/assembleias/:assembleiaId/files/:fileId/download', (req, res) => {
  const fileId = req.params.fileId;
  db.get('SELECT file_path, original_filename, mime_type FROM assembleia_files WHERE id = ?', [fileId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    if (!row) return res.status(404).json({ error: 'File not found' });
    const absolutePath = row.file_path;
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.download(absolutePath, row.original_filename);
  });
});

// Delete a file
app.delete('/api/assembleias/:assembleiaId/files/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  db.get('SELECT file_path FROM assembleia_files WHERE id = ?', [fileId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    if (!row) return res.status(404).json({ error: 'File not found' });
    const absolutePath = row.file_path;
    db.run('DELETE FROM assembleia_files WHERE id = ?', [fileId], function(err) {
      if (err) return res.status(500).json({ error: 'Database error', details: err.message });
      // Attempt to remove file from disk but don't fail if unlink fails
      fs.unlink(absolutePath, (unlinkErr) => {
        if (unlinkErr) console.warn('Warning: failed to remove file from disk', unlinkErr.message);
        res.json({ success: true });
      });
    });
  });
});

// Get all messages for admin panel (complaints, requests)
app.get('/api/admin/messages', (req, res) => {
  const { type } = req.query;
  const adminPermissions = req.headers['admin-permissions'];

  console.log('🔍 /api/admin/messages endpoint called');
  console.log('   admin-permissions header:', adminPermissions);
  
  let sql = `
    SELECT 
      m.id, m.title, m.body, m.type, m.admin_id, m.created_at,
      GROUP_CONCAT(c.id) as condominium_ids,
      GROUP_CONCAT(c.name) as condominium_names,
      GROUP_CONCAT(DISTINCT f.id) as file_ids,
      GROUP_CONCAT(DISTINCT f.filename) as filenames,
      GROUP_CONCAT(DISTINCT f.original_filename) as original_filenames,
      GROUP_CONCAT(DISTINCT f.mime_type) as mime_types
    FROM admin_messages m
    JOIN admin_message_condominiums mc ON m.id = mc.message_id
    JOIN condominiums c ON mc.condominium_id = c.id
    LEFT JOIN admin_message_files f ON m.id = f.message_id
  `;
  
  const params = [];
  const conditions = [];

  // Filter by admin permissions using helper
  const allowedCondos = getAdminAllowedCondos(req);
  if (Array.isArray(allowedCondos)) {
    if (allowedCondos.length === 0) {
      // Limited admin with no condos = no access
      return res.json([]);
    }
    console.log('   Filtering messages by allowed condominiums:', allowedCondos);
    const placeholders = allowedCondos.map(() => '?').join(',');
    conditions.push(`mc.condominium_id IN (${placeholders})`);
    params.push(...allowedCondos);
  } else {
    console.log('   Admin has full access');
  }
  
  if (type) {
    conditions.push('m.type = ?');
    params.push(type);
  }
  
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  
  sql += ' GROUP BY m.id ORDER BY m.created_at DESC';

  console.log('   Final SQL:', sql);
  console.log('   Params:', params);
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching admin messages:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      // Parse the concatenated values into arrays
      const messages = rows.map(row => ({
        ...row,
        condominium_ids: row.condominium_ids ? row.condominium_ids.split(',').map(Number) : [],
        condominium_names: row.condominium_names ? row.condominium_names.split(',') : [],
        files: row.file_ids ? row.file_ids.split(',').map((id, i) => ({
          id: Number(id),
          filename: row.filenames.split(',')[i],
          original_filename: row.original_filenames.split(',')[i],
          mime_type: row.mime_types.split(',')[i]
        })) : []
      }));

      // Clean up internal fields
      messages.forEach(msg => {
        delete msg.file_ids;
        delete msg.filenames; 
        delete msg.original_filenames;
        delete msg.mime_types;
      });

      console.log(`   Returning ${messages.length} messages`);
      res.json(messages);
    }
  });
});

// Get unread notifications count for a user
app.get('/api/users/:id/notifications/unread-count', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const sql = `
    SELECT COUNT(*) as count
    FROM notifications n
    JOIN user_notifications un ON n.id = un.notification_id
    WHERE un.user_id = ? AND un.read_status = 0
  `;

  db.get(sql, [userId], (err, row) => {
    if (err) {
      console.error('Error fetching unread user notifications count:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ count: row ? row.count : 0 });
  });
});


// Mark a user's notification as read
app.put('/api/users/:userId/notifications/:notificationId/read', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const notificationId = parseInt(req.params.notificationId, 10);

  if (isNaN(userId) || isNaN(notificationId)) {
    return res.status(400).json({ error: 'Invalid user ID or notification ID' });
  }

  const sql = `
    UPDATE user_notifications
    SET read_status = 1
    WHERE user_id = ? AND notification_id = ?
  `;

  db.run(sql, [userId, notificationId], function(err) {
    if (err) {
      console.error('Error marking notification as read:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, changes: this.changes });
  });
});

  // Get a single message by ID
app.get('/api/admin/messages/:id', (req, res) => {
  const messageId = req.params.id;  const sql = `
    SELECT 
      m.id, m.user_id, m.condominium_id, m.type, m.subject, m.message, m.status,
      m.admin_response, m.admin_id, m.created_at, m.updated_at,
      u.nome as user_name,
      c.name as condominium_name
    FROM user_messages m
    JOIN users u ON m.user_id = u.id
    JOIN condominiums c ON m.condominium_id = c.id
    WHERE m.id = ?
  `;
  
  db.get(sql, [messageId], (err, message) => {
    if (err) {
      console.error('Error fetching message:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else if (!message) {
      res.status(404).json({ error: 'Message not found' });
    } else {
      res.json(message);
    }
  });
});

// Update message status and admin response
app.put('/api/admin/messages/:id', (req, res) => {
  const messageId = req.params.id;
  console.log(`🔧 PUT /api/admin/messages/${req.params.id} called`);
  console.log('   headers:', { 'admin-id': req.headers['admin-id'], 'admin-permissions': req.headers['admin-permissions'] });
  console.log('   body:', req.body);
  const { status, admin_response, admin_id } = req.body;
  
  if (status && !['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  const sql = `
    UPDATE user_messages 
    SET status = COALESCE(?, status), 
        admin_response = COALESCE(?, admin_response),
        admin_id = COALESCE(?, admin_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  
  db.run(sql, [status, admin_response, admin_id, messageId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Return updated message
    const selectSql = `
      SELECT m.*, c.name as condominium_name, u.nome as user_name, u.nif as user_nif
      FROM user_messages m
      JOIN condominiums c ON m.condominium_id = c.id
      JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `;
    
    db.get(selectSql, [messageId], (err, message) => {
      if (err) {
        return res.status(500).json({ error: 'Error retrieving updated message', details: err.message });
      }
      res.json({ success: true, message });
    });
  });
});

// Delete message
app.delete('/api/admin/messages/:id', (req, res) => {
  const messageId = req.params.id;
  
  db.run('DELETE FROM user_messages WHERE id = ?', [messageId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    res.json({ message: 'Message deleted successfully' });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'DomusGest Database Server is running',
    timestamp: new Date().toISOString()
  });
});

// Temporary debug endpoint to check user associations
app.get('/api/debug/user/:nif', (req, res) => {
  const nif = req.params.nif;
  
  // Get user by NIF
  db.get('SELECT * FROM users WHERE nif = ?', [nif], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user's condominium associations
    const sql = `
      SELECT uc.*, c.name as condominium_name, c.id as condominium_id
      FROM user_condominiums uc
      JOIN condominiums c ON uc.condominium_id = c.id
      WHERE uc.user_id = ?
    `;
    
    db.all(sql, [user.id], (err, associations) => {
      if (err) {
        return res.status(500).json({ error: 'Error getting associations', details: err.message });
      }
      
      res.json({
        user: {
          id: user.id,
          nome: user.nome,
          nif: user.nif
        },
        associations: associations,
        associationCount: associations.length
      });
    });
  });
});

// Temporary endpoint to add user to condominium
app.post('/api/debug/add-association', (req, res) => {
  const { nif, condominiumName } = req.body;
  
  if (!nif || !condominiumName) {
    return res.status(400).json({ error: 'NIF and condominiumName are required' });
  }
  
  // Find user
  db.get('SELECT id FROM users WHERE nif = ?', [nif], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Find condominium
    db.get('SELECT id FROM condominiums WHERE name = ?', [condominiumName], (err, condo) => {
      if (err || !condo) {
        return res.status(404).json({ error: 'Condominium not found' });
      }
      
      // Check if association already exists
      db.get('SELECT id FROM user_condominiums WHERE user_id = ? AND condominium_id = ?', 
        [user.id, condo.id], (err, existing) => {
          if (existing) {
            return res.json({ message: 'Association already exists' });
          }
          
          // Add association
          db.run('INSERT INTO user_condominiums (user_id, condominium_id) VALUES (?, ?)',
            [user.id, condo.id], function(err) {
              if (err) {
                return res.status(500).json({ error: 'Failed to add association', details: err.message });
              }
              
              res.json({ 
                success: true, 
                message: 'Association added successfully',
                associationId: this.lastID 
              });
            });
        });
    });
  });
});

// ========================================
// OCORRENCIAS ROUTES
// ========================================

// Get all ocorrencias (admin)
app.get('/api/admin/ocorrencias', (req, res) => {
  // Build base query including condominium NIPC, reporter info and creator admin username
  let baseSql = `
    SELECT o.*, c.name as condominium_name, c.nipc as condominium_nipc, m.nome as maintenance_name,
           a.username as created_by_admin_username, u.nome as reporter_name, u.nif as reporter_nif
    FROM ocorrencias o
    LEFT JOIN condominiums c ON o.condominium_id = c.id
    LEFT JOIN maintenance_users m ON o.assigned_to_maintenance = m.id
    LEFT JOIN admins a ON o.created_by_admin = a.id
    LEFT JOIN users u ON o.reporter_user_id = u.id
  `;

  const params = [];

  // If admin has limited scope, filter by allowed_condominiums header
  try {
    const adminPermHeader = req.headers['admin-permissions'];
    if (adminPermHeader) {
      const perms = typeof adminPermHeader === 'string' ? JSON.parse(adminPermHeader) : adminPermHeader;
      if (perms && perms.scope === 'limited' && Array.isArray(perms.allowed_condominiums) && perms.allowed_condominiums.length > 0) {
        const placeholders = perms.allowed_condominiums.map(() => '?').join(',');
        baseSql += ` WHERE o.condominium_id IN (${placeholders})`;
        params.push(...perms.allowed_condominiums);
        // Note: do NOT restrict limited admins to only occurrences they personally created.
        // They should see all ocorrencias for the condominiums in their allowed list.
      }
    }
  } catch (err) {
    console.error('Error parsing admin-permissions header for ocorrencias filter:', err);
  }

  baseSql += '\n    ORDER BY o.created_at DESC\n  ';

  db.all(baseSql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching ocorrencias:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar ocorrências' });
    }
    res.json(rows);
  });
});

// Create new ocorrencia (admin)
app.post('/api/admin/ocorrencias', async (req, res) => {
  let { condominium_id, title, description, priority = 'medium', created_by_admin, reporter_user_id, reporter_user_nif, reporter_note } = req.body;
  // If admin id not provided in body, try header
  if (!created_by_admin && req.headers['admin-id']) {
    created_by_admin = parseInt(req.headers['admin-id'], 10);
  }
  
  if (!condominium_id || !title || !description || !created_by_admin) {
    return res.status(400).json({ error: 'Dados obrigatórios em falta' });
  }
  
  try {
    // Fetch condominium nipc if exists
    const condoRow = await new Promise((resolve, reject) => {
      db.get('SELECT nipc FROM condominiums WHERE id = ?', [condominium_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const condominium_nipc = condoRow && condoRow.nipc ? condoRow.nipc : null;

    // If reporter_user_id provided but reporter_user_nif missing, fetch from users table
    if (reporter_user_id && !reporter_user_nif) {
      try {
        const userRow = await new Promise((resolve, reject) => {
          db.get('SELECT nif FROM users WHERE id = ?', [reporter_user_id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });
        if (userRow && userRow.nif) {
          reporter_user_nif = userRow.nif;
        }
      } catch (err) {
        console.error('Error fetching reporter user nif:', err.message);
      }
    }

    // Validate optional assigned_to_maintenance if provided.
    // Use hasOwnProperty so empty strings/null are handled explicitly.
    let assigned_to_maintenance = null;
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'assigned_to_maintenance')) {
      const rawCandidate = req.body.assigned_to_maintenance;
      // Treat empty string or null as explicit "no assignment"
      if (rawCandidate === null || rawCandidate === '') {
        assigned_to_maintenance = null;
      } else {
        const candidate = parseInt(rawCandidate, 10);
        if (isNaN(candidate) || candidate <= 0) {
          // Invalid id provided - reject to avoid silent incorrect inserts
          return res.status(400).json({ error: 'assigned_to_maintenance inválido' });
        }
        // Ensure the maintenance user exists
        const exists = await new Promise((resolve) => {
          db.get('SELECT id FROM maintenance_users WHERE id = ?', [candidate], (err, row) => {
            if (err || !row) resolve(false);
            else resolve(true);
          });
        });
        if (!exists) {
          return res.status(400).json({ error: 'Utilizador de manutenção não encontrado' });
        }
        assigned_to_maintenance = candidate;
      }
    }

    console.debug('[DEBUG] Creating ocorrencia with assigned_to_maintenance (processed):', assigned_to_maintenance);
    const sql = `
      INSERT INTO ocorrencias (condominium_id, condominium_nipc, title, description, priority, created_by_admin, reporter_user_id, reporter_user_nif, reporter_note, status, assigned_to_maintenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `;

    const insertResult = await new Promise((resolve, reject) => {
      db.run(sql, [condominium_id, condominium_nipc, title, description, priority, created_by_admin, reporter_user_id || null, reporter_user_nif || null, reporter_note || null, assigned_to_maintenance], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
    
    // Get the created ocorrencia with condominium name
    const getSql = `
      SELECT o.*, c.name as condominium_name
      FROM ocorrencias o
      LEFT JOIN condominiums c ON o.condominium_id = c.id
      WHERE o.id = ?
    `;
    
    const createdOcorrencia = await new Promise((resolve, reject) => {
      db.get(getSql, [insertResult], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    // Create notification for maintenance team and link to admins (includes condominium_id)
    try {
      const notifSql = `
        INSERT INTO notifications (type, title, message, related_id, condominium_id, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;

      const notifTitle = `📌 Nova Ocorrência: ${createdOcorrencia.title}`;
      const condoName = createdOcorrencia.condominium_name || 'Condomínio';
      const notifMessage = `Uma nova ocorrência foi criada no ${condoName}: ${createdOcorrencia.title}`;

      const notificationId = await new Promise((resolve, reject) => {
        db.run(notifSql, ['ocorrencia', notifTitle, notifMessage, createdOcorrencia.id || insertResult, condominium_id], function(err) {
          if (err) return resolve(null); // not fatal for the creation
          resolve(this.lastID);
        });
      });

      if (notificationId) {
        try {
          const condoId = createdOcorrencia.condominium_id || condominium_id;
          const { adminIds } = await linkNotificationToAdminsByCondominiums(notificationId, [condoId]);
          if (Array.isArray(adminIds) && adminIds.length > 0) {
            const payload = { notification_id: notificationId, type: 'ocorrencia', related_id: createdOcorrencia.id || insertResult };
            for (const adminId of adminIds) {
              try {
                sendSseToAdmin(adminId, 'notification_created', payload);
              } catch (sseError) {
                console.warn(`Error broadcasting ocorrencia notification SSE to admin ${adminId}:`, sseError.message || sseError);
              }
            }
          }
        } catch (linkErr) {
          console.error('Error linking ocorrencia notification to admins:', linkErr.message || linkErr);
        }
      }
    } catch (e) {
      console.warn('Error creating or linking ocorrencia notification:', e && e.message);
    }

    res.status(201).json(createdOcorrencia);
  } catch (error) {
    // Log full error and stack to aid debugging
    console.error('Error creating ocorrencia:', error);
    res.status(500).json({ error: 'Erro ao criar ocorrência' });
  }
});

// Get pending ocorrencias for maintenance
app.get('/api/maintenance/ocorrencias/pending', (req, res) => {
  const maintenanceIdRaw = req.headers['maintenance-id'] || req.query.maintenance_id || null;
  const maintenanceId = maintenanceIdRaw ? parseInt(maintenanceIdRaw, 10) : null;

  console.debug('[DEBUG] GET /api/maintenance/ocorrencias/pending - maintenance-id raw header:', maintenanceIdRaw);
  console.debug('[DEBUG] GET /api/maintenance/ocorrencias/pending - parsed maintenance-id:', maintenanceId);

  let sql = `
    SELECT o.*, c.name as condominium_name, c.nipc as condominium_nipc, m.nome as maintenance_name,
           a.username as created_by_admin_username, u.nome as reporter_name, u.nif as reporter_nif
    FROM ocorrencias o
    LEFT JOIN condominiums c ON o.condominium_id = c.id
    LEFT JOIN maintenance_users m ON o.assigned_to_maintenance = m.id
    LEFT JOIN admins a ON o.created_by_admin = a.id
    LEFT JOIN users u ON o.reporter_user_id = u.id
    WHERE (o.status IN ('pending', 'in_progress') OR o.status IS NULL OR o.status = '')
  `;

  const params = [];
  if (!isNaN(maintenanceId) && maintenanceId !== null) {
    // maintenance-id provided: show occurrences assigned to this maintenance user OR unassigned
    sql += ' AND (o.assigned_to_maintenance = ? OR o.assigned_to_maintenance IS NULL)';
    params.push(maintenanceId);
    console.debug('[DEBUG] Filtering pending for maintenance id, params:', params);
  } else {
    // No maintenance-id header: do NOT leak occurrences assigned to other maintenance users
    // Only return unassigned occurrences so anonymous/broken requests don't see assigned work
    sql += ' AND o.assigned_to_maintenance IS NULL';
    console.debug('[DEBUG] No maintenance-id provided; returning only unassigned pending occurrences');
  }

  console.debug('[DEBUG] Pending status filter includes NULL/empty statuses to capture incomplete records');

  sql += ' ORDER BY o.priority DESC, o.created_at ASC';

  console.debug('[DEBUG] Final SQL for pending:', sql);
  console.debug('[DEBUG] SQL params for pending:', params);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching pending ocorrencias:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar ocorrências pendentes' });
    }
  console.debug('[DEBUG] Pending ocorrencias returned count:', rows.length);
  res.json(rows);
  });
});

// Get completed ocorrencias for maintenance
app.get('/api/maintenance/ocorrencias/completed', (req, res) => {
  const maintenanceIdRaw = req.headers['maintenance-id'] || req.query.maintenance_id || null;
  const maintenanceId = maintenanceIdRaw ? parseInt(maintenanceIdRaw, 10) : null;

  console.debug('[DEBUG] GET /api/maintenance/ocorrencias/completed - maintenance-id raw header:', maintenanceIdRaw);
  console.debug('[DEBUG] GET /api/maintenance/ocorrencias/completed - parsed maintenance-id:', maintenanceId);

  let sql = `
    SELECT o.*, c.name as condominium_name, c.nipc as condominium_nipc, m.nome as maintenance_name,
           a.username as created_by_admin_username, u.nome as reporter_name, u.nif as reporter_nif
    FROM ocorrencias o
    LEFT JOIN condominiums c ON o.condominium_id = c.id
    LEFT JOIN maintenance_users m ON o.assigned_to_maintenance = m.id
    LEFT JOIN admins a ON o.created_by_admin = a.id
    LEFT JOIN users u ON o.reporter_user_id = u.id
    WHERE o.status = 'completed'
  `;

  const params = [];
  if (!isNaN(maintenanceId) && maintenanceId !== null) {
    // maintenance-id provided: show completed occurrences assigned to this maintenance user OR unassigned
    sql += ' AND (o.assigned_to_maintenance = ? OR o.assigned_to_maintenance IS NULL)';
    params.push(maintenanceId);
    console.debug('[DEBUG] Filtering completed for maintenance id, params:', params);
  } else {
    // No maintenance-id header: only return unassigned completed occurrences
    sql += ' AND o.assigned_to_maintenance IS NULL';
    console.debug('[DEBUG] No maintenance-id provided; returning only unassigned completed occurrences');
  }

  // Accept resolved or completed as concluded statuses
  sql = sql.replace("WHERE o.status = 'completed'", "WHERE o.status IN ('completed', 'resolved')");

  sql += ' ORDER BY o.completed_at DESC';

  console.debug('[DEBUG] Final SQL for completed:', sql);
  console.debug('[DEBUG] SQL params for completed:', params);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching completed ocorrencias:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar ocorrências concluídas' });
    }
  console.debug('[DEBUG] Completed ocorrencias returned count:', rows.length);
  res.json(rows);
  });
});

// Admin utility: fix orphaned maintenance assignments (one-time)
app.post('/api/admin/fix-orphaned-maintenance-assignments', (req, res) => {
  try {
    // Find distinct assigned_to_maintenance ids that do not exist in maintenance_users
    const query = `
      SELECT DISTINCT o.assigned_to_maintenance as mid
      FROM ocorrencias o
      WHERE o.assigned_to_maintenance IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM maintenance_users m WHERE m.id = o.assigned_to_maintenance)
    `;

    db.all(query, [], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro a analisar atribuições órfãs' });

      const orphanIds = (rows || []).map(r => r.mid).filter(Boolean);
      if (orphanIds.length === 0) return res.json({ message: 'Nenhuma atribuição órfã encontrada', orphanIds: [] });

      const placeholders = orphanIds.map(() => '?').join(',');
      const updateSql = `UPDATE ocorrencias SET assigned_to_maintenance = NULL WHERE assigned_to_maintenance IN (${placeholders})`;

      db.run(updateSql, orphanIds, function(updErr) {
        if (updErr) return res.status(500).json({ error: 'Erro a limpar atribuições órfãs' });
        console.log(`✅ Limpadas ${this.changes} atribuições órfãs:`, orphanIds);
        return res.json({ message: 'Atribuições órfãs limpas', orphanIds, changed: this.changes });
      });
    });
  } catch (e) {
    console.error('Erro no endpoint de limpeza de órfãos:', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Admin Messages - create new message with files
app.post('/api/admin/messages', uploadAny.array('files', 10), async (req, res) => {
  console.log('📨 POST /api/admin/messages called');
  try {
    const { title, body, type } = req.body;
    const files = req.files || [];
    
    // Get admin ID from header
    const adminId = req.headers['admin-id'];
    if (!adminId) {
      return res.status(400).json({ error: 'Admin ID required' });
    }

    // Parse condominium IDs (support multiple payload formats)
    let rawCondos = req.body.condominium_ids ?? req.body.condominiumIds ?? [];
    if (typeof rawCondos === 'string') {
      try {
        rawCondos = JSON.parse(rawCondos);
      } catch (e) {
        rawCondos = rawCondos.split(',').map(v => v.trim()).filter(Boolean);
      }
    }
    const targetCondos = (Array.isArray(rawCondos) ? rawCondos : [rawCondos])
      .map(id => Number(id))
      .filter(id => !Number.isNaN(id));

    if (targetCondos.length === 0) {
      return res.status(400).json({ error: 'Pelo menos um condomínio alvo é obrigatório' });
    }

    // Check admin permissions
    const adminPermsHeader = req.headers['admin-permissions'];
    if (adminPermsHeader) {
      try {
        const perms = JSON.parse(adminPermsHeader);
        if (perms.scope === 'limited') {
          const allowed = normalizeAllowedCondominiums(perms.allowed_condominiums);
          const filtered = targetCondos.filter(id => allowed.includes(Number(id)));
          if (filtered.length === 0) {
            return res.status(403).json({ error: 'No permitted condominiums in target list' });
          }
          targetCondos.length = 0;
          targetCondos.push(...filtered);
        }
      } catch (e) {
        console.error('Error parsing admin permissions:', e);
      }
    }

    // Insert the admin message
    const msgSql = `INSERT INTO admin_messages (title, body, type, admin_id, created_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    
    const messageId = await new Promise((resolve, reject) => {
      db.run(msgSql, [title, body, type || 'general', adminId], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });

    // Link message to target condominiums (both tables for compatibility)
    const linkSql = `INSERT INTO admin_message_condominiums (message_id, condominium_id)
                     VALUES (?, ?)`;
    const linkSql2 = `INSERT INTO admin_message_targets (message_id, condominium_id)
                      VALUES (?, ?)`;
    
    await Promise.all(targetCondos.map(condoId => 
      Promise.all([
        new Promise((resolve, reject) => {
          db.run(linkSql, [messageId, condoId], err => {
            if (err) reject(err);
            else resolve();
          });
        }),
        new Promise((resolve, reject) => {
          db.run(linkSql2, [messageId, condoId], err => {
            if (err) reject(err);
            else resolve();
          });
        })
      ])
    ));

    // Store files if any
    if (files.length > 0) {
      const fileSql = `INSERT INTO admin_message_files 
        (message_id, filename, original_filename, file_path, mime_type, file_size)
        VALUES (?, ?, ?, ?, ?, ?)`;

      await Promise.all(files.map(file =>
        new Promise((resolve, reject) => {
          const storedPath = file.path ? path.resolve(file.path) : path.resolve(uploadsDir, file.filename);
          const fileSize = typeof file.size === 'number' ? file.size : (fs.existsSync(storedPath) ? fs.statSync(storedPath).size : 0);

          db.run(
            fileSql,
            [
              messageId,
              file.filename,
              file.originalname,
              storedPath,
              file.mimetype,
              fileSize
            ],
            err => {
              if (err) reject(err);
              else resolve();
            }
          );
        })
      ));
    }

    // Create notifications for the message
    const notifSql = `INSERT INTO notifications 
      (type, title, message, related_id, condominium_id, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

    const notificationId = await new Promise((resolve, reject) => {
      const notifTitle = '📣 Nova mensagem';
      const notifBody = `Nova mensagem administrativa: "${title}"`;
      const primaryCondo = targetCondos[0] ?? null;
      db.run(notifSql, ['admin_message', notifTitle, notifBody, messageId, primaryCondo], 
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Link notification to users in target condominiums
    await new Promise((resolve, reject) => {
      linkNotificationToUsers(notificationId, targetCondos, (linkErr) => {
        if (linkErr) reject(linkErr);
        else resolve();
      });
    });

    const { adminIds } = await linkNotificationToAdminsByCondominiums(notificationId, targetCondos);
    if (!adminIds || adminIds.length === 0) {
      console.log('ℹ️ No admins linked to admin message notification (check condominium permissions).');
    }

    // Return success with message details
    const getMessage = `
      SELECT m.*, a.username as admin_username,
        (SELECT GROUP_CONCAT(c.name) FROM admin_message_condominiums mc
         JOIN condominiums c ON mc.condominium_id = c.id
         WHERE mc.message_id = m.id) as condominium_names,
        (SELECT COUNT(*) FROM admin_message_files WHERE message_id = m.id) as file_count
      FROM admin_messages m
      LEFT JOIN admins a ON m.admin_id = a.id
      WHERE m.id = ?
    `;

    const message = await new Promise((resolve, reject) => {
      db.get(getMessage, [messageId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    // Broadcast notification to all connected admins via SSE
    try {
      const uniqueAdminIds = Array.from(new Set(adminIds || []));

      for (const adminId of uniqueAdminIds) {
        try {
          sendSseToAdmin(adminId, 'notification_created', { 
            notification_id: notificationId,
            message_id: messageId,
            title: title
          });
        } catch (e) {
          console.warn(`Failed to send SSE to admin ${adminId}:`, e.message);
        }
      }
    } catch (e) {
      console.warn('Error broadcasting SSE for new message:', e);
    }

    res.json({ success: true, message });

  } catch (error) {
    console.error('Error creating admin message:', error);
    res.status(500).json({ error: 'Error creating message' });
  }
});

// Create new admin (only main admin should call this in production)
app.post('/api/admins', async (req, res) => {
  // Require main admin
  const isMain = await checkIsMainAdmin(req);
  if (!isMain) return res.status(403).json({ error: 'Only main admin can create admins' });
  try {
    const { username, password, scope = 'full', allowed_condominiums = null } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    // Ensure unique username
    const exists = await new Promise((resolve) => {
      db.get('SELECT id FROM admins WHERE username = ?', [username], (err, row) => { if (err || !row) resolve(false); else resolve(true); });
    });
    if (exists) return res.status(400).json({ error: 'admin username already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const allowedJson = allowed_condominiums ? JSON.stringify(allowed_condominiums) : null;

    const insertSql = `INSERT INTO admins (username, password, scope, allowed_condominiums, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    const id = await new Promise((resolve, reject) => {
      db.run(insertSql, [username, hashed, scope, allowedJson], function(err) {
        if (err) reject(err); else resolve(this.lastID);
      });
    });

    const admin = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, scope, allowed_condominiums FROM admins WHERE id = ?', [id], (err, row) => { if (err) reject(err); else resolve(row); });
    });
    res.status(201).json(admin);
  } catch (e) {
    console.error('Error creating admin:', e);
    res.status(500).json({ error: 'Erro ao criar admin' });
  }
});

// Get all admins (for management UI)
app.get('/api/admins', (req, res) => {
  const sql = 'SELECT id, username, scope, allowed_condominiums, created_at FROM admins ORDER BY id';
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching admins:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar admins' });
    }
    res.json(rows);
  });
});

// Get single admin
app.get('/api/admins/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT id, username, scope, allowed_condominiums, created_at FROM admins WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Error fetching admin:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar admin' });
    }
    if (!row) return res.status(404).json({ error: 'Admin não encontrado' });
    res.json(row);
  });
});

// Create new maintenance user
app.post('/api/admin/maintenance-users', async (req, res) => {
  // Require main admin
  const isMain = await checkIsMainAdmin(req);
  if (!isMain) return res.status(403).json({ error: 'Only main admin can create maintenance users' });
  try {
    const { nome, username, password } = req.body;
    if (!nome || !password || !username) return res.status(400).json({ error: 'nome, username and password required' });

    // username must be unique
    const exists = await new Promise((resolve) => {
      db.get('SELECT id FROM maintenance_users WHERE username = ?', [username], (err, row) => { if (err || !row) resolve(false); else resolve(true); });
    });
    if (exists) return res.status(400).json({ error: 'maintenance username already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const insertSql = `INSERT INTO maintenance_users (username, password, nome, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`;
    const id = await new Promise((resolve, reject) => {
      db.run(insertSql, [username, hashed, nome], function(err) { if (err) reject(err); else resolve(this.lastID); });
    });

    const manut = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, nome FROM maintenance_users WHERE id = ?', [id], (err, row) => { if (err) reject(err); else resolve(row); });
    });
    res.status(201).json(manut);
  } catch (e) {
    console.error('Error creating maintenance user:', e);
    res.status(500).json({ error: 'Erro ao criar utilizador de manutenção' });
  }
});

  // Edit admin account (username, password, scope, allowed_condominiums)
  app.put('/api/admins/:id', async (req, res) => {
    const isMain = await checkIsMainAdmin(req);
    if (!isMain) return res.status(403).json({ error: 'Only main admin can edit admins' });

    const { id } = req.params;
    const { username, password, scope, allowed_condominiums } = req.body;

    try {
      // Validate admin exists
      const existing = await new Promise((resolve) => db.get('SELECT * FROM admins WHERE id = ?', [id], (err, row) => resolve(row)));
      if (!existing) return res.status(404).json({ error: 'Admin not found' });

      const updates = [];
      const params = [];

      if (username && username !== existing.username) {
        // ensure unique
        const exists = await new Promise((resolve) => db.get('SELECT id FROM admins WHERE username = ? AND id != ?', [username, id], (err, row) => resolve(!!row)));
        if (exists) return res.status(400).json({ error: 'username already in use' });
        updates.push('username = ?'); params.push(username);
      }

      if (typeof scope !== 'undefined') { updates.push('scope = ?'); params.push(scope || 'full'); }

      if (typeof allowed_condominiums !== 'undefined') { updates.push('allowed_condominiums = ?'); params.push(allowed_condominiums ? JSON.stringify(allowed_condominiums) : null); }

      if (password) {
        const hashed = await bcrypt.hash(password, 10);
        updates.push('password = ?'); params.push(hashed);
      }

      if (updates.length === 0) return res.json(existing);

      const sql = `UPDATE admins SET ${updates.join(', ')}, created_at = created_at WHERE id = ?`;
      params.push(id);

      await new Promise((resolve, reject) => db.run(sql, params, function(err) { if (err) reject(err); else resolve(); }));

      const updated = await new Promise((resolve) => db.get('SELECT id, username, scope, allowed_condominiums FROM admins WHERE id = ?', [id], (err, row) => resolve(row)));
      res.json(updated);
    } catch (e) {
      console.error('Error updating admin:', e);
      res.status(500).json({ error: 'Erro ao atualizar admin' });
    }
  });

  // Delete admin account
  app.delete('/api/admins/:id', async (req, res) => {
    const isMain = await checkIsMainAdmin(req);
    if (!isMain) return res.status(403).json({ error: 'Only main admin can delete admins' });

    const { id } = req.params;
    try {
      const existing = await new Promise((resolve) => db.get('SELECT id, username FROM admins WHERE id = ?', [id], (err, row) => resolve(row)));
      if (!existing) return res.status(404).json({ error: 'Admin not found' });

      // Prevent deleting the main admin account
      if (existing.username === 'admin') return res.status(400).json({ error: 'Cannot delete main admin account' });

      await new Promise((resolve, reject) => db.run('DELETE FROM admins WHERE id = ?', [id], function(err) { if (err) reject(err); else resolve(this.changes); }));
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting admin:', e);
      res.status(500).json({ error: 'Erro ao apagar admin' });
    }
  });

  // Delete maintenance user
  app.delete('/api/admin/maintenance-users/:id', async (req, res) => {
    const isMain = await checkIsMainAdmin(req);
    if (!isMain) return res.status(403).json({ error: 'Only main admin can delete maintenance users' });

    const { id } = req.params;
    try {
      const existing = await new Promise((resolve) => db.get('SELECT id, username FROM maintenance_users WHERE id = ?', [id], (err, row) => resolve(row)));
      if (!existing) return res.status(404).json({ error: 'Maintenance user not found' });

      await new Promise((resolve, reject) => db.run('DELETE FROM maintenance_users WHERE id = ?', [id], function(err) { if (err) reject(err); else resolve(this.changes); }));
      // Clear any assigned_to_maintenance references to avoid orphans
      await new Promise((resolve, reject) => db.run('UPDATE ocorrencias SET assigned_to_maintenance = NULL WHERE assigned_to_maintenance = ?', [id], function(err) { if (err) reject(err); else resolve(this.changes); }));
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting maintenance user:', e);
      res.status(500).json({ error: 'Erro ao apagar utilizador de manutenção' });
    }
  });

// Update ocorrencia status and assign to maintenance
app.put('/api/maintenance/ocorrencias/:id', async (req, res) => {
  const { id } = req.params;
  const { status, maintenance_report } = req.body;

  // Validate assigned_to_maintenance if present in body
  let assigned_to_maintenance = null;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'assigned_to_maintenance')) {
    const candidate = parseInt(req.body.assigned_to_maintenance, 10);
    if (!isNaN(candidate)) {
      // Check existence
      const exists = await new Promise((resolve) => {
        db.get('SELECT id FROM maintenance_users WHERE id = ?', [candidate], (err, row) => {
          if (err || !row) resolve(false);
          else resolve(true);
        });
      });
      if (exists) assigned_to_maintenance = candidate;
    }
  }

  let sql = 'UPDATE ocorrencias SET status = ?, updated_at = CURRENT_TIMESTAMP';
  const params = [status];

  if (maintenance_report) {
    sql += ', maintenance_report = ?';
    params.push(maintenance_report);
  }

  if (assigned_to_maintenance !== null) {
    sql += ', assigned_to_maintenance = ?';
    params.push(assigned_to_maintenance);
  }

  sql += ' WHERE id = ?';
  params.push(id);
  
  try {
    // Update the ocorrencia
    await new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('Ocorrência não encontrada'));
        else resolve();
      });
    });
    
    // Get updated ocorrencia with details
    const getSql = `
      SELECT o.*, c.name as condominium_name, c.nipc as condominium_nipc, m.nome as maintenance_name,
             a.username as created_by_admin_username, u.nome as reporter_name, u.nif as reporter_nif
      FROM ocorrencias o
      LEFT JOIN condominiums c ON o.condominium_id = c.id
      LEFT JOIN maintenance_users m ON o.assigned_to_maintenance = m.id
      LEFT JOIN admins a ON o.created_by_admin = a.id
      LEFT JOIN users u ON o.reporter_user_id = u.id
      WHERE o.id = ?
    `;
    
    const updatedOcorrencia = await new Promise((resolve, reject) => {
      db.get(getSql, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    // Create notification if maintenance work is completed
    if (status === 'pending_verification' && maintenance_report) {
      const notificationSql = `
        INSERT INTO notifications (type, title, message, related_id, condominium_id, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;

      const maintenanceName = updatedOcorrencia.maintenance_name || 'Equipa de Manutenção';
      const condoName = updatedOcorrencia.condominium_name || 'Condomínio';
      const title = '🔧 Manutenção Concluída';
      const message = `${maintenanceName} concluiu a manutenção "${updatedOcorrencia.title}" no ${condoName}. Aguarda verificação.`;

      const notificationId = await new Promise((resolve, reject) => {
        db.run(notificationSql, ['maintenance_completed', title, message, id, updatedOcorrencia.condominium_id], (err) => {
          if (err) {
            console.error('Error creating maintenance notification:', err);
            resolve(null);
          } else {
            resolve(this.lastID);
          }
        });
      });

      // Link notification to appropriate admins if notification was created
      if (notificationId) {
        console.log(`🔗 Linking maintenance completion notification ${notificationId} for condominium ${updatedOcorrencia.condominium_id}...`);
        try {
          const { adminIds, linkedCount } = await linkNotificationToAdminsByCondominiums(notificationId, [updatedOcorrencia.condominium_id]);
          if (linkedCount > 0) {
            console.log(`✅ Successfully linked maintenance notification to ${linkedCount} admin(s)`);
            for (const adminId of adminIds) {
              try {
                sendSseToAdmin(adminId, 'notification_created', {
                  notification_id: notificationId,
                  type: 'ocorrencia',
                  related_id: id,
                });
              } catch (sseErr) {
                console.warn(`Error broadcasting maintenance completion SSE to admin ${adminId}:`, sseErr.message || sseErr);
              }
            }
          } else {
            console.log('⚠️ No admins found to receive this maintenance notification');
          }
        } catch (linkErr) {
          console.error('Error linking maintenance notification to admins:', linkErr.message || linkErr);
        }
      }
    }
    
    res.json(updatedOcorrencia);
  } catch (error) {
    console.error('Error updating ocorrencia:', error.message);
    if (error.message === 'Ocorrência não encontrada') {
      res.status(404).json({ error: 'Ocorrência não encontrada' });
    } else {
      res.status(500).json({ error: 'Erro ao atualizar ocorrência' });
    }
  }
});

// Edit maintenance user (username, nome, password) - only main admin
app.put('/api/admin/maintenance-users/:id', async (req, res) => {
  const isMain = await checkIsMainAdmin(req);
  if (!isMain) return res.status(403).json({ error: 'Only main admin can edit maintenance users' });

  const { id } = req.params;
  const { nome, username, password } = req.body;

  try {
    const existing = await new Promise((resolve) => db.get('SELECT * FROM maintenance_users WHERE id = ?', [id], (err, row) => resolve(row)));
    if (!existing) return res.status(404).json({ error: 'Maintenance user not found' });

    const updates = [];
    const params = [];

    if (username && username !== existing.username) {
      // ensure unique username
      const exists = await new Promise((resolve) => db.get('SELECT id FROM maintenance_users WHERE username = ? AND id != ?', [username, id], (err, row) => resolve(!!row)));
      if (exists) return res.status(400).json({ error: 'username already in use' });
      updates.push('username = ?'); params.push(username);
    }

    if (typeof nome !== 'undefined' && nome !== existing.nome) { updates.push('nome = ?'); params.push(nome); }

    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      updates.push('password = ?'); params.push(hashed);
    }

    if (updates.length === 0) return res.json({ id: existing.id, username: existing.username, nome: existing.nome });

    const sql = `UPDATE maintenance_users SET ${updates.join(', ')} WHERE id = ?`;
    params.push(id);

    await new Promise((resolve, reject) => db.run(sql, params, function(err) { if (err) reject(err); else resolve(); }));

    const updated = await new Promise((resolve) => db.get('SELECT id, username, nome FROM maintenance_users WHERE id = ?', [id], (err, row) => resolve(row)));
    res.json(updated);
  } catch (e) {
    console.error('Error updating maintenance user:', e);
    res.status(500).json({ error: 'Erro ao atualizar utilizador de manutenção' });
  }
});

// Admin verify and complete ocorrencia
app.put('/api/admin/ocorrencias/:id/verify', async (req, res) => {
  const { id } = req.params;
  const { admin_verification, approved } = req.body;
  
  const status = approved ? 'completed' : 'in_progress';
  
  let sql = 'UPDATE ocorrencias SET admin_verification = ?, status = ?, updated_at = CURRENT_TIMESTAMP';
  const params = [admin_verification, status];
  
  if (approved) {
    sql += ', completed_at = CURRENT_TIMESTAMP';
  }
  
  sql += ' WHERE id = ?';
  params.push(id);
  
  db.run(sql, params, function(err) {
    if (err) {
      console.error('Error verifying ocorrencia:', err.message);
      return res.status(500).json({ error: 'Erro ao verificar ocorrência' });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Ocorrência não encontrada' });
    }
    
    // Get updated ocorrencia
    const getSql = `
      SELECT o.*, c.name as condominium_name, c.nipc as condominium_nipc, m.nome as maintenance_name,
             a.username as created_by_admin_username, u.nome as reporter_name, u.nif as reporter_nif
      FROM ocorrencias o
      LEFT JOIN condominiums c ON o.condominium_id = c.id
      LEFT JOIN maintenance_users m ON o.assigned_to_maintenance = m.id
      LEFT JOIN admins a ON o.created_by_admin = a.id
      LEFT JOIN users u ON o.reporter_user_id = u.id
      WHERE o.id = ?
    `;
    
    db.get(getSql, [id], (err, row) => {
      if (err) {
        console.error('Error fetching verified ocorrencia:', err.message);
        return res.status(500).json({ error: 'Erro ao buscar ocorrência verificada' });
      }
      
      // Create notification for maintenance user about the verification result
      if (row && row.assigned_to_maintenance) {
        const notificationTitle = approved
          ? '✅ Trabalho Aprovado'
          : '❌ Trabalho Rejeitado';

        const notificationMessage = approved
          ? `O seu trabalho na ocorrência "${row.title}" foi aprovado pelo administrador. O trabalho está agora concluído.`
          : `O seu trabalho na ocorrência "${row.title}" foi rejeitado pelo administrador. Por favor, reveja o feedback: ${admin_verification}`;

        const notificationSql = `
          INSERT INTO notifications (user_id, title, message, type, related_id, created_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;

        db.run(notificationSql, [
          row.assigned_to_maintenance,
          notificationTitle,
          notificationMessage,
          'maintenance',
          id
        ], function(notifErr) {
          if (notifErr) {
            console.error('Error creating verification notification:', notifErr.message);
            return res.json(row);
          }

          const notificationId = this.lastID;
          console.log(`📢 Notification created for maintenance user ${row.maintenance_name} about work ${approved ? 'approval' : 'rejection'}`);

          // Link notification to appropriate admins based on condominium access
          console.log(`🔗 Linking verification notification ${notificationId} for condominium ${row.condominium_id}...`);

          linkNotificationToAdminsByCondominiums(notificationId, [row.condominium_id])
            .then(({ adminIds, linkedCount }) => {
              if (linkedCount === 0) {
                console.log('⚠️ No admins found to receive this verification notification');
                return res.json(row);
              }

              console.log(`✅ Successfully linked verification notification to ${linkedCount} admin(s)`);
              for (const adminId of adminIds) {
                try {
                  sendSseToAdmin(adminId, 'notification_created', {
                    notification_id: notificationId,
                    type: 'ocorrencia',
                    related_id: id,
                  });
                } catch (sseErr) {
                  console.warn(`Error broadcasting verification SSE to admin ${adminId}:`, sseErr.message || sseErr);
                }
              }
              res.json(row);
            })
            .catch((linkErr) => {
              console.error('Error linking verification notification to admins:', linkErr.message || linkErr);
              res.json(row);
            });
        });
      } else {
        res.json(row);
      }
    });
  });
});

// Admin complete ocorrencia (compat for frontend which calls /complete)
app.put('/api/admin/ocorrencias/:id/complete', async (req, res) => {
  const { id } = req.params;
  // frontend may send admin_response and optionally a status (e.g. 'pending')
  const { admin_response, status } = req.body;

  // Determine approval: if status explicitly 'pending' treat as rejection, otherwise approve
  const approved = !(status && status === 'pending');
  const newStatus = status && status !== '' ? status : (approved ? 'completed' : 'in_progress');

  let sql = 'UPDATE ocorrencias SET admin_verification = ?, status = ?, updated_at = CURRENT_TIMESTAMP';
  const params = [admin_response || null, newStatus];

  if (newStatus === 'completed') {
    sql += ', completed_at = CURRENT_TIMESTAMP';
  }

  sql += ' WHERE id = ?';
  params.push(id);

  db.run(sql, params, function(err) {
    if (err) {
      console.error('Error completing ocorrencia:', err.message);
      return res.status(500).json({ error: 'Erro ao completar ocorrência' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Ocorrência não encontrada' });
    }

    // Get updated ocorrencia
    const getSql = `
      SELECT o.*, c.name as condominium_name, c.nipc as condominium_nipc, m.nome as maintenance_name,
             a.username as created_by_admin_username, u.nome as reporter_name, u.nif as reporter_nif
      FROM ocorrencias o
      LEFT JOIN condominiums c ON o.condominium_id = c.id
      LEFT JOIN maintenance_users m ON o.assigned_to_maintenance = m.id
      LEFT JOIN admins a ON o.created_by_admin = a.id
      LEFT JOIN users u ON o.reporter_user_id = u.id
      WHERE o.id = ?
    `;

    db.get(getSql, [id], (err, row) => {
      if (err) {
        console.error('Error fetching completed ocorrencia:', err.message);
        return res.status(500).json({ error: 'Erro ao buscar ocorrência completa' });
      }

      // Create notification for maintenance user about the completion/verification result
      if (row && row.assigned_to_maintenance) {
        const notificationTitle = approved
          ? '✅ Trabalho Aprovado'
          : '❌ Trabalho Rejeitado';

        const notificationMessage = approved
          ? `O seu trabalho na ocorrência "${row.title}" foi aprovado pelo administrador. O trabalho está agora concluído.`
          : `O seu trabalho na ocorrência "${row.title}" foi rejeitado pelo administrador. Por favor, reveja o feedback: ${admin_response || ''}`;

        const notificationSql = `
          INSERT INTO notifications (user_id, title, message, type, related_id, created_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;

        db.run(notificationSql, [
          row.assigned_to_maintenance,
          notificationTitle,
          notificationMessage,
          'maintenance',
          id
        ], function(notifErr) {
          if (notifErr) {
            console.error('Error creating completion notification:', notifErr.message);
            return res.json(row);
          }

          const notificationId = this.lastID;
          console.log(`📢 Notification created for maintenance user ${row.maintenance_name} about completion ${approved ? 'approval' : 'rejection'}`);

          // Link notification to appropriate admins based on condominium access
          console.log(`🔗 Linking completion notification ${notificationId} for condominium ${row.condominium_id}...`);

          const adminsSql = 'SELECT id, username, scope, allowed_condominiums FROM admins';
          db.all(adminsSql, [], (err, admins) => {
            if (err) {
              console.error('Error fetching admins for notification linking:', err);
              return res.json(row);
            }

            if (!admins || admins.length === 0) {
              return res.json(row);
            }

            const adminLinksToCreate = [];
            for (const admin of admins) {
              if (admin.scope === 'full') {
                adminLinksToCreate.push(admin.id);
              } else if (admin.scope === 'limited') {
                try {
                  const allowedCondos = normalizeAllowedCondominiums(admin.allowed_condominiums);
                  if (allowedCondos.includes(Number(row.condominium_id))) {
                    adminLinksToCreate.push(admin.id);
                  }
                } catch (parseErr) {
                  console.error(`Error parsing allowed_condominiums for admin ${admin.username}:`, parseErr);
                }
              }
            }

            if (adminLinksToCreate.length === 0) {
              console.log('⚠️ No admins found to receive this completion notification');
              return res.json(row);
            }

            const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;
            let completedCount = 0;

            adminLinksToCreate.forEach(adminId => {
              db.run(linkSql, [adminId, notificationId], (linkErr) => {
                if (linkErr) {
                  console.error(`Error linking completion notification ${notificationId} to admin ${adminId}:`, linkErr.message);
                } else {
                  console.log(`✅ Linked completion notification ${notificationId} to admin ${adminId}`);
                }
                completedCount++;
                if (completedCount === adminLinksToCreate.length) {
                  console.log(`✅ Successfully linked completion notification to ${adminLinksToCreate.length} admin(s)`);
                  res.json(row);
                }
              });
            });
          });
        });
      } else {
        res.json(row);
      }
    });
  });
});

// Get all maintenance users (for admin to assign tasks)
// Get maintenance work status for a user's condominiums
app.get('/api/users/:userId/maintenance-work', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  // Get all maintenance work and status for the user's condominiums
  const sql = `
    SELECT DISTINCT 
      o.*,
      c.name as condominium_name,
      mu.name as maintenance_worker_name,
      mu.phone as maintenance_worker_phone,
      (
        SELECT json_object(
          'comment', ou.comment,
          'created_at', ou.created_at
        )
        FROM ocorrencia_updates ou 
        WHERE ou.ocorrencia_id = o.id 
        ORDER BY ou.created_at DESC 
        LIMIT 1
      ) as latest_update
    FROM ocorrencias o
    JOIN condominiums c ON o.condominium_id = c.id 
    JOIN user_condominiums uc ON c.id = uc.condominium_id
    LEFT JOIN maintenance_users mu ON mu.id = o.assigned_maintenance_id
    WHERE uc.user_id = ? AND o.status = 'in_progress'
    ORDER BY o.created_at DESC
  `;

  db.all(sql, [userId], (err, workItems) => {
    if (err) {
      console.error('Error getting maintenance work:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Parse the latest_update JSON string for each work item
    const enrichedWorkItems = workItems.map(w => ({
      ...w,
      latest_update: w.latest_update ? JSON.parse(w.latest_update).comment : null,
      updated_at: w.latest_update ? JSON.parse(w.latest_update).created_at : null
    }));

    res.json(enrichedWorkItems);
  });
});

app.get('/api/admin/maintenance-users', (req, res) => {
  const sql = 'SELECT id, username, nome FROM maintenance_users ORDER BY nome';
  
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching maintenance users:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar utilizadores de manutenção' });
    }
    res.json(rows);
  });
});

// Upload images for an ocorrencia (maintenance can upload up to 5 images)
app.post('/api/ocorrencias/:id/images', uploadImages.array('images', 5), (req, res) => {
  const { id } = req.params;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Sem imagens para enviar' });

  const insertSql = `INSERT INTO ocorrencia_images (ocorrencia_id, filename, original_filename, file_path, mime_type, file_size) VALUES (?, ?, ?, ?, ?, ?)`;
  const inserted = [];
  let hasError = false;

  req.files.forEach(file => {
    const params = [id, file.filename, file.originalname, path.join('uploads', file.filename), file.mimetype, file.size];
    db.run(insertSql, params, function(err) {
      if (err) {
        console.error('Error inserting ocorrencia image metadata:', err.message);
        hasError = true;
      } else {
  inserted.push({ id: this.lastID, filename: file.filename, original: file.originalname, url: `${req.protocol}://${req.get('host')}/uploads/${file.filename}` });
      }
    });
  });

  // Simple delay to allow DB inserts to complete - sqlite runs callbacks synchronously in this loop but keep a short timeout
  setTimeout(() => {
    if (hasError) return res.status(500).json({ error: 'Erro ao salvar imagens' });
    res.json({ success: true, files: inserted });
  }, 100);
});

// List images for an ocorrencia
app.get('/api/ocorrencias/:id/images', (req, res) => {
  const { id } = req.params;
  const sql = 'SELECT id, filename, original_filename, file_path, mime_type, file_size, uploaded_at FROM ocorrencia_images WHERE ocorrencia_id = ? ORDER BY uploaded_at DESC';
  db.all(sql, [id], (err, rows) => {
    if (err) {
      console.error('Error fetching ocorrencia images:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar imagens' });
    }
    // Expose URLs for frontend
  const results = (rows || []).map(r => ({ ...r, url: `${req.protocol}://${req.get('host')}/uploads/${r.filename}` }));
    res.json(results);
  });
});

// ========================================
// END OCORRENCIAS ROUTES
// ========================================

// Data export endpoint for mobile app
app.get('/api/export-data', async (req, res) => {
  try {
    console.log('📦 Exporting all data for mobile app...');
    
    const exportData = {
      users: [],
      condominiums: [],
      assembleias: [],
      messages: [],
      assembleia_files: []
    };

    // Export users
    await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM users`, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          exportData.users = rows.map(user => ({
            id: user.id,
            Nome: user.nome,
            NIF: user.nif,
            password: user.password,
            "e-mail 1": user.email1,
            "e-mail 2": user.email2,
            "e-mail 3": user.email3,
            Telemovel: user.telemovel,
            Telefone: user.telefone,
            Grupo: user.grupo,
            condominiums: user.grupo ? `1:${user.grupo}:` : "",
            isAdmin: false
          }));
          resolve();
        }
      });
    });

    // Export admins and add them to users
    await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM admins`, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          rows.forEach(admin => {
            exportData.users.push({
              id: admin.id + 10000, // Offset to avoid ID conflicts
              Nome: "Admin User",
              NIF: admin.username,
              password: admin.password,
              "e-mail 1": "admin@domusgest.com",
              Telemovel: "123456789",
              isAdmin: true,
              condominiums: ""
            });
          });
          resolve();
        }
      });
    });

    // Export condominiums
    await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM condominiums`, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          exportData.condominiums = rows.map(condo => ({
            id: condo.id,
            name: condo.name,
            address: condo.address,
            created_at: condo.created_at
          }));
          resolve();
        }
      });
    });

    // Export assembleias
    await new Promise((resolve, reject) => {
      db.all(`
        SELECT a.*, c.name as condominium_name 
        FROM assembleias a 
        LEFT JOIN condominiums c ON a.condominium_id = c.id
      `, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          exportData.assembleias = rows.map(assembleia => ({
            id: assembleia.id,
            condominium_id: assembleia.condominium_id,
            title: assembleia.title,
            description: assembleia.description,
            date: assembleia.date,
            time: assembleia.time,
            location: assembleia.location,
            status: assembleia.status,
            condominium_name: assembleia.condominium_name,
            created_at: assembleia.created_at
          }));
          resolve();
        }
      });
    });

    // Export messages
    await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM messages`, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          exportData.messages = rows;
          resolve();
        }
      });
    });

    // Export assembleia files
    await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM assembleia_files`, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          exportData.assembleia_files = rows;
          resolve();
        }
      });
    });

    console.log('✅ Data export completed:', {
      users: exportData.users.length,
      condominiums: exportData.condominiums.length,
      assembleias: exportData.assembleias.length,
      messages: exportData.messages.length,
      assembleia_files: exportData.assembleia_files.length
    });

    res.json(exportData);
  } catch (error) {
    console.error('❌ Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ====== CONDOMINIUM MANAGEMENT ENDPOINTS ======

// Create new condominium
app.post('/api/condominiums', (req, res) => {
  const { name, nipc } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Nome do condomínio é obrigatório' });
  }

  const sql = 'INSERT INTO condominiums (name, nipc) VALUES (?, ?)';
  db.run(sql, [name, nipc || null], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Já existe um condomínio com este nome' });
      }
      console.error('Error creating condominium:', err.message);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
    
    res.status(201).json({
      message: 'Condomínio criado com sucesso',
      condominium: { id: this.lastID, name, nipc: nipc || null }
    });
  });
});

// Update condominium
app.put('/api/condominiums/:id', (req, res) => {
  const { id } = req.params;
  const { name, nipc } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Nome do condomínio é obrigatório' });
  }

  const sql = 'UPDATE condominiums SET name = ?, nipc = ? WHERE id = ?';
  db.run(sql, [name, nipc || null, id], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Já existe um condomínio com este nome' });
      }
      console.error('Error updating condominium:', err.message);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Condomínio não encontrado' });
    }
    
    res.json({ message: 'Condomínio atualizado com sucesso' });
  });
});



// ====== CSV IMPORT ENDPOINTS ======

// Import users from CSV file upload
const csvUpload = multer({ dest: 'uploads/' });
app.post('/api/import-users-csv', csvUpload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Ficheiro CSV é obrigatório' });
  }

  const { condominium_id } = req.body;
  
  if (!condominium_id) {
    return res.status(400).json({ error: 'Condomínio é obrigatório' });
  }

  let imported = 0;
  let errors = [];

  try {
  // Read the uploaded CSV file using UTF-8 so diacritics are preserved
  const csvContent = fs.readFileSync(req.file.path, 'utf8');
    const lines = csvContent.trim().split('\n');
    
    if (lines.length < 2) {
      return res.status(400).json({ error: 'Ficheiro CSV deve ter pelo menos uma linha de dados' });
    }

    // Parse header
    const headers = lines[0].split(';').map(h => h.trim());
    console.log('CSV Headers:', headers); // Debug log
    
    // Process data lines
    for (let i = 1; i < lines.length; i++) {
      try {
        const values = lines[i].split(';').map(v => v.trim());
        const row = {};
        
        headers.forEach((header, index) => {
          row[header] = values[index] || '';
        });

        // Extract data with flexible column matching
        const nome = row['Nome'] || '';
        const nif = row['NIF'] || '';
        const telemovel = row['Telemóvel'] || row['Telem\u00f3vel'] || row['Telemovel'] || '';
        const telefone = row['Telefone'] || '';
        const email1 = row['E-mail 1'] || '';
        const email2 = row['E-mail 2'] || '';
        const email3 = row['E-mail 3'] || '';

        if (!nome) {
          errors.push(`Linha ${i + 1}: Nome em falta`);
          continue;
        }

        // Insert user
        const userSql = `
          INSERT INTO users (nome, nif, telemovel, telefone, email1, email2, email3, password, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        const defaultPassword = '123456'; // Default password for imported users
        
        const userId = await new Promise((resolve, reject) => {
          db.run(userSql, [nome, nif || '', telemovel || '', telefone || '', email1 || '', email2 || '', email3 || '', defaultPassword], function(err) {
            if (err) {
              if (err.message.includes('UNIQUE constraint failed')) {
                errors.push(`Linha ${i + 1} (${Nome}): Utilizador já existe`);
              } else {
                errors.push(`Linha ${i + 1} (${Nome}): ${err.message}`);
              }
              reject(err);
            } else {
              resolve(this.lastID);
            }
          });
        });

        // Associate user with condominium
        const associationSql = `
          INSERT INTO user_condominiums (user_id, condominium_id, role)
          VALUES (?, ?, 'resident')
        `;
        
        await new Promise((resolve, reject) => {
          db.run(associationSql, [userId, condominium_id], function(err) {
            if (err) {
              errors.push(`Linha ${i + 1} (${Nome}): Erro ao associar ao condomínio: ${err.message}`);
              reject(err);
            } else {
              resolve();
            }
          });
        });

        imported++;
      } catch (rowError) {
        errors.push(`Linha ${i + 1}: ${rowError.message}`);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      message: `Importação concluída: ${imported} utilizadores importados e associados ao condomínio`,
      imported,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error importing CSV:', error);
    // Clean up uploaded file in case of error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Erro durante a importação' });
  }
});

// ====== USER PROFILE UPDATE ENDPOINTS ======

// Update user profile (for users to edit their own info)
app.put('/api/users/:id/profile', async (req, res) => {
  const { id } = req.params;
  const { nome, telemovel, telefone, email1, email2, email3 } = req.body;
  
  try {
    // Get current user data to compare changes
    const getCurrentUser = 'SELECT * FROM users WHERE id = ?';
    const currentUser = await new Promise((resolve, reject) => {
      db.get(getCurrentUser, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'Utilizador não encontrado' });
    }

    // Track changes
    const changes = [];
    if (nome !== currentUser.nome) changes.push({ field: 'nome', old: currentUser.nome, new: nome });
    if (telemovel !== currentUser.telemovel) changes.push({ field: 'telemovel', old: currentUser.telemovel, new: telemovel });
    if (telefone !== currentUser.telefone) changes.push({ field: 'telefone', old: currentUser.telefone, new: telefone });
    if (email1 !== currentUser.email1) changes.push({ field: 'email1', old: currentUser.email1, new: email1 });
    if (email2 !== currentUser.email2) changes.push({ field: 'email2', old: currentUser.email2, new: email2 });
    if (email3 !== currentUser.email3) changes.push({ field: 'email3', old: currentUser.email3, new: email3 });

    if (changes.length === 0) {
      return res.json({ message: 'Nenhuma alteração detetada' });
    }

    // Update user
    const updateSql = `
      UPDATE users 
      SET nome = ?, telemovel = ?, telefone = ?, email1 = ?, email2 = ?, email3 = ?
      WHERE id = ?
    `;
    
    await new Promise((resolve, reject) => {
      db.run(updateSql, [nome, telemovel, telefone, email1, email2, email3, id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Log changes
    for (const change of changes) {
      const logSql = 'INSERT INTO profile_changes (user_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?)';
      await new Promise((resolve, reject) => {
        db.run(logSql, [id, change.field, change.old, change.new], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Create notification for admins
    const changesList = changes.map(c => `${c.field}: "${c.old}" → "${c.new}"`).join(', ');
    // Determine user's primary condominium to attach to the notification
    let userPrimaryCondo = null;
    try {
      const rows = await new Promise((resolve, reject) => {
        db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [id], (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      });
      if (rows && rows.length > 0) userPrimaryCondo = rows[0].condominium_id;
    } catch (e) {
      console.warn('Error fetching user condominiums for profile change notification', e);
    }

    const notificationSql = `
      INSERT INTO notifications (type, user_id, user_name, title, message, related_id, condominium_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    const notificationId = await new Promise((resolve, reject) => {
      db.run(notificationSql, [
        'profile_change',
        id,
        currentUser.nome,
        'Perfil Atualizado',
        `${currentUser.nome} alterou: ${changesList}`,
        id,
        userPrimaryCondo
      ], function(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      });
    });

    // Link notification to appropriate admins based on user's condominiums
    console.log(`🔗 Linking profile update notification ${notificationId} for user ${id}...`);

    // Use our helper function to link to appropriate admins
    linkNotificationToAdmins(notificationId, id, (err, linkedCount) => {
      if (err) {
        console.error('Error linking profile update notification:', err.message);
      } else {
        console.log(`✅ Profile update notification linked to ${linkedCount} admin(s)`);
      }
      
      res.json({ 
        success: true,
        message: 'Perfil atualizado com sucesso',
        changes: changes.length
      });
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ====== NOTIFICATIONS ENDPOINTS ======

// Helper: read admin id from query, headers, or lookup by username
function getAdminIdFromReq(req) {
  let adminId = req.query.admin_id || req.headers['admin-id'] || req.headers['admin_id'];
  
  if (adminId) {
    return adminId;
  }
  
  // If no admin_id, try to get it from username
  const adminUsername = req.headers['admin-username'];
  if (adminUsername) {
    // This is async, but we'll handle it synchronously for now
    // In a real implementation, this should be async
    console.log('🔍 Looking up admin ID for username:', adminUsername);
    // For now, return null and handle in the endpoint
    return null;
  }
  
  return null;
}

// Get notifications for a specific admin (requires admin_id or admin permissions)
app.get('/api/notifications', (req, res) => {
  const adminId = getAdminIdFromReq(req);
  const adminPermissions = req.headers['admin-permissions'];
  
  if (!adminId && !adminPermissions) {
    return res.status(400).json({ error: 'admin_id or admin-permissions header is required' });
  }

  // If we have admin permissions but no admin_id, we can't filter by admin
  // So we'll return all notifications and let the frontend filter
  let sql;
  let params = [];
  
  sql = `
    SELECT n.*, 
      COALESCE(an.id, NULL) AS admin_notification_id, 
      COALESCE(an.read_status, 0) as read_status
    FROM notifications n
    INNER JOIN admin_notifications an ON n.id = an.notification_id 
      ${adminId ? 'AND an.admin_id = ?' : ''}
    WHERE 1=1
  `;
  
  if (adminId) {
    params.push(adminId);
  } else {
    // If no admin_id, we still need to ensure we only get notifications linked to some admin
    // This prevents orphaned notifications from appearing
    sql = sql.replace('WHERE 1=1', 'WHERE an.id IS NOT NULL');
  }

  // Check admin permissions for filtering
  console.log('🔍 /api/notifications endpoint called');
  console.log('   admin-permissions header:', adminPermissions);
  console.log('   admin_id:', adminId);
  
  const conditions = [];
  const allowedCondos = getAdminAllowedCondos(req);

  // Filter by admin permissions
  if (Array.isArray(allowedCondos)) {
    if (allowedCondos.length === 0) {
      // Limited admin with no condos = no access
      return res.json([]);
    }

    console.log('   Filtering notifications by allowed condominiums:', allowedCondos);
    const condoPlaceholders = allowedCondos.map(() => '?').join(',');
    // Join against related tables to scope notifications to admin's condominiums
    conditions.push(`
      (
        -- Show notifications for messages sent to admin's condos
        (
          n.type = 'admin_message'
          AND EXISTS (
            SELECT 1 FROM admin_message_condominiums amc
            WHERE amc.message_id = n.related_id 
              AND amc.condominium_id IN (${condoPlaceholders})
          )
        )
        OR
        -- Show notifications linked to users belonging to admin's condos
        (
          n.type IN ('complaint', 'request', 'reclamacao', 'pedido', 'profile_change')
          AND EXISTS (
            SELECT 1 FROM user_condominiums uc
            WHERE uc.user_id = n.user_id
              AND uc.condominium_id IN (${condoPlaceholders})
          )
        )
        OR
        -- Show ocorrencia / manutenção notifications scoped by ocorrencia condominium
        (
          n.type IN ('ocorrencia', 'new_ocorrencia', 'maintenance', 'maintenance_completed')
          AND EXISTS (
            SELECT 1 FROM ocorrencias o
            WHERE o.id = n.related_id
              AND o.condominium_id IN (${condoPlaceholders})
          )
        )
        OR
        -- Include assembleia/document style notifications that carry condominium_id directly
        (
          n.type IN ('assembleia', 'document', 'maintenance_completed')
          AND n.condominium_id IS NOT NULL
          AND n.condominium_id IN (${condoPlaceholders})
        )
    )
    `);
    // Add params 4 times since we use the array in 4 sub-queries/clauses
    params.push(...allowedCondos, ...allowedCondos, ...allowedCondos, ...allowedCondos);
  } else {
    console.log('   Admin has full access - showing all notifications');
  }

  if (conditions.length > 0) {
    sql += ' AND ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY n.created_at DESC LIMIT 100';

  console.log('   Final SQL:', sql);
  console.log('   Params:', params);

  const runNotificationQuery = (attempt = 1) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        const message = err && err.message ? err.message : String(err);
        console.error('Error fetching notifications (attempt ' + attempt + '):', message);

        if (attempt === 1) {
          if (message.includes('no such column:') && message.includes('condominium_id')) {
            console.warn('⚠️ Missing condominium_id column detected while fetching notifications; attempting migration...');
            return db.run("ALTER TABLE notifications ADD COLUMN condominium_id INTEGER", (alterErr) => {
              if (alterErr && !(alterErr.message || '').includes('duplicate column')) {
                console.error('Failed to add condominium_id column:', alterErr.message || alterErr);
                return res.status(500).json({ error: 'Database error', details: message });
              }
              console.log('✅ condominium_id column ensured on notifications table; retrying list query');
              return runNotificationQuery(attempt + 1);
            });
          }

          if (message.includes('no such table: admin_message_condominiums')) {
            console.warn('⚠️ Missing admin_message_condominiums table detected; creating table...');
            const createSql = `CREATE TABLE IF NOT EXISTS admin_message_condominiums (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              message_id INTEGER NOT NULL,
              condominium_id INTEGER NOT NULL,
              FOREIGN KEY (message_id) REFERENCES admin_messages (id) ON DELETE CASCADE,
              FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE
            )`;
            return db.run(createSql, (createErr) => {
              if (createErr) {
                console.error('Failed to create admin_message_condominiums table:', createErr.message || createErr);
                return res.status(500).json({ error: 'Database error', details: message });
              }
              console.log('✅ admin_message_condominiums table ensured; retrying notifications list');
              return runNotificationQuery(attempt + 1);
            });
          }
        }

        return res.status(500).json({ error: 'Database error', details: message });
      }

      console.log(`   Returning ${rows.length} notifications`);
      res.json(rows);
    });
  };

  runNotificationQuery();
});// Mark a notification as read for a specific admin
app.put('/api/notifications/:id/read', (req, res) => {
  const notificationId = req.params.id;
  const adminId = getAdminIdFromReq(req) || req.body.admin_id;
  const adminPermissions = req.headers['admin-permissions'];

  if (!adminId && !adminPermissions) {
    return res.status(400).json({ error: 'admin_id or admin-permissions header is required' });
  }

  // If no admin_id but we have permissions, we can't mark as read for a specific admin
  // This endpoint requires admin_id to know which admin is marking it as read
  if (!adminId) {
    return res.status(400).json({ error: 'admin_id is required to mark notification as read' });
  }

  const sql = 'UPDATE admin_notifications SET read_status = 1 WHERE notification_id = ? AND admin_id = ?';
  db.run(sql, [notificationId, adminId], function(err) {
    if (err) {
      console.error('Error marking admin notification as read:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Notification or admin mapping not found' });
    }

    res.json({ message: 'Notification marked as read for this admin' });
  });
});

// Mark all notifications as read for a specific admin
app.put('/api/notifications/mark-all-read', (req, res) => {
  const adminId = getAdminIdFromReq(req) || req.body.admin_id;
  const adminPermissions = req.headers['admin-permissions'];

  if (!adminId && !adminPermissions) {
    return res.status(400).json({ error: 'admin_id or admin-permissions header is required' });
  }

  if (!adminId) {
    return res.status(400).json({ error: 'admin_id is required to mark notifications as read' });
  }

  const sql = 'UPDATE admin_notifications SET read_status = 1 WHERE admin_id = ? AND read_status = 0';
  db.run(sql, [adminId], function(err) {
    if (err) {
      console.error('Error marking all notifications as read for admin:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    // Broadcast to admin SSE clients that notifications were cleared
    try { sendSseToAdmin(adminId, 'notifications_cleared', { admin_id: adminId, updated: this.changes || 0 }); } catch (e) { console.warn('Error broadcasting notifications_cleared SSE', e.message); }

    res.json({ message: 'All notifications marked as read for this admin', updated: this.changes });
  });
});

// Get unread notifications count for a specific admin
app.get('/api/notifications/unread-count', (req, res) => {
  try {
    const adminId = getAdminIdFromReq(req);
    if (!adminId) return res.status(400).json({ error: 'admin_id header is required' });

    const allowedCondos = getAdminAllowedCondos(req);
    
    // If limited admin with no condos, return 0
    if (Array.isArray(allowedCondos) && allowedCondos.length === 0) {
      return res.json({ count: 0 });
    }

    let sql = `
      SELECT COUNT(*) as count
      FROM notifications n
      JOIN admin_notifications an ON n.id = an.notification_id
      WHERE an.admin_id = ? AND an.read_status = 0
    `;

    const params = [adminId];
    
    // Apply filtering for limited-scope admins
    if (Array.isArray(allowedCondos) && allowedCondos.length > 0) {
      const condoPlaceholder = allowedCondos.map(() => '?').join(',');
      sql += ` AND (
        -- Admin messages: check via admin_message_condominiums
        (
          n.type = 'admin_message' AND EXISTS (
            SELECT 1 FROM admin_message_condominiums amc 
            WHERE amc.message_id = n.related_id 
              AND amc.condominium_id IN (${condoPlaceholder})
          )
        )
        OR
        -- User-related notifications: check via user_condominiums
        (
          n.type IN ('complaint', 'request', 'reclamacao', 'pedido', 'profile_change') AND EXISTS (
            SELECT 1 FROM user_condominiums uc
            WHERE uc.user_id = n.user_id
              AND uc.condominium_id IN (${condoPlaceholder})
          )
        )
        OR
        -- Ocorrencia / manutenção notifications: check via ocorrencias table
        (
          n.type IN ('ocorrencia', 'new_ocorrencia', 'maintenance', 'maintenance_completed') AND EXISTS (
            SELECT 1 FROM ocorrencias o
            WHERE o.id = n.related_id
              AND o.condominium_id IN (${condoPlaceholder})
          )
        )
        OR
        -- Direct condominium_id match for assembleias, documentos, etc.
        (
          n.type IN ('assembleia', 'document', 'maintenance_completed')
          AND n.condominium_id IS NOT NULL
          AND n.condominium_id IN (${condoPlaceholder})
        )
      )`;
      // Add params 4 times since we use the array in 4 subqueries/clauses
      params.push(...allowedCondos, ...allowedCondos, ...allowedCondos, ...allowedCondos);
    }

    console.log('🔍 Unread count SQL:', sql);
    console.log('🔍 Unread count params:', params);

    const runUnreadQuery = (attempt = 1) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          const message = err && err.message ? err.message : String(err);
          console.error('Error getting unread count (attempt ' + attempt + '):', message);

          if (attempt === 1) {
            if (message.includes('no such column:') && message.includes('condominium_id')) {
              console.warn('⚠️ Missing condominium_id column detected. Attempting on-the-fly migration...');
              return db.run("ALTER TABLE notifications ADD COLUMN condominium_id INTEGER", (alterErr) => {
                if (alterErr && !(alterErr.message || '').includes('duplicate column')) {
                  console.error('Failed to add condominium_id column:', alterErr.message || alterErr);
                  return res.status(500).json({ error: 'Database error', details: message });
                }
                console.log('✅ condominium_id column ensured on notifications table; retrying unread count');
                return runUnreadQuery(attempt + 1);
              });
            }

            if (message.includes('no such table: admin_message_condominiums')) {
              console.warn('⚠️ Missing admin_message_condominiums table detected. Creating table...');
              const createSql = `CREATE TABLE IF NOT EXISTS admin_message_condominiums (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                condominium_id INTEGER NOT NULL,
                FOREIGN KEY (message_id) REFERENCES admin_messages (id) ON DELETE CASCADE,
                FOREIGN KEY (condominium_id) REFERENCES condominiums (id) ON DELETE CASCADE
              )`;
              return db.run(createSql, (createErr) => {
                if (createErr) {
                  console.error('Failed to create admin_message_condominiums table:', createErr.message || createErr);
                  return res.status(500).json({ error: 'Database error', details: message });
                }
                console.log('✅ admin_message_condominiums table ensured; retrying unread count');
                return runUnreadQuery(attempt + 1);
              });
            }
          }

          return res.status(500).json({ error: 'Database error', details: message });
        }

        const count = row ? row.count : 0;
        console.log('✅ Unread count:', count);
        res.json({ count });
      });
    };

    runUnreadQuery();
  } catch (e) {
    console.error('Error in admin unread-count handler:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Get notifications for a specific user
app.get('/api/users/:userId/notifications', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  try {
    // First get all condominiums the user belongs to
    const condoSql = `
      SELECT DISTINCT c.id, c.name
      FROM condominiums c
      JOIN user_condominiums uc ON c.id = uc.condominium_id
      WHERE uc.user_id = ?
    `;
    
    db.all(condoSql, [userId], (err, condos) => {
      if (err) {
        console.error('Error getting user condominiums for notifications:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      const condoIds = condos.map(c => c.id);
      const condoNames = Object.fromEntries(condos.map(c => [c.id, c.name]));

      if (condoIds.length === 0) {
        return res.json([]); // User has no condominiums
      }

      const condoPlaceholders = condoIds.map(() => '?').join(',');

      // Ensure there are linkage entries for the user (legacy data backfill)
      const ensureLinksSql = `
        INSERT OR IGNORE INTO user_notifications (user_id, notification_id, read_status, created_at)
        SELECT ?, n.id, 0, CURRENT_TIMESTAMP
        FROM notifications n
        WHERE n.type IN ('admin_message', 'document', 'assembleia')
          AND (
            (n.type = 'admin_message' AND EXISTS (
              SELECT 1 FROM admin_message_condominiums amc
              WHERE amc.message_id = n.related_id
                AND amc.condominium_id IN (${condoPlaceholders})
            ))
            OR (n.type IN ('document', 'assembleia') AND n.condominium_id IN (${condoPlaceholders}))
          )
      `;

      const ensureParams = [userId, ...condoIds, ...condoIds];

      db.run(ensureLinksSql, ensureParams, (ensureErr) => {
        if (ensureErr) {
          console.warn('⚠️ Could not backfill user_notifications entries:', ensureErr.message || ensureErr);
        }

        // Get notifications for admin messages, documents, and assembleias for user's condominiums
        const notificationsSql = `
        SELECT 
          n.id,
          n.type,
          n.title,
          n.message,
          n.created_at,
          n.related_id,
          CASE
            WHEN n.type = 'admin_message' THEN (
              SELECT amc.condominium_id 
              FROM admin_message_condominiums amc 
              WHERE amc.message_id = n.related_id 
              LIMIT 1
            )
            WHEN n.type = 'document' THEN n.condominium_id
            WHEN n.type = 'assembleia' THEN n.condominium_id
          END as condominium_id,
          COALESCE(un.read_status, 0) as read_status
        FROM notifications n
        LEFT JOIN user_notifications un ON n.id = un.notification_id AND un.user_id = ?
        WHERE n.type IN ('admin_message', 'document', 'assembleia')
          AND (
            -- For admin messages: check if sent to user's condominiums
            (n.type = 'admin_message' AND EXISTS (
              SELECT 1 FROM admin_message_condominiums amc 
              WHERE amc.message_id = n.related_id 
              AND amc.condominium_id IN (${condoIds.map(() => '?').join(',')})
            ))
            -- For documents and assembleias: direct condominium_id match
            OR (n.type IN ('document', 'assembleia') AND n.condominium_id IN (${condoIds.map(() => '?').join(',')}))
          )
        ORDER BY n.created_at DESC
        LIMIT 100
      `;

        // Params: userId first, then condoIds twice (for admin messages and for documents/assembleias)
        const params = [userId, ...condoIds, ...condoIds];

        db.all(notificationsSql, params, (err, notifications) => {
          if (err) {
            console.error('Error getting user notifications:', err);
            return res.status(500).json({ error: 'Database error' });
          }

          // Add condominium name to each notification
          const enrichedNotifications = notifications.map(n => ({
            ...n,
            condominium_name: n.condominium_id ? condoNames[n.condominium_id] : null
          }));

          res.json(enrichedNotifications);
        });
      });
    });
  } catch (err) {
    console.error('Error in /users/:userId/notifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unread notifications count for a user
app.get('/api/users/:id/notifications/unread-count', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const sql = `
    SELECT COUNT(*) as count
    FROM notifications n
    JOIN user_notifications un ON n.id = un.notification_id
    WHERE un.user_id = ? AND un.read_status = 0
  `;

  db.get(sql, [userId], (err, row) => {
    if (err) {
      console.error('Error fetching unread user notifications count:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ count: row ? row.count : 0 });
  });
});

// Get ocorrências for a specific user (read-only view)
app.get('/api/users/:userId/ocorrencias', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  // Get all condominiums the user belongs to
  const sql = `
    SELECT DISTINCT 
      o.*,
      c.name as condominium_name,
      (
        SELECT ou.comment
        FROM ocorrencia_updates ou 
        WHERE ou.ocorrencia_id = o.id 
        ORDER BY ou.created_at DESC 
        LIMIT 1
      ) as latest_update,
      (
        SELECT ou.created_at
        FROM ocorrencia_updates ou 
        WHERE ou.ocorrencia_id = o.id 
        ORDER BY ou.created_at DESC 
        LIMIT 1
      ) as updated_at
    FROM ocorrencias o
    JOIN condominiums c ON o.condominium_id = c.id
    JOIN user_condominiums uc ON c.id = uc.condominium_id
    WHERE uc.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 100
  `;

  db.all(sql, [userId], (err, ocorrencias) => {
    if (err) {
      console.error('Error getting user ocorrencias:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(ocorrencias);
  });
});

// ====== RECLAMAÇÕES ENDPOINTS ======

// Submit reclamação
app.post('/api/reclamacoes', async (req, res) => {
  const { user_id, user_name, subject, message, condominium_id } = req.body;
  
  if (!user_name || !subject || !message) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  try {
    // Insert the reclamação into user_messages table
    const insertSql = `
      INSERT INTO user_messages (user_id, condominium_id, type, subject, message, status, created_at)
      VALUES (?, ?, 'complaint', ?, ?, 'open', CURRENT_TIMESTAMP)
    `;

    const messageId = await new Promise((resolve, reject) => {
      db.run(insertSql, [user_id, condominium_id, subject, message], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });

    // Decide which condominium this notification should be attached to
    // Prefer explicit condominium_id from request; otherwise lookup via user_condominiums for the user_id.
    let targetCondoIds = [];
    let condoToSet = null;
    if (condominium_id) {
      targetCondoIds = [String(condominium_id)];
      condoToSet = Number(condominium_id);
    } else if (user_id) {
      try {
        const rows = await new Promise((resolve, reject) => {
          db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [user_id], (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
          });
        });
        targetCondoIds = rows.map(r => String(r.condominium_id));
        if (targetCondoIds.length > 0) condoToSet = Number(targetCondoIds[0]);
      } catch (e) {
        console.warn('Error fetching user_condominiums for user', user_id, e);
        targetCondoIds = [];
        condoToSet = null;
      }
    }

    // Create notification for admins and include condominium_id so limited admins can filter directly
    const notificationSql = `
      INSERT INTO notifications (type, user_id, user_name, title, message, related_id, condominium_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    const notificationId = await new Promise((resolve, reject) => {
      db.run(notificationSql, [
        'reclamacao',
        user_id,
        user_name,
        `Nova Reclamação: ${subject}`,
        `${user_name} enviou uma reclamação: ${message}`,
        messageId,
        condoToSet
      ], (err) => {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });

    // Link notification to appropriate admins based on their permissions (scope/full vs limited)
    const admins = await new Promise((resolve, reject) => {
      db.all('SELECT id, username, scope, allowed_condominiums FROM admins', [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;

    await Promise.all(admins.map(admin => new Promise((resolve, reject) => {
      try {
        let allow = true;
        if (admin.scope && admin.scope === 'limited') {
          try {
            const allowed = normalizeAllowedCondominiums(admin.allowed_condominiums);
            console.log(`🔍 Admin ${admin.username} allowed_condominiums normalized:`, allowed);
            if (!Array.isArray(allowed) || allowed.length === 0) {
              allow = false;
            } else if (targetCondoIds.length > 0) {
              const numericTargets = targetCondoIds.map(x => Number(x));
              console.log('   targetCondoIds (numeric):', numericTargets);
              allow = numericTargets.some(id => allowed.includes(Number(id)));
            } else {
              allow = false;
            }
          } catch (e) {
            console.warn('Could not parse allowed_condominiums for admin', admin.id, e);
            allow = false;
          }
        }

        if (allow) {
          db.run(linkSql, [admin.id, notificationId], (err) => {
            if (err) return reject(err);
            resolve();
          });
        } else {
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    })));

    res.json({ message: 'Reclamação enviada com sucesso' });
  } catch (error) {
    console.error('Error submitting reclamação:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ====== PEDIDOS ENDPOINTS ======

// Submit pedido
app.post('/api/pedidos', async (req, res) => {
  const { user_id, user_name, subject, message, condominium_id } = req.body;
  
  if (!user_name || !subject || !message) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  try {
    // Insert the pedido into user_messages table
    const insertSql = `
      INSERT INTO user_messages (user_id, condominium_id, type, subject, message, status, created_at)
      VALUES (?, ?, 'request', ?, ?, 'open', CURRENT_TIMESTAMP)
    `;

    const messageId = await new Promise((resolve, reject) => {
      db.run(insertSql, [user_id, condominium_id, subject, message], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });

    // Create notification for admins
    const notificationSql = `
      INSERT INTO notifications (type, user_id, user_name, title, message, related_id, condominium_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    const notificationId = await new Promise((resolve, reject) => {
      db.run(notificationSql, [
        'pedido',
        user_id,
        user_name,
        `Novo Pedido: ${subject}`,
        `${user_name} enviou um pedido: ${message}`,
        messageId,
        condoPrimary
      ], (err) => {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });

    // Determine condominium IDs related to this pedido and compute primary condo
    let condoIds = [];
    let condoPrimary = null;
    try {
      if (condominium_id) {
        condoIds = [Number(condominium_id)];
        condoPrimary = Number(condominium_id);
      } else {
        const rows = await new Promise((resolve, reject) => {
          db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [user_id], (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
          });
        });
        condoIds = (rows || []).map(r => Number(r.condominium_id));
        if (condoIds.length > 0) condoPrimary = condoIds[0];
      }
    } catch (uErr) {
      console.warn('Could not determine condo for pedido notification', notificationId, uErr && uErr.message);
    }

    // Update admin linking logic to use condoPrimary/condoIds when filtering limited admins

    // Link notification to appropriate admins based on condominium
    console.log(`🔗 Linking pedido notification ${notificationId} for condominium ${condominium_id}...`);

    // Get all admins and their permissions  
    const adminsSql = 'SELECT id, username, scope, allowed_condominiums FROM admins';
    const admins = await new Promise((resolve, reject) => {
      db.all(adminsSql, [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    const adminLinksToCreate = [];

    // Determine which admins should receive this notification
    for (const admin of admins) {
      if (admin.scope === 'full') {
        // Full access admin - should receive all notifications
        adminLinksToCreate.push(admin.id);
        console.log(`👮 Admin ${admin.username} (full) should receive pedido notification`);
      } else if (admin.scope === 'limited') {
        try {
          const allowedCondos = normalizeAllowedCondominiums(admin.allowed_condominiums);
          if (allowedCondos.includes(Number(condominium_id))) {
            adminLinksToCreate.push(admin.id);
            console.log(`👮 Admin ${admin.username} (limited) should receive pedido notification for condo ${condominium_id}`);
          } else {
            console.log(`👮 Admin ${admin.username} (limited) should NOT receive pedido notification - no access to condo ${condominium_id}`);
          }
        } catch (parseErr) {
          console.error(`Error parsing allowed_condominiums for admin ${admin.username}:`, parseErr);
        }
      }
    }

    // Create admin_notifications links
    if (adminLinksToCreate.length > 0) {
      const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;
      await Promise.all(adminLinksToCreate.map(adminId => new Promise((resolve, reject) => {
        db.run(linkSql, [adminId, notificationId], (err) => {
          if (err) {
            console.error(`Error linking pedido notification ${notificationId} to admin ${adminId}:`, err.message);
            reject(err);
          } else {
            console.log(`✅ Linked pedido notification ${notificationId} to admin ${adminId}`);
            resolve();
          }
        });
      })));
      console.log(`✅ Successfully linked pedido notification to ${adminLinksToCreate.length} admin(s)`);
      try {
        for (let i = 0; i < adminLinksToCreate.length; i++) {
          const aid = adminLinksToCreate[i];
          sendSseToAdmin(aid, 'notification_created', { notification_id: notificationId, type: 'pedido', user_id, user_name, subject });
        }
      } catch (e) {
        console.warn('SSE broadcast error for pedido', e.message);
      }
    } else {
      console.log('⚠️ No admins found to receive this pedido notification');
    }

    res.json({ message: 'Pedido enviado com sucesso' });
  } catch (error) {
    console.error('Error submitting pedido:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ====== DELETE ENDPOINTS ======

// Delete user
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // First, get user info for notification
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT nome FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(404).json({ error: 'Utilizador não encontrado' });
    }

    // Delete user relationships first
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM user_condominiums WHERE user_id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Delete user messages
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM user_messages WHERE user_id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Delete the user
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });

    // Create notification
    const notificationSql = `
      INSERT INTO notifications (type, title, message)
      VALUES (?, ?, ?)
    `;
    
    await new Promise((resolve, reject) => {
      db.run(notificationSql, [
        'user_deleted',
        'Utilizador Eliminado',
        `O utilizador "${user.nome}" foi eliminado do sistema`
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ message: 'Utilizador eliminado com sucesso' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Submit a new user message (complaint or request)
app.post('/api/messages', (req, res) => {
  const { userId, condominiumId, type, subject, message } = req.body;

  if (!userId || !type || !subject || !message) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  const insertMessageSql = `
    INSERT INTO user_messages (user_id, condominium_id, type, subject, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP)
  `;

  db.run(insertMessageSql, [userId, condominiumId || null, type, subject, message], function(err) {
    if (err) {
      console.error('Error creating user message:', err.message);
      return res.status(500).json({ error: 'Erro ao submeter a mensagem' });
    }

    const messageId = this.lastID;

    // Now, create a notification for the admin
    db.get('SELECT nome FROM users WHERE id = ?', [userId], async (userErr, user) => {
      if (userErr) {
        console.error('Error fetching user name for notification:', userErr.message);
        return res.status(201).json({ success: true, message: 'Mensagem enviada com sucesso, mas não foi possível criar a notificação.', messageId });
      }

      if (!user) {
        console.error('User not found for notification creation, userId:', userId);
        return res.status(201).json({ success: true, message: 'Mensagem enviada com sucesso, mas o utilizador não foi encontrado para a notificação.', messageId });
      }

      const notificationType = type === 'complaint' ? 'reclamacao' : 'pedido';
      const notificationTitle = `Nova ${notificationType}: ${subject}`;
      const notificationMessage = `Recebeu uma nova ${notificationType} de ${user.nome}.`;

      // Determine which condominium(s) this notification relates to
      let condoIds = [];
      let condoPrimary = null;
      if (condominiumId) {
        condoIds = [Number(condominiumId)];
        condoPrimary = Number(condominiumId);
      } else {
        try {
          const rows = await new Promise((resolve, reject) => {
            db.all('SELECT condominium_id FROM user_condominiums WHERE user_id = ?', [userId], (err, rows) => {
              if (err) return reject(err);
              resolve(rows || []);
            });
          });
          condoIds = (rows || []).map(r => Number(r.condominium_id));
          if (condoIds.length > 0) condoPrimary = condoIds[0];
        } catch (e) {
          console.warn('Error fetching user_condominiums for messages notification', e);
        }
      }

      // Insert notification with condominium_id so limited admins can be filtered
      const insertNotificationSql = `
        INSERT INTO notifications (type, user_id, user_name, title, message, condominium_id, related_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;

      db.run(insertNotificationSql, [notificationType, userId, user.nome, notificationTitle, notificationMessage, condoPrimary, messageId], function(notifErr) {
        if (notifErr) {
          console.error('Error creating notification:', notifErr.message);
          return res.status(201).json({ success: true, message: 'Mensagem enviada com sucesso, mas ocorreu um erro ao criar a notificação.', messageId });
        }

        const notificationId = this.lastID;
        console.log(`✅ Notification ${notificationId} created for new ${notificationType} from user ${user.nome}`);

        // Link to admins based on permissions
        db.all('SELECT id, username, scope, allowed_condominiums FROM admins', [], (adminErr, admins) => {
          if (adminErr) {
            console.error('Error getting admins for notification linking:', adminErr.message);
            return res.status(201).json({ success: true, message: 'Mensagem enviada com sucesso, mas ocorreu um erro ao obter os administradores.', messageId });
          }

          const adminLinksToCreate = [];
          for (const admin of (admins || [])) {
            if (admin.scope === 'full') {
              adminLinksToCreate.push(admin.id);
            } else if (admin.scope === 'limited' && admin.allowed_condominiums) {
              try {
                let allowed = admin.allowed_condominiums;
                if (typeof allowed === 'string') {
                  try { allowed = JSON.parse(allowed); } catch (e) { allowed = []; }
                }
                allowed = (Array.isArray(allowed) ? allowed.map(x => Number(x)) : []);
                const numericTargets = condoIds.map(x => Number(x));
                if (numericTargets.some(id => allowed.includes(id))) adminLinksToCreate.push(admin.id);
              } catch (e) {
                console.warn('Error parsing allowed_condominiums for admin', admin.id, e);
              }
            }
          }

          if (adminLinksToCreate.length === 0) {
            return res.status(201).json({ success: true, message: 'Mensagem enviada com sucesso, mas nenhum administrador foi encontrado para receber a notificação.', messageId });
          }

          const linkSql = `INSERT OR IGNORE INTO admin_notifications (admin_id, notification_id, read_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`;
          const linkPromises = adminLinksToCreate.map(aid => new Promise((resolve) => {
            db.run(linkSql, [aid, notificationId], (err) => {
              if (err) return resolve({ ok: false, id: aid });
              try { sendSseToAdmin(aid, 'notification_created', { notification_id: notificationId, type: notificationType, user_id: userId, user_name: user.nome, subject }); } catch (e) { /* ignore */ }
              return resolve({ ok: true, id: aid });
            });
          }));

          Promise.all(linkPromises).then(results => {
            const linked = results.filter(r => r.ok).length;
            return res.status(201).json({ success: true, message: `Mensagem enviada com sucesso e notificação enviada para ${linked} administrador(es)!`, messageId });
          }).catch(e => {
            console.error('Error linking notifications to admins:', e);
            return res.status(201).json({ success: true, message: 'Mensagem enviada com sucesso, mas ocorreu um erro ao ligar a notificação aos administradores.', messageId });
          });
        });
      });
    });
  });
});

// Get all messages for a specific user
app.get('/api/users/:userId/messages', (req, res) => {
  const { userId } = req.params;
  
  const sql = `
    SELECT m.*, c.name as condominium_name
    FROM user_messages m
    JOIN condominiums c ON m.condominium_id = c.id
    WHERE m.user_id = ?
    ORDER BY m.created_at DESC
  `;
  
  db.all(sql, [userId], (err, rows) => {
    if (err) {
      console.error('Error fetching user messages:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else {
      res.json(rows);
    }
  });
});

// Get a single message by ID (for admin purposes)
app.get('/api/messages/:id', (req, res) => {
  const messageId = req.params.id;
  
  const sql = `
    SELECT 
      m.*,
      u.nome as user_name,
      c.name as condominium_name
    FROM user_messages m
    JOIN users u ON m.user_id = u.id
    JOIN condominiums c ON m.condominium_id = c.id
    WHERE m.id = ?
  `;
  
  db.get(sql, [messageId], (err, message) => {
    if (err) {
      console.error('Error fetching message:', err.message);
      res.status(500).json({ error: 'Database error' });
    } else if (!message) {
      res.status(404).json({ error: 'Message not found' });
    } else {
      res.json(message);
    }
  });
});

// Update message (admin)
app.put('/api/messages/:id', (req, res) => {
  const messageId = req.params.id;
  const { status, admin_response } = req.body;
  
  const sql = `
    UPDATE user_messages 
    SET status = ?, admin_response = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  
  db.run(sql, [status, admin_response, messageId], function(err) {
    if (err) {
      console.error('Error updating message:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Return updated message
    const selectSql = `
      SELECT m.*, c.name as condominium_name, u.nome as user_name, u.nif as user_nif
      FROM user_messages m
      JOIN condominiums c ON m.condominium_id = c.id
      JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `;
    
    db.get(selectSql, [messageId], (err, message) => {
      if (err) {
        return res.status(500).json({ error: 'Error retrieving updated message', details: err.message });
      }
      res.json(message);
    });
  });
});

// Delete message (admin)
app.delete('/api/messages/:id', (req, res) => {
  const messageId = req.params.id;
  
  db.run('DELETE FROM user_messages WHERE id = ?', [messageId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    res.json({ message: 'Message deleted successfully' });
  });
});
// Start server
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
