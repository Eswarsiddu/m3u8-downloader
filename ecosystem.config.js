// Start with:  pm2 start ecosystem.config.js
//
// Settings (PORT, DOWNLOAD_DIR, MAX_CONCURRENT, APP_PASSWORD, TMDB keys, ...) live in the .env file next to
// server.js - see .env.example. Don't repeat them here: variables set by pm2 override .env, which is how a
// stale PORT here used to win over the one in .env.
module.exports = {
  apps: [
    {
      name: 'stream-downloader',
      script: 'server.js',
      instances: 1,          // keep at 1: the download queue lives in this process
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
