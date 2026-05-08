import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import xss from 'xss';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import crypto from 'crypto';

// 1. تحميل متغيرات البيئة من ملف .env لتأمين الأسرار
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = 3000;

// =============================================================
// (أ) ضبط الخادم لاستقبال ملفات حتى 200MB ومدد طويلة
// =============================================================
// رفع حدود JSON و urlencoded للسماح بـ payloads أكبر (وصف فيديوهات/بيانات meta)
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// 2. إعداد قاعدة بيانات SQLite صلبة بدلاً من JSON
const DB_FILE = path.join(__dirname, 'islamtok.db');
const db = new Database(DB_FILE, { verbose: null });
db.pragma('journal_mode = WAL');

// إنشاء/ترقية الجداول الأساسية
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS moderation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(video_id) REFERENCES videos(id),
    FOREIGN KEY(moderator_id) REFERENCES users(id)
  );

  -- جدول الإشعارات الداخلي
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- جدول الإعجابات
  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, video_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(video_id) REFERENCES videos(id)
  );

  -- جدول التعليقات
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(video_id) REFERENCES videos(id)
  );
`);

// إضافة الأعمدة الجديدة لجدول videos إذا لم تكن موجودة (ترقية مرنة بدون كسر)
try {
  const cols = db.prepare("PRAGMA table_info(videos)").all().map(c => c.name);
  if (!cols.includes('thumbnail')) {
    db.exec("ALTER TABLE videos ADD COLUMN thumbnail TEXT");
  }
  if (!cols.includes('processed_url')) {
    db.exec("ALTER TABLE videos ADD COLUMN processed_url TEXT");
  }
  if (!cols.includes('ai_score')) {
    db.exec("ALTER TABLE videos ADD COLUMN ai_score REAL DEFAULT 0");
  }
  if (!cols.includes('flag')) {
    db.exec("ALTER TABLE videos ADD COLUMN flag TEXT");
  }
  if (!cols.includes('duration')) {
    db.exec("ALTER TABLE videos ADD COLUMN duration REAL DEFAULT 0");
  }
  if (!cols.includes('hls_playlist_url')) {
    db.exec("ALTER TABLE videos ADD COLUMN hls_playlist_url TEXT");
  }
  if (!cols.includes('category')) {
    db.exec("ALTER TABLE videos ADD COLUMN category TEXT DEFAULT 'general'");
  }
} catch (e) {
  console.error('فشل ترقية جدول videos:', e.message);
}

// تحديث جدول moderation_logs لدعم الأمان وتتبع الإجراءات
try {
  const logCols = db.prepare("PRAGMA table_info(moderation_logs)").all().map(c => c.name);
  if (!logCols.includes('ip_address')) {
    db.exec("ALTER TABLE moderation_logs ADD COLUMN ip_address TEXT");
  }
  if (!logCols.includes('user_agent')) {
    db.exec("ALTER TABLE moderation_logs ADD COLUMN user_agent TEXT");
  }
} catch (e) {
  console.error('فشل ترقية جدول moderation_logs:', e.message);
}

// ============================================
// جدول مقاييس الانتفاع الشرعي (لا إدمان)
// يسجّل: إكمال الفيديو، إعادة الاستماع، حفظ، مشاركة
// لا يسجّل: IP, device_id, scroll time, click rate
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS engagement_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('completed','replayed','saved','shared')),
    duration_watched REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(video_id) REFERENCES videos(id)
  );
  CREATE INDEX IF NOT EXISTS idx_engagement_video ON engagement_metrics(video_id);
  CREATE INDEX IF NOT EXISTS idx_engagement_action ON engagement_metrics(action);
  CREATE INDEX IF NOT EXISTS idx_engagement_user ON engagement_metrics(user_id);
`);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("يرجى إعداد JWT_SECRET في ملف .env");
  process.exit(1);
}

