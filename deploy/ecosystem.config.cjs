// PM2 Ecosystem Config
// Usage: pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'th79-hrm',
    script: 'src/server.js',
    cwd: '/var/www/th79-hrm-backend',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/th79-hrm-error.log',
    out_file: '/var/log/th79-hrm-out.log',
    // Auto-restart on crash
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000
  }]
};