#!/usr/bin/env bash
# ============================================
# النسخ الاحتياطي التلقائي لقاعدة بيانات إسلام تيك
# ينفذ كل 6 ساعات عبر cron
# ⚠️ لا تستخدم مسافات في مسارات الخادم أبداً
# ============================================
set -uo pipefail

# ⚠️ تم تغيير المسار: بدون مسافات
DB_PATH="/home/aimanqaid/deentok-prod/islamtok.db"
BACKUP_DIR="/backups/islamtok"
RETENTION_DAYS=7

# إنشاء مجلد النسخ إذا لم يوجد
mkdir -p "$BACKUP_DIR"

# =============================================
# نسخ آمن عبر sqlite3 .backup (بدلاً من cp)
# يضمن عدم تلف الملف أثناء الكتابة من التطبيق
# =============================================
if sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/islamtok-$(date +%Y%m%d-%H%M).db'"; then
    # ضغط لتوفير المساحة
    gzip -f "$BACKUP_DIR/islamtok-$(date +%Y%m%d-%H%M).db"
    echo "[$(date)] ✔ تم النسخ: islamtok-$(date +%Y%m%d-%H%M).db.gz"

    # حذف النسخ الأقدم من 7 أيام (فقط إذا نجح النسخ)
    find "$BACKUP_DIR" -name 'islamtok-*.db.gz' -mtime +$RETENTION_DAYS -delete
else
    echo "[$(date)] ✗ فشل النسخ الاحتياطي!" >&2
    exit 1
fi
