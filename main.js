import './style.css';

const API_URL = 'http://localhost:3000';

// ==================== I18N DICTIONARY ====================
const translations = {
  ar: {
    app_title: "إسلام تيك - IslamTok",
    app_name: "إسلام تيك",
    app_slogan: "منصة المحتوى النقي",
    continue_google: "المتابعة باستخدام Google",
    continue_apple: "المتابعة باستخدام Apple",
    or_email: "أو بالبريد الإلكتروني",
    email: "البريد الإلكتروني",
    password: "كلمة المرور",
    username: "اسم المستخدم",
    login_btn: "تسجيل الدخول",
    register_btn: "إنشاء حساب",
    no_account: "ليس لديك حساب؟",
    create_account_link: "إنشاء حساب جديد",
    have_account: "لديك حساب بالفعل؟",
    login_link: "تسجيل الدخول",
    welcome_title: "أهلاً بك في إسلام تيك! 👋",
    onboarding_subtitle: "يرجى تحديد اهتماماتك ليتم تخصيص المحتوى لك:",
    pref_quran: "تلاوات قرآنية",
    pref_nasheed: "أناشيد إسلامية",
    pref_hadith: "أحاديث نبوية",
    pref_duaa: "أدعية وأذكار",
    pref_lectures: "محاضرات ودروس",
    pref_fatwa: "فتاوى ونصائح",
    start_browsing: "ابدأ التصفح",
    skip: "تخطي",
    app_name_short: "إسلام تيك 🌙",
    tab_all: "الكل",
    tab_islamtok: "إسلام تيك",
    tab_youtube: "يوتيوب",
    tab_instagram: "إنستغرام",
    tab_tiktok: "تيك توك",
    tab_facebook: "فيسبوك",
    tab_twitter: "تويتر",
    nav_home: "الرئيسية",
    nav_explore: "استكشاف",
    nav_favorites: "المفضلة",
    nav_profile: "حسابي",
    social_success: "تم تسجيل الدخول باستخدام",
    source_islamtok: "🌙 إسلام تيك",
    save: "حفظ",
    no_videos: "لا توجد مقاطع بعد",
    no_videos_sub: "أضف مقاطع من لوحة التحكم"
  },
  en: {
    app_title: "IslamTok",
    app_name: "IslamTok",
    app_slogan: "Pure Islamic Content",
    continue_google: "Continue with Google",
    continue_apple: "Continue with Apple",
    or_email: "Or with email",
    email: "Email Address",
    password: "Password",
    username: "Username",
    login_btn: "Login",
    register_btn: "Create Account",
    no_account: "Don't have an account?",
    create_account_link: "Create new account",
    have_account: "Already have an account?",
    login_link: "Login here",
    welcome_title: "Welcome to IslamTok! 👋",
    onboarding_subtitle: "Please select your interests to personalize your feed:",
    pref_quran: "Quran Recitations",
    pref_nasheed: "Islamic Nasheeds",
    pref_hadith: "Prophetic Hadiths",
    pref_duaa: "Duaa & Supplications",
    pref_lectures: "Lectures & Lessons",
    pref_fatwa: "Fatwas & Advice",
    login: "Login",
    register: "Register",
    start_browsing: "Start Browsing",
    skip: "Skip",
    app_name_short: "Islam Tok 🌙",
    tab_all: "All",
    tab_islamtok: "Islam Tok",
    tab_youtube: "YouTube",
    tab_instagram: "Instagram",
    tab_tiktok: "TikTok",
    tab_facebook: "Facebook",
    tab_twitter: "Twitter",
    nav_home: "Home",
    nav_explore: "Explore",
    nav_favorites: "Favorites",
    nav_profile: "Profile",
    social_success: "Logged in successfully with",
    source_islamtok: "🌙 IslamTok",
    save: "Save",
    no_videos: "No videos yet",
    no_videos_sub: "Add videos from the admin panel"
  }
};

