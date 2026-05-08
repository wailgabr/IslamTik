import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { jwt, verify } from 'hono/jwt'
import { etag } from 'hono/etag'

const app = new Hono()

app.use('*', etag())
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','DELETE'], allowHeaders: ['Content-Type','Authorization'] }))

// ==================== المساعدة ====================
async function hashPassword(password) {
  const enc = new TextEncoder().encode(password)
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
}

function makeToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = btoa(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400*7 }))
  const sig = btoa(String.fromCharCode(...new Uint8Array(sign(header+'.'+body, secret))))
  return header+'.'+body+'.'+sig
}

async function sign(msg, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
}

async function verifyToken(token, secret) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const exp = JSON.parse(atob(parts[1])).exp
    if (Date.now()/1000 > exp) return null
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify('HMAC', key, new Uint8Array([...atob(parts[2])].map(c=>c.charCodeAt(0))), new TextEncoder().encode(parts[0]+'.'+parts[1]))
    if (!valid) return null
    return JSON.parse(atob(parts[1]))
  } catch { return null }
}

function requireAuth(secret) {
  return async (c, next) => {
    const auth = c.req.header('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) return c.json({ success: false, error: 'تسجيل الدخول مطلوب' }, 401)
    const user = await verifyToken(auth.slice(7), secret)
    if (!user) return c.json({ success: false, error: 'انتهت الجلسة، سجل دخول مرة أخرى' }, 401)
    c.set('user', user)
    await next()
  }
}

function requireMod(c, next) {
  const user = c.get('user')
  if (!user || (user.role !== 'moderator' && user.role !== 'admin')) return c.json({ success: false, error: 'غير مصرح' }, 403)
  return next()
}

function sanitize(str) {
  if (!str) return ''
  return str.replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;' })[c] || c)
}

function escapeLike(s) {
  return (s||'').replace(/[%_\\]/g, '\\$&')
}

function uuid() {
  return crypto.randomUUID()
}

// ==================== التسجيل والدخول ====================
app.post('/api/register', async c => {
  try {
    const { username, email, password } = await c.req.json()
    if (!username || !email || !password) return c.json({ success: false, error: 'جميع الحقول مطلوبة' })
    if (password.length < 6) return c.json({ success: false, error: 'كلمة المرور 6 أحرف على الأقل' })
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existing) return c.json({ success: false, error: 'البريد مستخدم من قبل' })
    const hash = await hashPassword(password)
    const { meta } = await c.env.DB.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').bind(username, email, hash).run()
    const token = makeToken({ id: meta.last_row_id, username, email, role: 'user' }, c.env.JWT_SECRET)
    return c.json({ success: true, token, user: { id: meta.last_row_id, username, email, role: 'user', bio: '♥ صل على النبي ♥', avatar: '' } })
  } catch (e) { return c.json({ success: false, error: 'خطأ في التسجيل' }) }
})

app.post('/api/login', async c => {
  try {
    const { email, password } = await c.req.json()
    if (!email || !password) return c.json({ success: false, error: 'البريد وكلمة المرور مطلوبان' })
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
    if (!user) return c.json({ success: false, error: 'بريد إلكتروني غير صحيح' })
    const hash = await hashPassword(password)
    if (user.password !== hash) return c.json({ success: false, error: 'كلمة مرور غير صحيحة' })
    const token = makeToken({ id: user.id, username: user.username, email: user.email, role: user.role }, c.env.JWT_SECRET)
    return c.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, role: user.role, bio: user.bio, avatar: '' } })
  } catch (e) { return c.json({ success: false, error: 'خطأ في الدخول' }) }
})

// ==================== الفيديوهات ====================
app.get('/api/videos', async c => {
  const status = c.req.query('status')
  const category = c.req.query('category')
  let sql = 'SELECT v.*, u.username as author FROM videos v JOIN users u ON v.user_id = u.id WHERE 1=1'
  const params = []
  if (status === 'pending') { sql += ' AND v.status = ?'; params.push('pending_moderation') }
  else if (status) { sql += ' AND v.status = ?'; params.push(status) }
  else { sql += " AND v.status = 'approved'" }
  if (category && category !== 'all') { sql += ' AND v.category = ?'; params.push(category) }
  sql += ' ORDER BY v.created_at DESC'
  const { results } = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json(results.map(v => ({
    id: v.id, url: v.url, description: v.description, category: v.category, status: v.status,
    author: v.author, likes: v.likes || 0, comments: v.comments || 0, flag: v.flag, reason: v.reason,
    duration: v.duration, createdAt: v.created_at, fallbackUrl: v.url, streamUrl: v.url,
    processed_url: v.url
  })))
})

