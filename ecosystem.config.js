// Start with:  pm2 start ecosystem.config.js
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
        PORT: 3000,
        // Folder where finished files are saved:
        DOWNLOAD_DIR: '/home/ubuntu/downloads',
        // How many items download at the same time:
        MAX_CONCURRENT: 1,
        // TMDB name lookup (optional; without them Wikidata is used). You can also put these in a .env file.
        // TMDB_READ_KEY: 'your TMDB "API Read Access Token" (v4, starts with eyJ)',
        // TMDB_API_KEY: 'your TMDB "API Key" (v3)',
        // Turn on a login prompt (strongly recommended on a public server):
        // APP_USER: 'admin',
        // APP_PASSWORD: 'change-me',
      },
    },
  ],
};
