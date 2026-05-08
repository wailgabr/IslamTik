#!/usr/bin/env bash
# ============================================
# مراقبة خادم إسلام تيك - ينفذ كل 5 دقائق
# يقيس "صحة الخدمة" لا "سلوك المستخدم"
# ⚠️ لا تستخدم مسافات في المسارات
# ============================================
set -uo pipefail

# ⚠️ مسار المشروع (بدون مسافات)
PROJECT_DIR="/home/aimanqaid/deentok-prod"
LOG_FILE="$PROJECT_DIR/logs/monitor.log"
BACKUP_DIR="/backups/islamtok"
TELEGRAM_WEBHOOK=""  # ضع رابط webhook هنا: https://api.telegram.org/bot<TOKEN>/sendMessage
TELEGRAM_CHAT_ID=""  # ضع Chat ID هنا

# دوال مساعدة
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

alert() {
    local msg="$1"
    log "⚠️ تنبيه: $msg"
    # Telegram تنبيه عبر (اختياري)
    if [ -n "$TELEGRAM_WEBHOOK" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
        curl -s -X POST "$TELEGRAM_WEBHOOK" \
            -d "chat_id=$TELEGRAM_CHAT_ID" \
            -d "text=⚠️ إسلام تيك - $msg" \
            -o /dev/null 2>&1
    fi
}

mkdir -p "$(dirname "$LOG_FILE")"

# ============================================
# 1. التحقق من عملية PM2
# ============================================
# لماذا: نضمن أن الخادم يعمل ليتمكن المستخدمون من الانتفاع بالمحتوى
if command -v pm2 &>/dev/null; then
    PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    procs = json.load(sys.stdin)
    api = [p for p in procs if p.get('name') == 'islamtok-api']
    if not api:
        print('DOWN')
    else:
        status = api[0].get('pm2_env', {}).get('status', 'unknown')
        print(status)
except:
    print('ERROR')
" 2>/dev/null)

    if [ "$PM2_STATUS" != "online" ]; then
        alert "عملية islamtok-api غير متصلة (الحالة: $PM2_STATUS)"
        pm2 start "$PROJECT_DIR/ecosystem.config.js" --env production 2>&1 | log
        log "تمت محاولة إعادة تشغيل islamtok-api"
    else
        log "✅ islamtok-api متصلة"
    fi
else
    log "⚠️ pm2 غير مثبت - يتم تخطي فحص العملية"
fi

# ============================================
# 2. التحقق من مساحة القرص
# ============================================
# لماذا: امتلاء القرص يمنع رفع الفيديوهات الجديدة ويوقف النسخ الاحتياطي
DISK_USAGE=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 90 ]; then
    alert "مساحة القرص: $DISK_USAGE% (تجاوزت 90%)"
elif [ "$DISK_USAGE" -gt 80 ]; then
    log "⚠️ مساحة القرص: $DISK_USAGE% (تنبيه مبكر)"
else
    log "✅ مساحة القرص: $DISK_USAGE%"
fi

# ============================================
# 3. التحقق من آخر نسخ احتياطي
# ============================================
# لماذا: المحتوى الديني يجب الحفاظ عليه، التأكد من عدم انقطاع النسخ
if [ -d "$BACKUP_DIR" ]; then
    LATEST_BACKUP=$(find "$BACKUP_DIR" -name 'islamtok-*.db.gz' -type f 2>/dev/null | sort | tail -1)
    if [ -z "$LATEST_BACKUP" ]; then
        alert "لا توجد نسخ احتياطي على الإطلاق!"
    else
        BACKUP_AGE=$(( ( $(date +%s) - $(stat -c %Y "$LATEST_BACKUP") ) / 3600 ))
        if [ "$BACKUP_AGE" -gt 24 ]; then
            alert "آخر نسخ احتياطي منذ $BACKUP_AGE ساعة (> 24 ساعة)"
        else
            log "✅ آخر نسخ احتياطي قبل $BACKUP_AGE ساعات"
        fi
    fi
else
    alert "مجلد النسخ الاحتياطي $BACKUP_DIR غير موجود"
fi

log "------------------------------"