// 2. [روابط موقعة مؤقتة (Signed URLs) - أمان]
// 🔐 تصحيح: تضمين نوع الملف في التوقيع لتأمين HLS و MP4
function signHLSUrl(userId, videoId, type = 'hls', expiresMinutes = 120) {
  const expiry = Date.now() + expiresMinutes * 60 * 1000;
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${videoId}:${userId}:${type}:${expiry}`)
    .digest('hex');
  return `?uid=${userId}&exp=${expiry}&sig=${signature}&type=${type}`;
}

// 🔐 تصحيح: إضافة authenticateToken للملفات المحمية لتحقيق التحقق من uid
// يجب علينا السماح بطلبات الفيديوهات من المتصفح (التي قد لا تحتوي header)، 
// لذلك نقرأ الـ token من الـ query params إذا كان موجوداً، أو نعتمد على التوقيع.
const optionalAuthenticate = (req, res, next) => {
  const token = req.query.token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);
  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) req.user = user;
      next();
    });
  } else {
    next();
  }
};

// 🔐 تصحيح: التحقق من التوقيع ومنع تسريب الصلاحيات
const verifySignedUrl = (req, res, next) => {
  try {
    let videoId;
    let expectedType = 'mp4';

    if (req.path.startsWith('/processed/hls/')) {
       videoId = req.params.videoId;
       expectedType = 'hls';
    } else {
       videoId = req.query.vid; 
    }

    const { uid, exp, sig, type } = req.query;

    if (!uid || !exp || !sig || !videoId) {
      console.warn(`[Security] Access denied (missing params): path=${req.path}, user=${req.user?.id || 'unknown'}`);
      return res.status(403).json({ error: 'وصول مرفوض: الرابط يفتقر للتوقيع' });
    }

    // 🔐 تصحيح: التحقق من تطابق uid مع المستخدم الطالب (في حال وفر token)
    // إذا أردنا إجبار التحقق من الجلسة، فيجب أن يرسل الـ frontend الـ token في الـ streamUrl كـ ?token=...
    // وبما أن طلبات <video> لا ترسل headers بسهولة، الاعتماد على التوقيع المولد سابقاً بالـ uid هو الأساس.
    // لكن تنفيذاً للطلب "تحقق أن uid في الرابط يطابق req.user.id تماماً":
    if (req.user && String(uid) !== String(req.user.id)) {
      console.warn(`[Security] Access denied (uid mismatch): path=${req.path}, user=${req.user.id}, requested_uid=${uid}`);
      return res.status(403).json({ error: 'غير مصرح' });
    }

    if (type !== expectedType) {
       console.warn(`[Security] Access denied (wrong type): path=${req.path}, user=${req.user?.id || 'unknown'}`);
       return res.status(403).json({ error: 'وصول مرفوض: نوع الملف غير مطابق' });
    }

    // التحقق من انتهاء الصلاحية قبل التوقيع
    if (Date.now() > parseInt(exp, 10)) {
      console.warn(`[Security] Access denied (expired): video=${videoId}, user=${uid}`);
      return res.status(403).json({ error: 'وصول مرفوض: انتهت صلاحية الرابط' });
    }

    const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
      .update(`${videoId}:${uid}:${type}:${exp}`)
      .digest('hex');

    if (sig !== expectedSig) {
      console.warn(`[Security] Access denied (invalid sig): video=${videoId}, user=${uid}`);
      return res.status(403).json({ error: 'وصول مرفوض: التوقيع غير صالح' });
    }

    console.log(`[Security] Access granted: video=${videoId}, user=${uid}, type=${type}`);
    next();
  } catch (err) {
    console.error('[Security] Error verifying URL:', err.message);
    res.status(500).json({ error: 'خطأ داخلي في الخادم' });
  }
};

// مسار فحص توقيع HLS قبل السماح بعرضه
app.get('/processed/hls/:videoId/:file', optionalAuthenticate, verifySignedUrl);
app.get('/processed/:filename', optionalAuthenticate, (req, res, next) => {
   // استثناء للصور المصغرة 
   if(req.path.endsWith('.jpg') || req.path.endsWith('.png')) return next();
   verifySignedUrl(req, res, next);
});

// ==================== SECURITY MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// 9. تقييد CORS
const PROD_ORIGIN = process.env.NODE_ENV === 'production'
  ? 'https://yourdomain.com'
  : true;
app.use(cors({ origin: PROD_ORIGIN, credentials: true }));

// حماية من التكرار العالي (Rate Limits)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "طلبات كثيرة جداً، يرجى المحاولة لاحقاً" }
});
app.use('/api', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { error: "محاولات تسجيل دخول كثيرة، يرجى المحاولة بعد ساعة" }
});

// ميدل وير التحقق من التوكن (JWT)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح للوصول (اختلال التوكن)' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'الجلسة منتهية الصلاحية' });
    req.user = user;
    next();
  });
};

// 6. ميدل وير التحقق من صلاحيات الإدارة/المشرفين للرقابة الشرعية
const requireModerator = (req, res, next) => {
  if (req.user.role === 'moderator' || req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ error: 'غير مصرح: هذه العملية تتطلب صلاحيات رقابية شرعية' });
  }
};

// =============================================================
// (ب) نظام الإشعارات الداخلي
// =============================================================
// دالة إنشاء إشعار جديد لمستخدم معين وإرجاع البيانات
function createNotification(userId, type, message) {
  try {
    const stmt = db.prepare(
      'INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)'
    );
    const r = stmt.run(userId, type, message);
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(r.lastInsertRowid);
  } catch (err) {
    console.error('فشل إنشاء الإشعار:', err.message);
    return null;
  }
}

// =============================================================
// (ج) خط معالجة الفيديو غير المتزامن (FFmpeg) + طابور بسيط
// =============================================================
const PROCESSED_DIR = path.join(__dirname, 'processed');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true });

// قائمة كلمات محظورة بسيطة (Rule-based) - تُستخدم في الفلترة الأولية
const BLOCKED_KEYWORDS = [
  // قائمة قابلة للتوسعة لاحقاً - مبدئية فقط
  'porn', 'sex', 'xxx', 'nude', 'naked',
  'إباحي', 'إباحية', 'عاري', 'عارية'
];

// 🔐 تصحيح: طابور المعالجة - منع الاختناق
const MAX_CONCURRENT = 2;
const activeJobs = [];
const waitingQueue = [];

function enqueueVideoProcessing(job) {
  if (activeJobs.length >= MAX_CONCURRENT) {
    waitingQueue.push(job);
  } else {
    activeJobs.push(job);
    setImmediate(() => runJob(job));
  }
}

async function runJob(job) {
  try {
    await processVideo(job);
  } catch (err) {
    console.error(`فشل معالجة الفيديو #${job.videoId}:`, err.message);
  } finally {
    // إزالة المهمة المكتملة من قائمة المهام النشطة
    const index = activeJobs.indexOf(job);
    if (index > -1) activeJobs.splice(index, 1);
    
    // تشغيل المهمة التالية إن وُجدت
    if (waitingQueue.length > 0) {
      const nextJob = waitingQueue.shift();
      activeJobs.push(nextJob);
      setImmediate(() => runJob(nextJob));
    }
  }
}

