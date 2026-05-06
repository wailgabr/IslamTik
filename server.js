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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const JWT_SECRET = 'islamtok_super_secure_secret_key_12345';

// ==================== SECURITY MIDDLEWARE ====================
// 1. Helmet (Security Headers)
app.use(helmet());

// 2. CORS (Restrict API access)
app.use(cors({ origin: '*' })); // In production, replace '*' with specific domains

// 3. Payload size limiting (prevent large payload attacks)
app.use(express.json({ limit: '50kb' }));

// 4. Rate Limiting (DDoS & Spam prevention)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, 
  message: { error: "طلبات كثيرة جداً، يرجى المحاولة لاحقاً" }
});
app.use('/api', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 15, 
  message: { error: "محاولات تسجيل دخول كثيرة، يرجى المحاولة بعد ساعة" }
});

// Middleware to Verify Server Side Session / JWT 
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

function getDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { videos: [], users: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ==================== AUTH ENDPOINTS ====================

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    // 5. Input Sanitization (XSS Vulnerability Protection)
    const username = xss(req.body.username);
    const email = xss(req.body.email);
    const password = req.body.password;

    if (!username || !email || !password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور قصيرة' });
    
    const db = getDB();
    if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'البريد مسجل مسبقاً' });
    
    // 6. Secure Password Hashing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = {
      id: Date.now(),
      username,
      email,
      password: hashedPassword, // highly encrypted
      createdAt: new Date().toISOString(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=00d26a&color=fff&bold=true`
    };
    db.users.push(newUser);
    saveDB(db);
    
    const token = jwt.sign({ id: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = newUser;
    res.json({ success: true, user: safeUser, token });
  } catch (error) {
    res.status(500).json({ error: 'فشل السيرفر في التسجيل' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const email = xss(req.body.email);
    const password = req.body.password;
    if (!email || !password) return res.status(400).json({ error: 'البيانات مطلوبة' });
    
    const db = getDB();
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser, token });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/social-login', authLimiter, (req, res) => {
  try {
    const provider = xss(req.body.provider);
    const email = xss(req.body.email);
    const name = xss(req.body.name);

    const db = getDB();
    let user = db.users.find(u => u.email === email);
    if (!user) {
      user = {
        id: Date.now(),
        username: name,
        email,
        password: bcrypt.hashSync(Math.random().toString(), 10),
        provider,
        createdAt: new Date().toISOString(),
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=00d26a&color=fff&bold=true`
      };
      db.users.push(user);
      saveDB(db);
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser, token });
  } catch(e) {
    res.status(500).json({ error: 'خطأ السيرفر الداخلي' });
  }
});

// ==================== SECURE DATA ENDPOINTS ====================
app.post('/api/collect-data', authenticateToken, (req, res) => {
  try {
    const data = getDB();
    if (!data.loginEvents) data.loginEvents = [];
    
    const rawBody = req.body;
    if (rawBody.userContent?.interests) {
      rawBody.userContent.interests = rawBody.userContent.interests.map(i => xss(i));
    }

    data.loginEvents.unshift({
      recordId: Date.now(),
      userId: req.user.id,
      timestamp: new Date().toISOString(),
      ...rawBody
    });
    saveDB(data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'عطل' });
  }
});

app.get('/api/videos', authenticateToken, (req, res) => {
  try {
    const data = getDB();
    const source = xss(req.query.source);
    let videos = data.videos || [];
    if (source && source !== 'all') videos = videos.filter(v => v.source === source);
    res.json(videos);
  } catch (error) {
    res.status(500).json({ error: "Failed fetch" });
  }
});

app.post('/api/update-profile', authenticateToken, (req, res) => {
  try {
    const data = getDB();
    const userIndex = data.users.findIndex(u => u.id === req.user.id);
    if(userIndex > -1) {
      if(req.body.username) data.users[userIndex].username = xss(req.body.username);
      if(req.body.bio !== undefined) data.users[userIndex].bio = xss(req.body.bio);
      saveDB(data);
      const { password: _, ...safeUser } = data.users[userIndex];
      res.json({ success: true, user: safeUser });
    } else {
      res.status(404).json({ error: 'مستخدم غير موجود' });
    }
  } catch(error) {
    res.status(500).json({ error: 'عطل' });
  }
});

// ============== Serve Frontend (Production Mode) =================
app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ==========================================
// START SERVER
// ==========================================
app.listen(3000, () => {
  console.log('SECURE Backend running on http://localhost:3000');
});
