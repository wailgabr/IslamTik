#!/bin/bash
# ============================================
# نشر إسلام تيك على Cloudflare Workers + D1 + R2
# ============================================
set -e

echo "▀▄▀▄▀▄ 🚀 نشر إسلام تيك على Cloudflare ▄▀▄▀▄▀"
echo ""

# 1. تأكد من وجود wrangler
if ! npx wrangler --version &>/dev/null; then
  echo "❌ wrangler غير مثبت، شغّل: npm install"
  exit 1
fi

# 2. تسجيل الدخول إلى Cloudflare
echo "📌 الخطوة 1: سجل الدخول إلى Cloudflare"
echo "   (سيتم فتح المتصفح للمصادقة)"
npx wrangler login || {
  echo "⚠️  فشل تسجيل الدخول. جرب استخدام API token:"
  echo "   export CLOUDFLARE_API_TOKEN=your_token"
  exit 1
}

# 3. إنشاء قاعدة D1
echo ""
echo "📌 الخطوة 2: إنشاء قاعدة D1"
DB_EXISTS=$(npx wrangler d1 list 2>/dev/null | grep islamtok-db || true)
if [ -z "$DB_EXISTS" ]; then
  npx wrangler d1 create islamtok-db --json 2>/dev/null | grep -o '"database_id":"[^"]*"' | cut -d'"' -f4 > /tmp/d1_id.txt
  D1_ID=$(cat /tmp/d1_id.txt)
  echo "   ✅ تم إنشاء D1 database id: $D1_ID"
else
  D1_ID=$(npx wrangler d1 list --json 2>/dev/null | python3 -c "import sys,json; d=[x for x in json.load(sys.stdin) if x['name']=='islamtok-db']; print(d[0]['uuid'] if d else '')")
  echo "   ✅ قاعدة D1 موجودة مسبقاً"
fi

# 4. تحديث wrangler.toml بالـ database_id
if [ -n "$D1_ID" ]; then
  sed -i "s/database_id = \".*\"/database_id = \"$D1_ID\"/" wrangler.toml
  echo "   ✅ تم تحديث wrangler.toml"
fi

# 5. إنشاء R2 bucket
echo ""
echo "📌 الخطوة 3: إنشاء مخزن R2"
npx wrangler r2 bucket create islamtok-videos 2>/dev/null || echo "   ✅ مخزن R2 موجود مسبقاً"

# 6. تهيئة قاعدة البيانات
echo ""
echo "📌 الخطوة 4: تهيئة قاعدة البيانات"
npx wrangler d1 execute islamtok-db --file=schema.sql 2>&1 | tail -3
echo "   ✅ تم إنشاء الجداول"

# 7. تعيين JWT_SECRET
echo ""
echo "📌 الخطوة 5: تعيين JWT_SECRET"
if [ -z "$(npx wrangler secret list 2>/dev/null | grep JWT_SECRET)" ]; then
  JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || date +%s | md5sum | head -c 32)
  echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET 2>&1 | tail -1
  echo "   ✅ تم تعيين JWT_SECRET"
else
  echo "   ✅ JWT_SECRET موجود مسبقاً"
fi

# 8. إنشاء مستخدم المشرف وائل
echo ""
echo "📌 الخطوة 6: إنشاء مستخدم المشرف"
npx wrangler d1 execute islamtok-db --command="INSERT OR IGNORE INTO users (username, email, password, role) VALUES ('وائل', 'wailgabr155@gmail.com', '$(echo -n "123456" | sha256sum | cut -d' ' -f1)', 'admin');" 2>&1 | tail -2
echo "   ✅ مستخدم المشرف: wailgabr155@gmail.com / 123456"

# 9. النشر
echo ""
echo "📌 الخطوة 7: النشر على Cloudflare Workers"
npx wrangler deploy 2>&1 | tail -5

echo ""
echo "▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄"
echo ""
echo "✅ تم النشر بنجاح!"
echo ""
echo "📱 رابط التطبيق: https://islamtok.YourSubdomain.workers.dev"
echo "📧 المشرف: wailgabr155@gmail.com / 123456"
echo ""
echo "⚡ بعد النشر، حدّث ملف capacitor.config.json"
echo "   وغير الرابط إلى رابط التطبيق المنشور"
echo "   ثم ابنِ APK جديد"
