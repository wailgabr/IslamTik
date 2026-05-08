// ============================================
// PM2 Ecosystem - إدارة عملية إسلام تيك
// ⚠️ لا تستخدم مسافات في مسارات الخادم أبداً
// ============================================
export default {
  apps: [
    {
      name: 'islamtok-api',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // ⚠️ المفتاح الحقيقي يُقرأ من .env عبر dotenv في server.js
        // JWT_SECRET يُحمّل من متغير البيئة مباشرة
      },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