app.post('/api/videos', requireAuth(''), async c => {
  const user = c.get('user')
  if (user.role !== 'moderator' && user.role !== 'admin') return c.json({ success: false, error: 'غير مصرح' }, 403)
  const { url, description, category } = await c.req.json()
  const { meta } = await c.env.DB.prepare('INSERT INTO videos (user_id, url, description, category) VALUES (?, ?, ?, ?)').bind(user.id, url, description||'', category||'general').run()
  return c.json({ success: true, videoId: meta.last_row_id })
})

// ==================== الرفع ====================
app.post('/api/upload', requireAuth(''), async c => {
  const user = c.get('user')
  const formData = await c.req.formData()
  const file = formData.get('video')
  const description = formData.get('description') || 'مقطع جديد'
  const category = formData.get('category') || 'general'
  if (!file) return c.json({ success: false, error: 'اختر ملف فيديو' })
  if (file.size > 200*1024*1024) return c.json({ success: false, error: 'الملف كبير جداً (حد أقصى 200MB)' })

  const ext = file.name.split('.').pop() || 'mp4'
  const key = `videos/${uuid()}.${ext}`
  await c.env.VIDEOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'video/mp4' } })

  const url = `/api/video/${key}`
  const { meta } = await c.env.DB.prepare('INSERT INTO videos (user_id, url, description, category, status) VALUES (?, ?, ?, ?, ?)').bind(user.id, url, description, category, 'pending_moderation').run()
  await c.env.DB.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)').bind(user.id, '📹 تم رفع فيديو جديد وهو قيد المراجعة', 'info').run()
  return c.json({ success: true, videoId: meta.last_row_id })
})

// ==================== خدمة الفيديو ====================
app.get('/api/video/*', async c => {
  const key = c.req.path.replace('/api/video/', '')
  const obj = await c.env.VIDEOS.get(key)
  if (!obj) return c.json({ error: 'غير موجود' }, 404)
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'public, max-age=31536000')
  const range = c.req.header('Range')
  if (range) {
    const [start, end] = range.replace('bytes=', '').split('-').map(Number)
    const body = await obj.slice(start || 0, end || obj.size)
    headers.set('Content-Range', `bytes ${start||0}-${end||obj.size-1}/${obj.size}`)
    return new Response(body, { status: 206, headers })
  }
  return new Response(obj.body, { headers })
})

// ==================== الإعجابات ====================
app.post('/api/like/:videoId', requireAuth(''), async c => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const existing = await c.env.DB.prepare('SELECT id FROM likes WHERE user_id=? AND video_id=?').bind(user.id, videoId).first()
  if (existing) {
    await c.env.DB.prepare('DELETE FROM likes WHERE id=?').bind(existing.id).run()
    await c.env.DB.prepare('UPDATE videos SET likes = MAX(0, likes - 1) WHERE id=?').bind(videoId).run()
    const v = await c.env.DB.prepare('SELECT likes FROM videos WHERE id=?').bind(videoId).first()
    return c.json({ success: true, liked: false, count: v?.likes || 0 })
  } else {
    await c.env.DB.prepare('INSERT INTO likes (user_id, video_id) VALUES (?, ?)').bind(user.id, videoId).run()
    await c.env.DB.prepare('UPDATE videos SET likes = likes + 1 WHERE id=?').bind(videoId).run()
    const v = await c.env.DB.prepare('SELECT likes FROM videos WHERE id=?').bind(videoId).first()
    return c.json({ success: true, liked: true, count: v?.likes || 0 })
  }
})

app.get('/api/liked/:videoId', requireAuth(''), async c => {
  const user = c.get('user')
  const existing = await c.env.DB.prepare('SELECT id FROM likes WHERE user_id=? AND video_id=?').bind(user.id, c.req.param('videoId')).first()
  return c.json({ liked: !!existing })
})

app.get('/api/my-likes', requireAuth(''), async c => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    'SELECT v.*, u.username as author FROM likes l JOIN videos v ON v.id=l.video_id JOIN users u ON v.user_id=u.id WHERE l.user_id=? AND v.status="approved" ORDER BY l.created_at DESC'
  ).bind(user.id).all()
  return c.json(results.map(v => ({ ...v, url: v.url, fallbackUrl: v.url, processed_url: v.url })))
})

