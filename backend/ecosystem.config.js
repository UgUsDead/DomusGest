const path = require('path');

const defaultDbPath = path.join('C:', 'DomusGest', 'data', 'domusgest.db');

module.exports = {
  apps: [
    {
      name: 'domusgest-backend',
      script: path.join(__dirname, 'server.js'),
      cwd: __dirname,
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.PORT || '5000',
        DB_PATH: process.env.DB_PATH || defaultDbPath
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M'
    }
  ]
};