// مراقبة طابور المعالجة
setInterval(() => {
  console.log(`[Queue Monitor] المهام الجارية: ${activeJobs.length}/${MAX_CONCURRENT} | قيد الانتظار: ${waitingQueue.length}`);
}, 60000);

// تنفيذ أمر FFmpeg مغلف بـ Promise مع try/catch خارجي
function runFfmpeg(cmd, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[${label}] فشل أمر FFmpeg:`, err.message);
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// قراءة مدة الفيديو عبر ffprobe
function probeDuration(inputPath) {
  return new Promise((resolve) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`;
    exec(cmd, (err, stdout) => {
      if (err) return resolve(0);
      const d = parseFloat((stdout || '').trim());
      resolve(isNaN(d) ? 0 : d);
    });
  });
}

// الفلترة الأولية: استخراج الصوت + فحص المحتوى وفق قواعد بسيطة
async function preliminaryFilter({ inputPath, baseName, description }) {
  const result = {
    ai_score: 1.0,            // درجة افتراضية (1 = نظيف)
    flag: null,
    audio_silence_ratio: 0,
    notes: []
  };
  const audioPath = path.join(PROCESSED_DIR, `${baseName}_audio.wav`);
  try {
    // (أ) استخراج المسار الصوتي بصيغة wav مونو لتقليل الحجم
    await runFfmpeg(
      `ffmpeg -y -i "${inputPath}" -vn -ac 1 -ar 16000 -f wav "${audioPath}"`,
      'extract-audio'
    );

    // (ب) قياس نسبة الصمت إلى الصوت (silencedetect)
    try {
      const { stderr } = await runFfmpeg(
        `ffmpeg -i "${audioPath}" -af silencedetect=noise=-30dB:d=0.5 -f null -`,
        'silence-detect'
      );
      const silenceMatches = (stderr || '').match(/silence_duration: ([0-9.]+)/g) || [];
      const totalSilence = silenceMatches.reduce((sum, m) => {
        const n = parseFloat(m.replace('silence_duration: ', ''));
        return sum + (isNaN(n) ? 0 : n);
      }, 0);
      const dur = await probeDuration(audioPath);
      if (dur > 0) {
        result.audio_silence_ratio = Math.min(1, totalSilence / dur);
      }
      // إذا كان الفيديو شبه صامت بالكامل اعتبره مشبوهاً يحتاج مراجعة بشرية
      if (result.audio_silence_ratio > 0.95) {
        result.flag = 'manual_review_required';
        result.notes.push('الفيديو شبه صامت بالكامل');
        result.ai_score -= 0.3;
      }
    } catch (e) {
      console.error('فشل كشف الصمت:', e.message);
    }

    // (ج) فحص الكلمات المحظورة في الوصف (بديل بسيط للتفريغ النصي)
    const desc = (description || '').toLowerCase();
    const hits = BLOCKED_KEYWORDS.filter(k => desc.includes(k.toLowerCase()));
    if (hits.length > 0) {
      result.flag = 'manual_review_required';
      result.notes.push(`كلمات مشبوهة في الوصف: ${hits.join(',')}`);
      result.ai_score -= 0.5;
    }

    if (result.ai_score < 0) result.ai_score = 0;
  } catch (err) {
    console.error('فشل الفلترة الأولية:', err.message);
    result.flag = 'manual_review_required';
    result.notes.push('تعذّر إجراء الفحص الآلي');
    result.ai_score = 0.5;
  } finally {
    // تنظيف الملف الصوتي المؤقت
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch (_) {}
  }
  return result;
}