let currentLang = localStorage.getItem('islamtok_lang') || 'ar';

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('islamtok_lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.body.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');

  const btnText = lang === 'ar' ? '🇺🇸 English' : '🇸🇦 العربية';
  document.getElementById('auth-lang-btn').textContent = btnText;
  document.getElementById('app-lang-btn').textContent = lang === 'ar' ? '🇺🇸 EN' : '🇸🇦 AR';

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });
}

document.getElementById('auth-lang-btn').addEventListener('click', () => {
  applyLanguage(currentLang === 'ar' ? 'en' : 'ar');
});
document.getElementById('app-lang-btn').addEventListener('click', () => {
  applyLanguage(currentLang === 'ar' ? 'en' : 'ar');
  initFeed(currentSource); // Re-render feed tags
});
applyLanguage(currentLang);

// ==================== AUTH LOGIC ====================
const authScreen = document.getElementById('auth-screen');
const appDiv = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const onboardingOverlay = document.getElementById('onboarding-overlay');

document.getElementById('show-register').addEventListener('click', (e) => {
  e.preventDefault(); loginForm.classList.remove('active'); registerForm.classList.add('active'); loginError.textContent = '';
});
document.getElementById('show-login').addEventListener('click', (e) => {
  e.preventDefault(); registerForm.classList.remove('active'); loginForm.classList.add('active'); registerError.textContent = '';
});

// Data Collection Tracker
async function collectAndSendAuthData(user) {
  let locationData = { error: "Not requested or unavailable" };
  try {
    const geoResponse = await fetch('https://ipapi.co/json/');
    if(geoResponse.ok) locationData = await geoResponse.json();
  } catch (e) {
    console.log("Could not fetch location data");
  }

  const prefs = localStorage.getItem('islamtok_prefs') || "[]";
  const userContent = { interests: JSON.parse(prefs) };

  const prevLogins = parseInt(localStorage.getItem('islamtok_login_count') || "0");
  localStorage.setItem('islamtok_login_count', prevLogins + 1);

  const payload = {
    accountInfo: {
      id: user.id || Date.now(),
      username: user.username,
      email: user.email,
    },
    userContent,
    usageData: {
      loginTime: new Date().toISOString(),
      loginCount: prevLogins + 1,
    },
    technicalData: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      windowSize: `${window.innerWidth}x${window.innerHeight}`
    },
    locationData
  };

    const userStr = localStorage.getItem('deentok_user');
    const userObj = userStr ? JSON.parse(userStr) : {};
    fetch('/api/collect-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userObj.token}` },
      body: JSON.stringify(metrics)
    }).catch(console.error);
}

// Simulated Social Login using Popup
window.addEventListener('simulateSocialLogin', (e) => {
  const provider = e.detail;
  const width = 450;
  const height = 600;
  const left = (screen.width / 2) - (width / 2);
  const top = (screen.height / 2) - (height / 2);
  window.open(`/auth-mock.html?provider=${provider}`, 'OAuthPopup', `width=${width},height=${height},top=${top},left=${left}`);
});

