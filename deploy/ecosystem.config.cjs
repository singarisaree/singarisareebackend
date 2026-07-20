/** PM2 process manager — run from backend/:  pm2 start ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: 'singari-api',
      script: 'dist/server.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