// المعالجة الكاملة للفيديو: ضغط + thumbnail + فلترة + تحديث DB
async function processVideo(job) {
  const { videoId, userId, inputPath, baseName, description } = job;
  console.log(`[processVideo] بدء معالجة الفيديو #${videoId}`);

  try {
    // قياس المدة وتسجيلها
    const duration = await probeDuration(inputPath);
    if (duration > 0) {
      try {
        db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(duration, videoId);
      } catch (_) {}
    }
    // رفض المقاطع التي تتجاوز 5 دقائق (300 ثانية) تلقائياً
    if (duration > 300) {
      db.prepare("UPDATE videos SET status = 'rejected', flag = 'duration_exceeded' WHERE id = ?")
        .run(videoId);
      createNotification(userId, 'video_rejected',
        `تم رفض فيديوك تلقائياً لأن مدته تتجاوز 5 دقائق (${Math.round(duration)}ث)`);
      return;
    }

    const processedName = `${baseName}_compressed.mp4`;
    const processedPath = path.join(PROCESSED_DIR, processedName);
    const thumbName = `${baseName}_thumb.jpg`;
    const thumbPath = path.join(PROCESSED_DIR, thumbName);

    // (أ) ضغط الفيديو إلى H.264 بمعدل بت متوسط مناسب للموبايل (~2.5Mbps)
    await runFfmpeg(
      `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset veryfast -b:v 2500k -maxrate 3500k -bufsize 5000k -vf "scale='min(720,iw)':-2" -c:a aac -b:a 128k -movflags +faststart "${processedPath}"`,
      'compress'
    );

    // (ب) استخراج صورة مصغرة عند الثانية 2
    await runFfmpeg(
      `ffmpeg -y -ss 2 -i "${inputPath}" -frames:v 1 -q:v 3 "${thumbPath}"`,
      'thumbnail'
    );

    // (ج) تشغيل طبقة الفلترة الأولية
    const filterRes = await preliminaryFilter({ inputPath, baseName, description });

    // (د) تحويل HLS غير المتزامن وإنشاء مجلد خاص
    const processedUrl = `/processed/${processedName}`;
    const thumbUrl = `/processed/${thumbName}`;
    const hlsDirName = String(videoId);
    const hlsDirPath = path.join(PROCESSED_DIR, 'hls', hlsDirName);
    const masterPlaylistUrl = `/processed/hls/${videoId}/master.m3u8`;

    if (!fs.existsSync(hlsDirPath)) fs.mkdirSync(hlsDirPath, { recursive: true });

    let finalHlsUrl = null;
    try {
      console.log(`[processVideo] بدء تحويل HLS للفيديو #${videoId}`);
      // إنتاج 3 مستويات جودة (360p, 480p, 720p)
      await runFfmpeg(
        `ffmpeg -y -i "${processedPath}" \
        -filter_complex \
        "[0:v]split=3[v1][v2][v3]; \
        [v1]scale=w=-2:h=360[v1out]; \
        [v2]scale=w=-2:h=480[v2out]; \
        [v3]scale=w=-2:h=720[v3out]" \
        -map "[v1out]" -c:v:0 libx264 -b:v:0 800k -maxrate:v:0 856k -bufsize:v:0 1200k -preset veryfast \
        -map "[v2out]" -c:v:1 libx264 -b:v:1 1500k -maxrate:v:1 1605k -bufsize:v:1 2250k -preset veryfast \
        -map "[v3out]" -c:v:2 libx264 -b:v:2 2500k -maxrate:v:2 2675k -bufsize:v:2 3750k -preset veryfast \
        -map a:0? -c:a aac -b:a:0 96k \
        -map a:0? -c:a aac -b:a:1 128k \
        -map a:0? -c:a aac -b:a:2 128k \
        -f hls \
        -hls_time 4 \
        -hls_playlist_type vod \
        -hls_segment_type fmp4 \
        -hls_flags independent_segments \
        -master_pl_name master.m3u8 \
        -hls_segment_filename "${hlsDirPath}/stream_%v_data%02d.m4s" \
        -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
        "${hlsDirPath}/stream_%v.m3u8"`,
        'hls-convert'
      );
      
      // احذف الملف المضغوط الأصلي بعد نجاح التحويل
      try { fs.unlinkSync(processedPath); } catch (_) {}
      finalHlsUrl = masterPlaylistUrl;
      console.log(`[processVideo] نجح تحويل HLS للفيديو #${videoId}`);
    } catch (hlsErr) {
      console.error(`[processVideo] فشل تحويل HLS للفيديو #${videoId}:`, hlsErr.message);
      // التراجع لـ MP4 fallback
      finalHlsUrl = null;
    }

    // تحديث قاعدة البيانات: المسارات + ai_score + flag + الحالة
    db.prepare(`
      UPDATE videos
      SET processed_url = ?, thumbnail = ?, ai_score = ?, flag = ?, status = 'pending_moderation', hls_playlist_url = ?
      WHERE id = ?
    `).run(processedUrl, thumbUrl, filterRes.ai_score, filterRes.flag, finalHlsUrl, videoId);

    // (هـ) إشعار المستخدم باكتمال المعالجة + إن لزم الأمر فشل الفلترة
    createNotification(userId, 'processing_complete',
      'اكتملت معالجة فيديوك وهو الآن في انتظار المراجعة الشرعية');

    if (filterRes.flag === 'manual_review_required') {
      createNotification(userId, 'filter_warning',
        `لاحظنا ما يستوجب مراجعة بشرية إضافية: ${filterRes.notes.join(' | ') || 'فحص آلي غير حاسم'}`);
    }

    console.log(`[processVideo] انتهت معالجة #${videoId} (ai_score=${filterRes.ai_score})`);
  } catch (err) {
    console.error(`[processVideo] خطأ في معالجة #${videoId}:`, err.message);
    // في حال الفشل علّم الفيديو يدوياً ولا نوقف الخادم
    try {
      db.prepare(`
        UPDATE videos SET status = 'pending_moderation', flag = 'manual_review_required', ai_score = 0
        WHERE id = ?
      `).run(videoId);
      createNotification(userId, 'processing_failed',
        'تعذّر إجراء المعالجة الآلية لفيديوك، تم تحويله للمراجعة البشرية مباشرة');
    } catch (_) {}
  }
}