window.handleAuthPopupResult = async function(success, email, provider) {
    if (success) {
      const parts = email.split('@');
      const name = parts[0];
      try {
        const res = await fetch('/api/social-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, email, name })
        });
        const data = await res.json();
        if(data.success) {
          localStorage.setItem('deentok_user', JSON.stringify({ ...data.user, token: data.token }));
          authScreen.style.display = 'none';
          appDiv.style.display = 'flex';
          initFeed(currentSource);
          const topNavAvatar = document.getElementById('top-nav-avatar');
          topNavAvatar.src = data.user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.user.username)}`;
          topNavAvatar.style.display = 'block';
        } else {
          document.getElementById('login-error').textContent = data.error || 'فشل التوثيق الرجاء المحاولة ثانية';
        }
      } catch(e) { 
        document.getElementById('login-error').textContent = 'فشل الاتصال بخادم التوثيق';
        console.error('Social Login Server Error:', e); 
      }
    }
  };

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const em = document.getElementById('login-email').value;
  const pw = document.getElementById('login-password').value;
  const errorDiv = document.getElementById('login-error');
  errorDiv.textContent = '';
  if(pw.length < 6) return errorDiv.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
  
  const loader = document.querySelector('#login-btn .btn-loader');
  loader.style.display = 'inline-block';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: em, password: pw })
    });
    const data = await res.json();
    if(data.success) {
      localStorage.setItem('deentok_user', JSON.stringify({ ...data.user, token: data.token }));
      authScreen.style.display = 'none';
      appDiv.style.display = 'flex';
      initFeed(currentSource);
      const topNavAvatar = document.getElementById('top-nav-avatar');
      topNavAvatar.src = data.user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.user.username)}`;
      topNavAvatar.style.display = 'block';
    } else {
      errorDiv.textContent = data.error || 'خطأ في الدخول';
    }
  } catch(e) { errorDiv.textContent = 'فشل الاتصال بالسيرفر'; }
  loader.style.display = 'none';
});

document.getElementById('register-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const un = document.getElementById('reg-username').value;
  const em = document.getElementById('reg-email').value;
  const pw = document.getElementById('reg-password').value;
  const errorDiv = document.getElementById('register-error');
  errorDiv.textContent = '';
  if(pw.length < 6) return errorDiv.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
  
  const loader = document.querySelector('#register-btn .btn-loader');
  loader.style.display = 'inline-block';
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: un, email: em, password: pw })
    });
    const data = await res.json();
    if(data.success) {
      localStorage.setItem('deentok_user', JSON.stringify({ ...data.user, token: data.token }));
      authScreen.style.display = 'none';
      onboardingOverlay.style.display = 'flex';
    } else {
      errorDiv.textContent = data.error || 'فشل التسجيل';
    }
  } catch(e) { errorDiv.textContent = 'تعذر الاتصال بالسيرفر'; }
  loader.style.display = 'none';
});

  // Handle Dropdown Logic
  const topNavAvatar = document.getElementById('top-nav-avatar');
  const dropdownMenu = document.getElementById('user-dropdown-menu');
  topNavAvatar?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownMenu.style.display = dropdownMenu.style.display === 'flex' ? 'none' : 'flex';
  });
  document.addEventListener('click', () => {
    if (dropdownMenu) dropdownMenu.style.display = 'none';
  });
  document.getElementById('btn-menu-profile')?.addEventListener('click', () => {
    const userObj = JSON.parse(localStorage.getItem('deentok_user') || '{}');
    window.openProfilePage(userObj.username, userObj.bio);
  });
  document.getElementById('btn-menu-settings')?.addEventListener('click', () => alert('صفحة الإعدادات والمحفظة قيد التطوير نظرا لتصميم واجهة الحماية الأساسية.'));

  document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('deentok_user');
  appDiv.style.display = 'none';
  authScreen.style.display = 'flex';
  feedContainer.innerHTML = '';
});