// ==================== المفضلات ====================
app.get('/api/my-videos', requireAuth(''), async c => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare('SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all()
  return c.json(results.map(v => ({ ...v, url: v.url, fallbackUrl: v.url, processed_url: v.url, createdAt: v.created_at })))
})

app.get('/api/my-shares', requireAuth(''), async c => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    'SELECT v.*, u.username as author FROM engagement_metrics e JOIN videos v ON v.id=e.video_id JOIN users u ON v.user_id=u.id WHERE e.user_id=? AND e.action="shared" ORDER BY e.created_at DESC'
  ).bind(user.id).all()
  return c.json(results.map(v => ({ ...v, url: v.url, fallbackUrl: v.url, processed_url: v.url })))
})

// ==================== التفاعل ====================
app.post('/api/engagement', requireAuth(''), async c => {
  const user = c.get('user')
  const { videoId, action } = await c.req.json()
  if (!['completed','replayed','saved','shared'].includes(action)) return c.json({ success: false, error: 'إجراء غير صحيح' })
  await c.env.DB.prepare('INSERT INTO engagement_metrics (user_id, video_id, action) VALUES (?, ?, ?)').bind(user.id, videoId, action).run()
  return c.json({ success: true })
})

app.get('/api/engagement/metrics', requireAuth(''), async c => {
  const user = c.get('user')
  if (user.role !== 'moderator' && user.role !== 'admin') return c.json({ success: false, error: 'غير مصرح' }, 403)
  const total = (await c.env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics').first()).c
  const completed = (await c.env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="completed"').first()).c
  const replayed = (await c.env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="replayed"').first()).c
  const saved = (await c.env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="saved"').first()).c
  const shared = (await c.env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="shared"').first()).c
  const { results: mostCompleted } = await c.env.DB.prepare(
    'SELECT v.id, v.description, v.url, COUNT(*) as cnt FROM engagement_metrics e JOIN videos v ON v.id=e.video_id WHERE e.action="completed" GROUP BY e.video_id ORDER BY cnt DESC LIMIT 10'
  ).all()
  return c.json({ totalEngagements: total, totalCompletions: completed, totalReplays: replayed, savedCount: saved, sharedCount: shared, replayPercent: completed > 0 ? Math.round(replayed/completed*100) : 0, mostCompleted })
})

// ==================== التعليقات ====================
app.post('/api/comment/:videoId', requireAuth(''), async c => {
  const user = c.get('user')
  const { content } = await c.req.json()
  if (!content || !content.trim()) return c.json({ success: false, error: 'التعليق فارغ' })
  const sanitized = sanitize(content.trim())
  await c.env.DB.prepare('INSERT INTO comments (user_id, video_id, content) VALUES (?, ?, ?)').bind(user.id, c.req.param('videoId'), sanitized).run()
  await c.env.DB.prepare('UPDATE videos SET comments = comments + 1 WHERE id=?').bind(c.req.param('videoId')).run()
  return c.json({ success: true })
})

app.get('/api/comments/:videoId', requireAuth(''), async c => {
  const { results } = await c.env.DB.prepare(
    'SELECT c.*, u.username FROM comments c JOIN users u ON c.user_id=u.id WHERE c.video_id=? ORDER BY c.created_at DESC LIMIT 100'
  ).bind(c.req.param('videoId')).all()
  return c.json(results)
})

// ==================== الملف الشخصي ====================
app.post('/api/update-profile', requireAuth(''), async c => {
  const user = c.get('user')
  const { username, bio } = await c.req.json()
  if (username) await c.env.DB.prepare('UPDATE users SET username=? WHERE id=?').bind(sanitize(username), user.id).run()
  if (bio !== undefined) await c.env.DB.prepare('UPDATE users SET bio=? WHERE id=?').bind(sanitize(bio), user.id).run()
  return c.json({ success: true })
})

// ==================== حذف البيانات ====================
app.delete('/api/my-data', requireAuth(''), async c => {
  const user = c.get('user')
  await c.env.DB.prepare('DELETE FROM likes WHERE user_id=?').bind(user.id).run()
  await c.env.DB.prepare('DELETE FROM comments WHERE user_id=?').bind(user.id).run()
  await c.env.DB.prepare('DELETE FROM engagement_metrics WHERE user_id=?').bind(user.id).run()
  await c.env.DB.prepare('DELETE FROM notifications WHERE user_id=?').bind(user.id).run()
  return c.json({ success: true, message: 'تم حذف جميع بيانات التفاعل' })
})

// ==================== الإشعارات ====================
app.get('/api/notifications', requireAuth(''), async c => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(user.id).all()
  return c.json(results)
})

app.post('/api/notifications/read', requireAuth(''), async c => {
  const user = c.get('user')
  await c.env.DB.prepare('UPDATE notifications SET read=1 WHERE user_id=?').bind(user.id).run()
  return c.json({ success: true })
})

// ==================== الرقابة ====================
app.post('/api/moderate/:videoId', requireAuth(''), async c => {
  const user = c.get('user')
  if (user.role !== 'moderator' && user.role !== 'admin') return c.json({ success: false, error: 'غير مصرح' }, 403)
  const { action, reason } = await c.req.json()
  const videoId = c.req.param('videoId')
  if (action === 'approve') {
    await c.env.DB.prepare("UPDATE videos SET status='approved', moderated_by=? WHERE id=?").bind(user.id, videoId).run()
  } else if (action === 'reject') {
    await c.env.DB.prepare("UPDATE videos SET status='rejected', reason=?, moderated_by=? WHERE id=?").bind(reason||'مخالف للسياسة', user.id, videoId).run()
  } else {
    await c.env.DB.prepare("UPDATE videos SET status='pending_moderation', reason=?, moderated_by=? WHERE id=?").bind(reason||'', user.id, videoId).run()
  }
  return c.json({ success: true })
})

app.get('/api/moderation-logs', requireAuth(''), async c => {
  const user = c.get('user')
  if (user.role !== 'moderator' && user.role !== 'admin') return c.json({ success: false, error: 'غير مصرح' }, 403)
  const { results } = await c.env.DB.prepare('SELECT * FROM videos WHERE status IN ("approved","rejected") ORDER BY updated_at DESC LIMIT 50').all()
  return c.json(results)
})

app.get('/api/collect-data', requireAuth(''), async c => c.json({ success: true }))

// ==================== Serve the JWT_SECRET middleware properly ====================
// We need to re-initialize the auth middleware with the actual secret
// This is done by binding JWT_SECRET to the requireAuth function

// Override the auth routes to use the actual JWT_SECRET from env
const originalRegister = app.routes.find(r => r.method === 'POST' && r.path === '/api/register')
const originalLogin = app.routes.find(r => r.method === 'POST' && r.path === '/api/login')

export default {
  async fetch(request, env, ctx) {
    // Re-create the app with actual JWT_SECRET
    const app = new Hono()
    app.use('*', etag())
    app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','DELETE'], allowHeaders: ['Content-Type','Authorization'] }))

    const secret = env.JWT_SECRET || 'default_secret_change_me'

    function makeToken(payload) {
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      const body = btoa(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400*7 }))
      const sigPromise = (async () => {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(header+'.'+body))
        return btoa(String.fromCharCode(...new Uint8Array(sig)))
      })()
      return sigPromise.then(sig => header+'.'+body+'.'+sig)
    }

    async function verify(token) {
      try {
        const parts = token.split('.')
        if (parts.length !== 3) return null
        const payload = JSON.parse(atob(parts[1]))
        if (Date.now()/1000 > payload.exp) return null
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
        const valid = await crypto.subtle.verify('HMAC', key, new Uint8Array([...atob(parts[2])].map(c=>c.charCodeAt(0))), new TextEncoder().encode(parts[0]+'.'+parts[1]))
        return valid ? payload : null
      } catch { return null }
    }

    const auth = () => async (c, next) => {
      const auth = c.req.header('Authorization')
      if (!auth || !auth.startsWith('Bearer ')) return c.json({ success: false, error: 'تسجيل الدخول مطلوب' }, 401)
      const user = await verify(auth.slice(7))
      if (!user) return c.json({ success: false, error: 'انتهت الجلسة' }, 401)
      c.set('user', user)
      await next()
    }

    const mod = () => async (c, next) => {
      const user = c.get('user')
      if (!user || (user.role !== 'moderator' && user.role !== 'admin')) return c.json({ success: false, error: 'غير مصرح' }, 403)
      await next()
    }

    const sanitize = s => s ? s.replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;' })[c] || c) : ''

    // ========== التسجيل والدخول ==========
    app.post('/api/register', async c => {
      try {
        const { username, email, password } = await c.req.json()
        if (!username || !email || !password) return c.json({ success: false, error: 'جميع الحقول مطلوبة' })
        if (password.length < 6) return c.json({ success: false, error: 'كلمة المرور 6 أحرف على الأقل' })
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
        if (existing) return c.json({ success: false, error: 'البريد مستخدم من قبل' })
        const hash = await hashPassword(password)
        const { meta } = await env.DB.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').bind(username, email, hash).run()
        const token = await makeToken({ id: meta.last_row_id, username, email, role: 'user' })
        return c.json({ success: true, token, user: { id: meta.last_row_id, username, email, role: 'user', bio: '♥ صل على النبي ♥', avatar: '' } })
      } catch (e) { return c.json({ success: false, error: 'خطأ في التسجيل' }) }
    })

    app.post('/api/login', async c => {
      try {
        const { email, password } = await c.req.json()
        if (!email || !password) return c.json({ success: false, error: 'البريد وكلمة المرور مطلوبان' })
        const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
        if (!user) return c.json({ success: false, error: 'بريد إلكتروني غير صحيح' })
        const hash = await hashPassword(password)
        if (user.password !== hash) return c.json({ success: false, error: 'كلمة مرور غير صحيحة' })
        const token = await makeToken({ id: user.id, username: user.username, email: user.email, role: user.role })
        return c.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, role: user.role, bio: user.bio, avatar: '' } })
      } catch (e) { return c.json({ success: false, error: 'خطأ في الدخول' }) }
    })

    async function hashPassword(password) {
      const enc = new TextEncoder().encode(password)
      const buf = await crypto.subtle.digest('SHA-256', enc)
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
    }

    // ========== الفيديوهات ==========
    app.get('/api/videos', async c => {
      const status = c.req.query('status')
      const category = c.req.query('category')
      let sql = 'SELECT v.*, u.username as author FROM videos v JOIN users u ON v.user_id = u.id WHERE 1=1'
      const params = []
      if (status === 'pending') { sql += ' AND v.status = ?'; params.push('pending_moderation') }
      else if (status) { sql += ' AND v.status = ?'; params.push(status) }
      else { sql += " AND v.status = 'approved'" }
      if (category && category !== 'all') { sql += ' AND v.category = ?'; params.push(category) }
      sql += ' ORDER BY v.created_at DESC'
      const { results } = await env.DB.prepare(sql).bind(...params).all()
      return c.json(results.map(v => ({
        id: v.id, url: v.url, description: v.description, category: v.category, status: v.status,
        author: v.author, likes: v.likes || 0, comments: v.comments || 0, flag: v.flag, reason: v.reason,
        duration: v.duration, createdAt: v.created_at, fallbackUrl: v.url, streamUrl: v.url, processed_url: v.url
      })))
    })

    app.post('/api/videos', auth(), mod(), async c => {
      const user = c.get('user')
      const { url, description, category } = await c.req.json()
      const { meta } = await env.DB.prepare('INSERT INTO videos (user_id, url, description, category) VALUES (?, ?, ?, ?)').bind(user.id, url, description||'', category||'general').run()
      return c.json({ success: true, videoId: meta.last_row_id })
    })

    // ========== الرفع ==========
    app.post('/api/upload', auth(), async c => {
      const user = c.get('user')
      const formData = await c.req.formData()
      const file = formData.get('video')
      const description = formData.get('description') || 'مقطع جديد'
      const category = formData.get('category') || 'general'
      if (!file) return c.json({ success: false, error: 'اختر ملف فيديو' })
      if (file.size > 200*1024*1024) return c.json({ success: false, error: 'الملف كبير جداً (حد أقصى 200MB)' })
      const ext = file.name.split('.').pop() || 'mp4'
      const key = `videos/${crypto.randomUUID()}.${ext}`
      await env.VIDEOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'video/mp4' } })
      const url = `/api/video/${key}`
      const { meta } = await env.DB.prepare('INSERT INTO videos (user_id, url, description, category, status) VALUES (?, ?, ?, ?, ?)').bind(user.id, url, description, category, 'pending_moderation').run()
      await env.DB.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)').bind(user.id, '📹 تم رفع فيديو جديد وهو قيد المراجعة', 'info').run()
      return c.json({ success: true, videoId: meta.last_row_id })
    })

    // ========== خدمة الفيديو ==========
    app.get('/api/video/*', async c => {
      const key = c.req.path.replace('/api/video/', '')
      const obj = await env.VIDEOS.get(key)
      if (!obj) return c.json({ error: 'غير موجود' }, 404)
      const headers = new Headers()
      obj.writeHttpMetadata(headers)
      headers.set('Accept-Ranges', 'bytes')
      headers.set('Cache-Control', 'public, max-age=31536000')
      const range = c.req.header('Range')
      if (range) {
        const [start, end] = range.replace('bytes=', '').split('-').map(Number)
        const body = await obj.slice(start || 0, end || obj.size)
        headers.set('Content-Range', `bytes ${start||0}-${end||obj.size-1}/${obj.size}`)
        return new Response(body, { status: 206, headers })
      }
      return new Response(obj.body, { headers })
    })

    // ========== الإعجابات ==========
    app.post('/api/like/:videoId', auth(), async c => {
      const user = c.get('user')
      const videoId = c.req.param('videoId')
      const existing = await env.DB.prepare('SELECT id FROM likes WHERE user_id=? AND video_id=?').bind(user.id, videoId).first()
      if (existing) {
        await env.DB.prepare('DELETE FROM likes WHERE id=?').bind(existing.id).run()
        await env.DB.prepare('UPDATE videos SET likes = MAX(0, likes - 1) WHERE id=?').bind(videoId).run()
        const v = await env.DB.prepare('SELECT likes FROM videos WHERE id=?').bind(videoId).first()
        return c.json({ success: true, liked: false, count: v?.likes || 0 })
      } else {
        await env.DB.prepare('INSERT INTO likes (user_id, video_id) VALUES (?, ?)').bind(user.id, videoId).run()
        await env.DB.prepare('UPDATE videos SET likes = likes + 1 WHERE id=?').bind(videoId).run()
        const v = await env.DB.prepare('SELECT likes FROM videos WHERE id=?').bind(videoId).first()
        return c.json({ success: true, liked: true, count: v?.likes || 0 })
      }
    })

    app.get('/api/liked/:videoId', auth(), async c => {
      const user = c.get('user')
      const existing = await env.DB.prepare('SELECT id FROM likes WHERE user_id=? AND video_id=?').bind(user.id, c.req.param('videoId')).first()
      return c.json({ liked: !!existing })
    })

    app.get('/api/my-likes', auth(), async c => {
      const user = c.get('user')
      const { results } = await env.DB.prepare(
        'SELECT v.*, u.username as author FROM likes l JOIN videos v ON v.id=l.video_id JOIN users u ON v.user_id=u.id WHERE l.user_id=? AND v.status="approved" ORDER BY l.created_at DESC'
      ).bind(user.id).all()
      return c.json(results.map(v => ({ ...v, url: v.url, fallbackUrl: v.url, processed_url: v.url })))
    })

    app.get('/api/my-videos', auth(), async c => {
      const user = c.get('user')
      const { results } = await env.DB.prepare('SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all()
      return c.json(results.map(v => ({ ...v, url: v.url, fallbackUrl: v.url, processed_url: v.url, createdAt: v.created_at })))
    })

    app.get('/api/my-shares', auth(), async c => {
      const user = c.get('user')
      const { results } = await env.DB.prepare(
        'SELECT v.*, u.username as author FROM engagement_metrics e JOIN videos v ON v.id=e.video_id JOIN users u ON v.user_id=u.id WHERE e.user_id=? AND e.action="shared" ORDER BY e.created_at DESC'
      ).bind(user.id).all()
      return c.json(results.map(v => ({ ...v, url: v.url, fallbackUrl: v.url, processed_url: v.url })))
    })

    // ========== التفاعل ==========
    app.post('/api/engagement', auth(), async c => {
      const user = c.get('user')
      const { videoId, action } = await c.req.json()
      if (!['completed','replayed','saved','shared'].includes(action)) return c.json({ success: false, error: 'إجراء غير صحيح' })
      await env.DB.prepare('INSERT INTO engagement_metrics (user_id, video_id, action) VALUES (?, ?, ?)').bind(user.id, videoId, action).run()
      return c.json({ success: true })
    })

    app.get('/api/engagement/metrics', auth(), mod(), async c => {
      const total = (await env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics').first()).c
      const completed = (await env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="completed"').first()).c
      const replayed = (await env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="replayed"').first()).c
      const saved = (await env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="saved"').first()).c
      const shared = (await env.DB.prepare('SELECT COUNT(*) as c FROM engagement_metrics WHERE action="shared"').first()).c
      const { results: mostCompleted } = await env.DB.prepare(
        'SELECT v.id, v.description, v.url, COUNT(*) as cnt FROM engagement_metrics e JOIN videos v ON v.id=e.video_id WHERE e.action="completed" GROUP BY e.video_id ORDER BY cnt DESC LIMIT 10'
      ).all()
      return c.json({ totalEngagements: total, totalCompletions: completed, totalReplays: replayed, savedCount: saved, sharedCount: shared, replayPercent: completed > 0 ? Math.round(replayed/completed*100) : 0, mostCompleted })
    })

    // ========== التعليقات ==========
    app.post('/api/comment/:videoId', auth(), async c => {
      const user = c.get('user')
      const { content } = await c.req.json()
      if (!content || !content.trim()) return c.json({ success: false, error: 'التعليق فارغ' })
      await env.DB.prepare('INSERT INTO comments (user_id, video_id, content) VALUES (?, ?, ?)').bind(user.id, c.req.param('videoId'), sanitize(content.trim())).run()
      await env.DB.prepare('UPDATE videos SET comments = comments + 1 WHERE id=?').bind(c.req.param('videoId')).run()
      return c.json({ success: true })
    })

    app.get('/api/comments/:videoId', auth(), async c => {
      const { results } = await env.DB.prepare(
        'SELECT c.*, u.username FROM comments c JOIN users u ON c.user_id=u.id WHERE c.video_id=? ORDER BY c.created_at DESC LIMIT 100'
      ).bind(c.req.param('videoId')).all()
      return c.json(results)
    })

    // ========== الملف الشخصي ==========
    app.post('/api/update-profile', auth(), async c => {
      const user = c.get('user')
      const { username, bio } = await c.req.json()
      if (username) await env.DB.prepare('UPDATE users SET username=? WHERE id=?').bind(sanitize(username), user.id).run()
      if (bio !== undefined) await env.DB.prepare('UPDATE users SET bio=? WHERE id=?').bind(sanitize(bio), user.id).run()
      return c.json({ success: true })
    })

    app.delete('/api/my-data', auth(), async c => {
      const user = c.get('user')
      await env.DB.prepare('DELETE FROM likes WHERE user_id=?').bind(user.id).run()
      await env.DB.prepare('DELETE FROM comments WHERE user_id=?').bind(user.id).run()
      await env.DB.prepare('DELETE FROM engagement_metrics WHERE user_id=?').bind(user.id).run()
      await env.DB.prepare('DELETE FROM notifications WHERE user_id=?').bind(user.id).run()
      return c.json({ success: true, message: 'تم حذف جميع بيانات التفاعل' })
    })

    // ========== الإشعارات ==========
    app.get('/api/notifications', auth(), async c => {
      const user = c.get('user')
      const { results } = await env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(user.id).all()
      return c.json(results)
    })

    app.post('/api/notifications/read', auth(), async c => {
      const user = c.get('user')
      await env.DB.prepare('UPDATE notifications SET read=1 WHERE user_id=?').bind(user.id).run()
      return c.json({ success: true })
    })

    // ========== الرقابة ==========
    app.post('/api/moderate/:videoId', auth(), mod(), async c => {
      const user = c.get('user')
      const { action, reason } = await c.req.json()
      const videoId = c.req.param('videoId')
      if (action === 'approve') {
        await env.DB.prepare("UPDATE videos SET status='approved', moderated_by=? WHERE id=?").bind(user.id, videoId).run()
      } else if (action === 'reject') {
        await env.DB.prepare("UPDATE videos SET status='rejected', reason=?, moderated_by=? WHERE id=?").bind(reason||'مخالف للسياسة', user.id, videoId).run()
      } else {
        await env.DB.prepare("UPDATE videos SET status='pending_moderation', reason=?, moderated_by=? WHERE id=?").bind(reason||'', user.id, videoId).run()
      }
      return c.json({ success: true })
    })

    app.get('/api/moderation-logs', auth(), mod(), async c => {
      const { results } = await env.DB.prepare('SELECT * FROM videos WHERE status IN ("approved","rejected") ORDER BY updated_at DESC LIMIT 50').all()
      return c.json(results)
    })

    app.get('/api/collect-data', auth(), async c => c.json({ success: true }))

    // ========== التنفيذ ==========
    return app.fetch(request, env, ctx)
  }
}