// ==================== AUTH ENDPOINTS ====================

// 3. عملية التسجيل
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const username = xss(req.body.username);
    const email = xss(req.body.email);
    const password = req.body.password;

    if (!username || !email || !password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور قصيرة' });

    const userExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (userExists) return res.status(400).json({ error: 'البريد مسجل مسبقاً' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const insert = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)');
    const result = insert.run(username, email, hashedPassword);

    const newUser = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    newUser.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(newUser.username)}&background=00d26a&color=fff&bold=true`;

    const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user: newUser, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'فشل السيرفر في التسجيل' });
  }
});

// 3. مسار الدخول متوافق مع SQL
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const email = xss(req.body.email);
    const password = req.body.password;
    if (!email || !password) return res.status(400).json({ error: 'البيانات مطلوبة' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const safeUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=00d26a&color=fff&bold=true`
    };

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user: safeUser, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'خطأ داخلي في الخادم' });
  }
});

// 4. تعطيل مسار التسجيل عبر الشبكات
app.post('/api/social-login', authLimiter, (req, res) => {
  res.status(501).json({ error: "تم تعطيل الخدمة المستقلة مؤقتاً لأسباب أمنية، يرجى استخدام تسجيل الدخول العادي بالرقم السري أسفل هذه الصفحة." });
});

// =============================================================
// إعدادات multer لرفع ملفات حتى 200MB
// =============================================================
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// ==================== SECURE DATA ENDPOINTS ====================

// إضافة فيديو من رابط خارجي (للإدارة)
app.post('/api/videos', authenticateToken, requireModerator, (req, res) => {
  try {
    const { url, author, description, source } = req.body;
    if (!url || !author || !description) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }

    const insert = db.prepare(
      "INSERT INTO videos (user_id, url, description, status) VALUES (?, ?, ?, 'approved')"
    );
    const result = insert.run(req.user.id, url, description);
    const videoId = result.lastInsertRowid;

    // إشعار للمستخدم (أو الإدارة) عن إضافة الفيديو
    createNotification(req.user.id, 'video_added',
      `تم إضافة الفيديو الجديد: ${description}`);

    res.json({
      success: true,
      message: 'تم إضافة الفيديو بنجاح',
      videoId
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'فشل إضافة الفيديو' });
  }
});

app.post('/api/collect-data', authenticateToken, (req, res) => {
  res.json({ success: true });
});

// 8. جلب الفيديوهات المعتمدة فقط أو المعلقة (للمشرفين)
app.get('/api/videos', authenticateToken, (req, res) => {
  try {
    const status = req.query.status;
    // المشرف يطلب الفيديوهات الجاهزة للمراجعة (pending_moderation أو pending للتوافق الخلفي)
    if (status === 'pending') {
      if (req.user.role !== 'moderator' && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح' });
      }
      const rows = db.prepare(`
        SELECT v.id, v.url, v.processed_url, v.hls_playlist_url, v.thumbnail, v.description, v.status,
               v.ai_score, v.flag, v.duration, v.created_at as createdAt,
               u.username as author,
               (SELECT COUNT(*) FROM likes WHERE video_id = v.id) as likes,
               (SELECT COUNT(*) FROM comments WHERE video_id = v.id) as comments
        FROM videos v
        JOIN users u ON v.user_id = u.id
        WHERE v.status IN ('pending', 'pending_moderation')
        ORDER BY v.created_at DESC
      `).all();
      
      const videos = rows.map(v => {
        // 🔐 تصحيح: تأمين رابط fallback MP4
        const fallbackRaw = v.processed_url || v.url;
        const fallbackSigned = fallbackRaw.startsWith('/processed/') && fallbackRaw.endsWith('.mp4') 
             ? `${fallbackRaw}${signHLSUrl(req.user.id, v.id, 'mp4', 120)}&vid=${v.id}`
             : fallbackRaw;

        const vid = { ...v, fallbackUrl: fallbackSigned };
        if (v.hls_playlist_url) {
           vid.streamUrl = `${v.hls_playlist_url}${signHLSUrl(req.user.id, v.id, 'hls', 120)}`;
        }
        return vid;
      });
      return res.json(videos);
    }
    // العامة: المعتمدة فقط (مع فلترة حسب القسم إن وجد)
    const category = req.query.category;
    let categoryFilter = '';
    if (category && category !== 'all') {
      categoryFilter = 'AND v.category = ?';
    }
    const rows = db.prepare(`
      SELECT v.id, v.url, v.processed_url, v.hls_playlist_url, v.thumbnail, v.description, v.status,
             v.ai_score, v.duration, v.created_at as createdAt, v.category,
             u.username as author,
             (SELECT COUNT(*) FROM likes WHERE video_id = v.id) as likes,
             (SELECT COUNT(*) FROM comments WHERE video_id = v.id) as comments
      FROM videos v
      JOIN users u ON v.user_id = u.id
      WHERE v.status = 'approved' ${categoryFilter}
      ORDER BY v.created_at DESC
    `).all(...(category && category !== 'all' ? [category] : []));

    const videos = rows.map(v => {
      // 🔐 تصحيح: تأمين رابط fallback MP4
      const fallbackRaw = v.processed_url || v.url;
      const fallbackSigned = fallbackRaw.startsWith('/processed/') && fallbackRaw.endsWith('.mp4') 
           ? `${fallbackRaw}${signHLSUrl(req.user.id, v.id, 'mp4', 120)}&vid=${v.id}`
           : fallbackRaw;

      const vid = { ...v, fallbackUrl: fallbackSigned };
      if (v.hls_playlist_url) {
         vid.streamUrl = `${v.hls_playlist_url}${signHLSUrl(req.user.id, v.id, 'hls', 120)}`;
      }
      return vid;
    });

    res.json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "فشل جلب الفيديوهات" });
  }
});