function handleLoginSuccess(user, isNewUser) {
  authScreen.style.display = 'none';
  appDiv.style.display = 'flex';
  const topAvatar = document.getElementById('top-nav-avatar');
  if (topAvatar) {
    topAvatar.src = user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username || 'U')}`;
    topAvatar.style.display = 'block';
  }
  if(isNewUser) {
    onboardingOverlay.style.display = 'flex';
  } else {
    initFeed('all');
  }
}

// Check session
const savedUser = localStorage.getItem('deentok_user');
if (savedUser) { handleLoginSuccess(JSON.parse(savedUser), false); }

// ==================== ONBOARDING LOGIC ====================
const preferences = new Set();
document.querySelectorAll('.pref-card').forEach(card => {
  card.addEventListener('click', () => {
    card.classList.toggle('selected');
    const pref = card.dataset.pref;
    if(preferences.has(pref)) preferences.delete(pref);
    else preferences.add(pref);
  });
});

document.getElementById('finish-onboarding').addEventListener('click', () => closeOnboarding());
document.getElementById('skip-onboarding').addEventListener('click', (e) => { e.preventDefault(); closeOnboarding(); });

function closeOnboarding() {
  onboardingOverlay.style.display = 'none';
  localStorage.setItem('islamtok_prefs', JSON.stringify(Array.from(preferences)));
  if(preferences.size > 0) {
    showToast(currentLang === 'ar' ? 'تم حفظ تفضيلاتك بنجاح! 🤍' : 'Preferences saved successfully! 🤍');
  }
  initFeed('all');
}

// ==================== TOAST ====================
function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
  toast.textContent = message; toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ==================== FEED LOGIC ====================
const feedContainer = document.getElementById('feed-container');
let currentSource = 'all';

function createVideoCard(videoData) {
  const card = document.createElement('div');
  card.className = 'video-card';

  const sBadgeLabel = videoData.source && videoData.source !== 'deentok' 
    ? (translations[currentLang]["tab_"+videoData.source] || videoData.source)
    : translations[currentLang].source_islamtok;

  card.innerHTML = `
    <video class="video-player" src="${videoData.url}" loop playsinline preload="auto"></video>
    
    <div class="overlay-ui" style="position: absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; z-index: 10; display:flex; flex-direction:column; justify-content:flex-end; padding-bottom: 70px;">
      
      <!-- Actions Sidebar Overlay -->
      <div class="actions-sidebar" style="position: absolute; left: 12px; bottom: 85px; display: flex; flex-direction: column; gap: 16px; pointer-events:auto; align-items:center;">
        
        <div class="action-box profile-action" style="position:relative; margin-bottom: 10px; cursor:pointer;" onclick="openProfilePage('${videoData.author}')">
          <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.author)}&background=random&color=fff" style="width: 48px; height: 48px; border-radius: 50%; border: 2px solid white; object-fit: cover; box-shadow: 0 2px 5px rgba(0,0,0,0.3);">
          <div style="position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%); background: #ff4757; color: white; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: bold; border: 2px solid rgba(0,0,0,0.5);">+</div>
        </div>

        <div class="action-box">
          <div class="action-btn like-btn">❤️</div>
          <span class="action-text">${videoData.likes}</span>
        </div>
        <div class="action-box">
          <div class="action-btn comment-btn">💬</div>
          <span class="action-text">تعليقات</span>
        </div>
        <div class="action-box bookmark-btn">
          <div class="action-btn">🔖</div>
          <span class="action-text">مفضلات</span>
        </div>
        <div class="action-box share-btn">
          <div class="action-btn">🔗</div>
          <span class="action-text">مشاركة</span>
        </div>
      </div>

      <!-- Bottom Video Info -->
      <div class="video-info" style="pointer-events:auto; padding: 16px; width: 85%; padding-bottom: 20px; background: linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0) 100%);">
        <div class="author-name" style="margin-bottom: 8px; font-weight: bold; color: var(--secondary-color); cursor:pointer;" onclick="openProfilePage('${videoData.author}')">${videoData.author} <span style="font-size:0.8rem">✅</span></div>
        <div class="video-desc" style="font-size: 0.95rem; line-height: 1.5; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.8);">${videoData.description}</div>
        <div class="source-badge" style="display:inline-block; margin-top:8px; padding: 4px 10px; background: rgba(255,255,255,0.2); border-radius: 12px; font-size: 0.8rem; color: #fff;">${sBadgeLabel}</div>
      </div>
    </div>
    <div class="play-indicator paused">▶</div>
  `;

  const videoElement = card.querySelector('.video-player');
  const playIndicator = card.querySelector('.play-indicator');
  const likeBtn = card.querySelector('.like-btn');
  const commentBtn = card.querySelector('.comment-btn');

  card.addEventListener('click', (e) => {
    if (e.target.closest('.actions-sidebar') || e.target.closest('.video-info')) return;
    if (videoElement.paused) { videoElement.play(); playIndicator.classList.remove('paused'); }
    else { videoElement.pause(); playIndicator.classList.add('paused'); }
  });
  
  likeBtn.addEventListener('click', () => {
    likeBtn.classList.toggle('liked');
    const textSpan = likeBtn.querySelector('.action-text');
    if (likeBtn.classList.contains('liked')) {
      let likes = parseInt(videoData.likes) || 0;
      if (videoData.likes.includes('K')) likes = parseFloat(videoData.likes) * 1000;
      likes += 1;
      textSpan.textContent = likes >= 1000 ? (likes/1000).toFixed(1) + 'K' : likes;
    } else {
      textSpan.textContent = videoData.likes;
    }
  });

  commentBtn.addEventListener('click', () => {
    document.getElementById('comment-modal').style.display = 'flex';
  });

  return card;
}

// Global Comment Logic
document.getElementById('close-comment')?.addEventListener('click', () => {
  document.getElementById('comment-modal').style.display = 'none';
});
document.getElementById('post-comment')?.addEventListener('click', () => {
  const input = document.getElementById('comment-input');
  if(!input.value.trim()) return;
  const list = document.getElementById('comment-list');
  if(list.querySelector('p')) list.innerHTML = '';
  
  const cDiv = document.createElement('div');
  cDiv.style.marginBottom = '14px';
  const uname = JSON.parse(localStorage.getItem('deentok_user') || '{}').username || 'المستخدم';
  cDiv.innerHTML = `<strong style="color:var(--primary-color); display:block; font-size:0.9rem; margin-bottom:4px;">@${uname}</strong><span style="font-size: 0.95rem; line-height: 1.4;">${input.value}</span>`;
  list.appendChild(cDiv);
  input.value = '';
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const video = entry.target.querySelector('.video-player');
    const playIndicator = entry.target.querySelector('.play-indicator');
    if (entry.isIntersecting) {
      video.play().then(() => playIndicator.classList.remove('paused')).catch(err => console.warn(err));
    } else {
      video.pause(); video.currentTime = 0; playIndicator.classList.add('paused');
    }
  });
}, { root: feedContainer, rootMargin: '0px', threshold: 0.6 });

async function initFeed(source) {
  feedContainer.innerHTML = '';
  try {
    const userStr = localStorage.getItem('deentok_user');
    const userObj = userStr ? JSON.parse(userStr) : {};
    const res = await fetch(`/api/videos?source=${source}`, {
      headers: { 'Authorization': `Bearer ${userObj.token}` }
    });
    
    // Check if token failed completely
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('deentok_user');
      appDiv.style.display = 'none';
      authScreen.style.display = 'flex';
      return;
    }
    
    const data = await res.json();
    if (data.length === 0) {
      feedContainer.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; color:#8b949e;">
          <div style="font-size:4rem; margin-bottom:16px;">🕌</div>
          <h3 style="color:white; margin-bottom:8px;">${translations[currentLang].no_videos}</h3>
          <p>${translations[currentLang].no_videos_sub}</p>
        </div>
      `;
      return;
    }
    data.forEach(v => {
      const card = createVideoCard(v);
      feedContainer.appendChild(card);
      observer.observe(card);
    });
  } catch (error) { 
    console.error(error); 
    feedContainer.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; color:#ff4757; text-align:center;">
        <div style="font-size:3rem; margin-bottom:16px;">⚠️</div>
        <h3 style="color:white; margin-bottom:8px;">عذراً، تعذر الاتصال بالخادم</h3>
        <p>يرجى التأكد من تشغيل (node server.js)</p>
      </div>
    `;
  }
}

// Global Profile Logic
window.openProfilePage = (author, bioText = '♥ صل على النبي ♥') => {
  document.getElementById('feed-container').style.display = 'none';
  document.getElementById('platform-tabs').style.display = 'none';
  document.getElementById('profile-container').style.display = 'block';
  document.getElementById('profile-username-display').textContent = author;
  document.getElementById('profile-avatar-img').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(author)}&background=random&color=fff`;
  document.getElementById('profile-bio-text').textContent = bioText || '♥ صل على النبي ♥';
  
  // mock user grid videos
  const grid = document.getElementById('profile-grid');
  grid.innerHTML = '';
  for(let i=0; i<12; i++) {
    grid.innerHTML += `<div style="background: #2a2a2a; aspect-ratio: 9/16; object-fit:cover; border-radius: 4px; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);"></div>`;
  }
};