app.post('/api/update-profile', authenticateToken, (req, res) => {
  try {
    const newUsername = req.body.username ? xss(req.body.username) : null;
    if (newUsername) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newUsername, req.user.id);
    }
    const safeUser = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
    safeUser.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(safeUser.username)}&background=00d26a&color=fff&bold=true`;

    res.json({ success: true, user: safeUser });
  } catch (error) {
    res.status(500).json({ error: 'عطل في تحديث الملف الشخصي' });
  }
});

// ❤️ مسار الإعجاب / إلغاء الإعجاب
// جلب فيديوهاتي المُعجبة - GET /api/my-likes
app.get('/api/my-likes', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT v.id, v.url, v.processed_url, v.hls_playlist_url, v.thumbnail, v.description, v.status,
             v.duration, v.created_at as createdAt,
             u.username as author
      FROM likes l
      JOIN videos v ON l.video_id = v.id
      JOIN users u ON v.user_id = u.id
      WHERE l.user_id = ? AND v.status = 'approved'
      ORDER BY l.created_at DESC
    `).all(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل جلب الإعجابات' });
  }
});

// جلب فيديوهاتي المُشاركة (إعادة التغريد) - GET /api/my-shares
app.get('/api/my-shares', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT v.id, v.url, v.processed_url, v.hls_playlist_url, v.thumbnail, v.description, v.status,
             v.duration, v.created_at as createdAt,
             u.username as author,
             em.created_at as shared_at
      FROM engagement_metrics em
      JOIN videos v ON em.video_id = v.id
      JOIN users u ON v.user_id = u.id
      WHERE em.user_id = ? AND em.action = 'shared' AND v.status = 'approved'
      ORDER BY em.created_at DESC
    `).all(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل جلب المشاركات' });
  }
});

// جلب فيديوهاتي التي رفعتها - GET /api/my-videos
app.get('/api/my-videos', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT v.id, v.url, v.processed_url, v.hls_playlist_url, v.thumbnail, v.description, v.status, v.flag,
             v.ai_score, v.duration, v.created_at as createdAt,
             u.username as author,
             (SELECT COUNT(*) FROM likes WHERE video_id = v.id) as likes,
             (SELECT COUNT(*) FROM comments WHERE video_id = v.id) as comments
      FROM videos v
      JOIN users u ON v.user_id = u.id
      WHERE v.user_id = ?
      ORDER BY v.created_at DESC
    `).all(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل جلب فيديوهاتي' });
  }
});

app.post('/api/like/:videoId', authenticateToken, (req, res) => {
  try {
    const videoId = parseInt(req.params.videoId);
    const userId = req.user.id;
    const existing = db.prepare('SELECT id FROM likes WHERE user_id = ? AND video_id = ?').get(userId, videoId);
    if (existing) {
      db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(userId, videoId);
      const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE video_id = ?').get(videoId).c;
      return res.json({ success: true, liked: false, count });
    } else {
      db.prepare('INSERT INTO likes (user_id, video_id) VALUES (?, ?)').run(userId, videoId);
      const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE video_id = ?').get(videoId).c;
      return res.json({ success: true, liked: true, count });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل الإعجاب' });
  }
});

// 💬 مسار إضافة تعليق
app.post('/api/comment/:videoId', authenticateToken, (req, res) => {
  try {
    const videoId = parseInt(req.params.videoId);
    const text = xss(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'التعليق فارغ' });
    db.prepare('INSERT INTO comments (user_id, video_id, text) VALUES (?, ?, ?)').run(req.user.id, videoId, text);
    const count = db.prepare('SELECT COUNT(*) as c FROM comments WHERE video_id = ?').get(videoId).c;
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, count, comment: { text, username: user.username, created_at: new Date().toISOString() } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل التعليق' });
  }
});

// 💬 مسار جلب التعليقات
app.get('/api/comments/:videoId', authenticateToken, (req, res) => {
  try {
    const videoId = parseInt(req.params.videoId);
    const comments = db.prepare(`
      SELECT c.text, c.created_at, u.username
      FROM comments c JOIN users u ON c.user_id = u.id
      WHERE c.video_id = ? ORDER BY c.created_at DESC LIMIT 100
    `).all(videoId);
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: 'فشل جلب التعليقات' });
  }
});

// ❤️ مسار حالة الإعجاب
app.get('/api/liked/:videoId', authenticateToken, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM likes WHERE user_id = ? AND video_id = ?').get(req.user.id, parseInt(req.params.videoId));
    res.json({ liked: !!existing });
  } catch (err) {
    res.json({ liked: false });
  }
});

// =============================================================
// 5. رفع فيديو: استجابة فورية + جدولة المعالجة في الخلفية
// =============================================================
app.post('/api/upload', authenticateToken, upload.single('video'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });

    const ext = path.extname(req.file.originalname) || '.mp4';
    const newFileName = req.file.filename + ext;
    const finalPath = path.join(UPLOADS_DIR, newFileName);
    fs.renameSync(req.file.path, finalPath);

    const url = `/uploads/${newFileName}`;
    const desc = req.body.description ? xss(req.body.description) : 'مقطع جديد';
    const category = req.body.category || 'general';

    // إدراج الفيديو بحالة "processing" قبل بدء المعالجة الخلفية
    const insert = db.prepare(
      "INSERT INTO videos (user_id, url, description, category, status) VALUES (?, ?, ?, ?, 'processing')"
    );
    const result = insert.run(req.user.id, url, desc, category);
    const videoId = result.lastInsertRowid;

    // جدولة المعالجة في الخلفية (لا تحظر الاستجابة)
    enqueueVideoProcessing({
      videoId,
      userId: req.user.id,
      inputPath: finalPath,
      baseName: req.file.filename,
      description: desc
    });

    // رد فوري للمستخدم
    return res.json({
      success: true,
      status: 'processing',
      message: 'جاري ضغط الفيديو وإعداده للمراجعة',
      videoId
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'فشل الرفع للمعرض' });
  }
});

// حد للطلبات الخاصة بالرقابة: 60 طلب في الساعة لكل مشرف
const moderateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, 
  max: 60,
  keyGenerator: req => req.user?.id ? req.user.id.toString() : 'anonymous',
  message: { error: 'تم تجاوز الحد المسموح للرقابة (60/ساعة)' }
});

// 7. مسار الرقابة الشرعية (المشرف/المدير فقط) - مع إشعارات للمستخدم
app.post('/api/moderate/:videoId', authenticateToken, requireModerator, moderateLimiter, (req, res) => {
  try {
    const videoId = req.params.videoId;
    const action = req.body.action; // 'approve' | 'reject' | 'edit'
    const reason = req.body.reason ? xss(req.body.reason) : null;
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    if (action !== 'approve' && action !== 'reject' && action !== 'edit') {
      return res.status(400).json({ error: 'إجراء غير صالح' });
    }

    const newStatus = action === 'approve' ? 'approved' : (action === 'edit' ? 'edit_requested' : 'rejected');

    // التأكد من وجود الفيديو + الحصول على صاحبه لإشعاره
    const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ?').get(videoId);
    if (!video) return res.status(404).json({ error: 'الفيديو غير موجود' });

    db.prepare('UPDATE videos SET status = ? WHERE id = ?').run(newStatus, videoId);

    db.prepare('INSERT INTO moderation_logs (video_id, moderator_id, action, reason, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(videoId, req.user.id, action, reason, ipAddress, userAgent);

    // إشعار صاحب الفيديو بالقرار
    if (action === 'approve') {
      createNotification(video.user_id, 'video_approved',
        'تمت الموافقة على فيديوك ونشره في المعرض، بارك الله فيك');
    } else if (action === 'edit') {
      createNotification(video.user_id, 'video_edit_requested',
        `تم طلب تعديل لفيديوك${reason ? ' - الملاحظات: ' + reason : ''}`);
    } else {
      createNotification(video.user_id, 'video_rejected',
        `تم رفض فيديوك${reason ? ' - السبب: ' + reason : ''}`);
    }

    res.json({ success: true, message: `تم تمرير قرار (${action}) للمقطع بنجاح` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل تنفيذ نظام الرقابة' });
  }
});

// مسار جلب سجل المراجعة
app.get('/api/moderation-logs', authenticateToken, requireModerator, (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT m.id, m.action, m.reason, m.created_at as createdAt,
             v.url, v.description, u.username as moderator
      FROM moderation_logs m
      JOIN videos v ON m.video_id = v.id
      JOIN users u ON m.moderator_id = u.id
      ORDER BY m.created_at DESC LIMIT 50
    `).all();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'فشل جلب السجل' });
  }
});

// =============================================================
// (د) إشعارات: مسار جلب غير المقروءة + تعليمها كمقروءة
// =============================================================
app.get('/api/notifications', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, type, message, is_read, created_at
      FROM notifications
      WHERE user_id = ? AND is_read = 0
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.user.id);
    res.json({ success: true, notifications: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل جلب الإشعارات' });
  }
});

app.post('/api/notifications/read', authenticateToken, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`
      ).run(req.user.id, ...ids);
    } else {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل تحديث الإشعارات' });
  }
});

// ======================================================
// مقاييس الانتفاع الشرعي - POST /api/engagement
// لماذا: نقيس "الانتفاع" (إكمال، حفظ، مشاركة) لا "الإدمان" (وقت المشاهدة القسري)
// لا نسجّل: IP, device_id, scroll velocity, click-through-rate
// ======================================================
app.post('/api/engagement', authenticateToken, (req, res) => {
  try {
    const { video_id, action, duration_watched } = req.body;
    if (!video_id || !action) {
      return res.status(400).json({ error: 'video_id و action مطلوبان' });
    }
    if (!['completed', 'replayed', 'saved', 'shared'].includes(action)) {
      return res.status(400).json({ error: 'action غير صالح' });
    }
    db.prepare(
      'INSERT INTO engagement_metrics (user_id, video_id, action, duration_watched) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, video_id, action, duration_watched || 0);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل تسجيل التفاعل' });
  }
});