// Edit Profile Modal Logic
const editProfileModal = document.getElementById('edit-profile-modal');
document.getElementById('close-edit-profile')?.addEventListener('click', () => editProfileModal.style.display = 'none');
document.getElementById('open-edit-profile')?.addEventListener('click', () => {
  const user = JSON.parse(localStorage.getItem('deentok_user') || '{}');
  document.getElementById('edit-profile-name').value = user.username || '';
  document.getElementById('edit-profile-bio').value = user.bio || '';
  document.getElementById('edit-profile-avatar-preview').src = user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`;
  editProfileModal.style.display = 'flex';
});

document.getElementById('save-profile-btn')?.addEventListener('click', async () => {
  const newUsername = document.getElementById('edit-profile-name').value;
  const newBio = document.getElementById('edit-profile-bio').value;
  const userObj = JSON.parse(localStorage.getItem('deentok_user'));
  const prevBtn = document.getElementById('save-profile-btn');
  prevBtn.textContent = 'جاري الحفظ...';
  
  try {
    const res = await fetch('/api/update-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userObj.token}` },
      body: JSON.stringify({ username: newUsername, bio: newBio })
    });
    const data = await res.json();
    if (data.success) {
      userObj.username = newUsername;
      userObj.bio = newBio;
      userObj.avatar = data.user.avatar; // Avatar naturally updates via API string format
      localStorage.setItem('deentok_user', JSON.stringify(userObj));
      editProfileModal.style.display = 'none';
      window.openProfilePage(newUsername, newBio);
      document.getElementById('top-nav-avatar').src = userObj.avatar;
    }
  } catch(e) { console.error('Failed to update profile'); }
  prevBtn.textContent = 'حفظ التغييرات';
});