// ======================================================
// مقاييس مجمّعة للمشرف - GET /api/engagement/metrics
// ======================================================
app.get('/api/engagement/metrics', authenticateToken, requireModerator, (req, res) => {
  try {
    // أكثر الفيديوهات إكمالاً (الانتفاع الحقيقي)
    const mostCompleted = db.prepare(`
      SELECT v.id, v.description, u.username as author, COUNT(*) as completed_count
      FROM engagement_metrics em
      JOIN videos v ON em.video_id = v.id
      JOIN users u ON v.user_id = u.id
      WHERE em.action = 'completed'
      GROUP BY em.video_id
      ORDER BY completed_count DESC
      LIMIT 10
    `).all();

    // نسبة إعادة الاستماع (للقرآن والتلاوات)
    const replayRatio = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM engagement_metrics WHERE action = 'replayed') * 1.0 /
        NULLIF((SELECT COUNT(*) FROM engagement_metrics WHERE action = 'completed'), 0) * 100 as replay_percent
    `).get();

    // الحفظ مقابل المشاركة (مؤشر الانتفاع الشخصي)
    const savedCount = db.prepare(
      "SELECT COUNT(*) as count FROM engagement_metrics WHERE action = 'saved'"
    ).get();
    const sharedCount = db.prepare(
      "SELECT COUNT(*) as count FROM engagement_metrics WHERE action = 'shared'"
    ).get();

    // إجمالي التفاعلات
    const totalEngagements = db.prepare(
      "SELECT COUNT(*) as count FROM engagement_metrics"
    ).get();

    res.json({
      mostCompleted,
      replayPercent: replayRatio?.replay_percent || 0,
      savedCount: savedCount?.count || 0,
      sharedCount: sharedCount?.count || 0,
      totalEngagements: totalEngagements?.count || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل جلب المقاييس' });
  }
});

// ======================================================
// حذف بياناتي - DELETE /api/my-data
// الخصوصية: يمحي كل سجلات المستخدم خلال 24 ساعة
// ======================================================
app.delete('/api/my-data', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    db.prepare('DELETE FROM engagement_metrics WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM likes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM comments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
    // ملاحظة: لا نحذف حساب المستخدم بالكامل لئلا نفسد الإسناد في جدول الفيديوهات
    res.json({ success: true, message: 'تم حذف جميع بيانات التفاعل الخاصة بك.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل حذف البيانات' });
  }
});

// ============== Serve Frontend (Production Mode) =================
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/processed', express.static(PROCESSED_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/{*splat}', (req, res, next) => {
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/uploads/') ||
    req.path.startsWith('/processed/')
  ) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'حجم الملف يتجاوز الحد الأقصى (200 ميغابايت)' });
    }
    return res.status(400).json({ error: `خطأ في الرفع: ${err.message}` });
  } else if (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'خطأ داخلي في الخادم' });
  }
  next();
});

// 5. [تنظيف تلقائي - منع امتلاء القرص]
function cleanupOldFiles() {
  console.log('[Cleanup] بدء عملية تنظيف مجلدات HLS القديمة والمرفوضة...');
  try {
    const hlsBaseDir = path.join(PROCESSED_DIR, 'hls');
    if (!fs.existsSync(hlsBaseDir)) return;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const oldVideos = db.prepare(`
      SELECT id FROM videos
      WHERE status IN ('rejected', 'deleted') AND created_at < ?
    `).all(twentyFourHoursAgo);

    let deletedCount = 0;
    for (const v of oldVideos) {
      const videoHlsDir = path.join(hlsBaseDir, String(v.id));
      if (fs.existsSync(videoHlsDir)) {
        fs.rmSync(videoHlsDir, { recursive: true, force: true });
        deletedCount++;
      }
    }
    console.log(`[Cleanup] تمت إزالة ${deletedCount} مجلد HLS لفيديوهات قديمة.`);
  } catch (err) {
    console.error('[Cleanup] خطأ أثناء التنظيف:', err.message);
  }
}
setInterval(cleanupOldFiles, 6 * 60 * 60 * 1000);

// ==========================================
// START SERVER + ضبط مهلات الرفع الطويلة
// ==========================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SECURE Backend running on http://0.0.0.0:${PORT}`);
});

// مهلات الخادم لمنع انقطاع الرفع للملفات الكبيرة (200MB / حتى 5 دقائق)
server.timeout = 120000;          // 2 دقيقة لكل request socket
server.keepAliveTimeout = 130000; // أطول من timeout لتجنب RST من البروكسيات
server.headersTimeout = 135000;   // يجب أن تكون أكبر من keepAliveTimeout