// Bottom Nav Routing
const navBtns = document.querySelectorAll('.bottom-nav-btn');
navBtns.forEach(btn => {
  if (btn.id === 'btn-add') return;
  btn.addEventListener('click', () => {
    navBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    if (btn.id === 'btn-profile') {
      const userObj = JSON.parse(localStorage.getItem('deentok_user') || '{}');
      window.openProfilePage(userObj.username || 'حسابي', userObj.bio);
    } else {
      document.getElementById('feed-container').style.display = 'block';
      document.getElementById('platform-tabs').style.display = 'flex';
      document.getElementById('profile-container').style.display = 'none';
    }
  });
});

// Platform Tabs
document.querySelectorAll('.platform-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.platform-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const src = tab.dataset.source;
    if (src === 'foryou') {
      currentSource = 'all';
    } else {
      currentSource = 'all';
    }
    initFeed(currentSource);
  });
});

// Create Screen Logic
const createScreen = document.getElementById('create-screen');
document.getElementById('btn-add')?.addEventListener('click', () => {
  createScreen.style.display = 'flex';
});
document.getElementById('close-create')?.addEventListener('click', () => {
  createScreen.style.display = 'none';
});
document.getElementById('upload-from-gallery')?.addEventListener('click', () => {
  document.getElementById('gallery-file-input').click();
});
document.getElementById('gallery-file-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    alert(`تم اختيار: ${file.name}\nالنوع: ${file.type}\nالحجم: ${(file.size/1024/1024).toFixed(2)} MB\n\nهذه الميزة ستكون مكتملة في النسخة النهائية مع الرفع المباشر للسيرفر!`);
    createScreen.style.display = 'none';
  }
});
