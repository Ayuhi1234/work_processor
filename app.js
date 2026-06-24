// ============================================================
// 0-Waste Work Processor — v3
// Local-first clock with auto-idle breaks + Google Sheets sync
// ============================================================

const API_URL = 'https://script.google.com/macros/s/AKfycbw3zr85zl9jRkJHcD4Qtd4srntbTY3ZzQ1GD3YjDnx8n26zTu8cNlhbrQTQjlMVPJ8K/exec';
const IDLE_TIMEOUT = 2 * 60 * 1000;   // 2 minutes idle = auto break
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

// -------- PWA: SERVICE WORKER + NOTIFICATIONS --------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => {
    console.log('Service Worker registered');
  }).catch(err => console.log('SW registration failed:', err));
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, {
      body: body,
      icon: 'images/3R LOGO.jpg',
      badge: 'images/3R LOGO.jpg',
      tag: 'work-processor'
    });
  }
}

let reminderInterval = null;

function startCheckInReminder() {
  clearInterval(reminderInterval);
  reminderInterval = setInterval(() => {
    const h = new Date().getHours();
    const day = getLocalDay();
    if (h >= 9 && h < 10 && (!day || !day.checkIn)) {
      sendNotification('Clock In Reminder', 'Good morning! Don\'t forget to clock in.');
    }
    if (h === 17 && day && day.checkIn && !day.checkOut) {
      sendNotification('Clock Out Reminder', 'It\'s 5 PM. Remember to clock out and log your tasks.');
    }
  }, 15 * 60 * 1000);
}

// -------- ZEN THEME ENGINE --------

function updateZenTheme() {
  const h = new Date().getHours();
  const month = new Date().getMonth();
  let time, season;

  if (h >= 6 && h < 12) time = 'morning';
  else if (h >= 12 && h < 17) time = 'afternoon';
  else if (h >= 17 && h < 20) time = 'evening';
  else time = 'night';

  if (month >= 2 && month <= 4) season = 'spring';
  else if (month >= 5 && month <= 7) season = 'summer';
  else if (month >= 8 && month <= 10) season = 'autumn';
  else season = 'winter';

  document.body.setAttribute('data-time', time);
  document.body.setAttribute('data-season', season);
}

updateZenTheme();
setInterval(updateZenTheme, 60000);

// -------- STATE --------
let currentUser = null;
let sessionExpiresAt = null;
let clockInterval = null;
let idleCheckInterval = null;
let lastActivity = Date.now();
let reportChart = null;

// -------- ACTIVITY TRACKING STATE --------
let minuteEvents = 0;
let activityHistory = [];  // events per minute for last 60 min
let totalEvents = 0;
let tabFocused = true;
let focusLostAt = null;
let totalUnfocusedSec = 0;
let activityMinuteTimer = null;

// -------- LOCAL TIME TRACKING --------

function todayKey() { return 'wp_day_' + new Date().toISOString().split('T')[0]; }
function nowTimeStr() {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
}

function getLocalDay() {
  const raw = localStorage.getItem(todayKey());
  if (!raw) return null;
  return JSON.parse(raw);
}

function saveLocalDay(day) {
  localStorage.setItem(todayKey(), JSON.stringify(day));
}

// Auto-close yesterday if forgot to clock out
function checkYesterdayForgotten() {
  for (let i = 1; i <= 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = 'wp_day_' + d.toISOString().split('T')[0];
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const old = JSON.parse(raw);
    if (old.checkIn && !old.checkOut) {
      old.checkOut = '23:59:59';
      old.status = 'auto-closed';
      const totalSec = timeDiffSec(old.checkIn, '23:59:59');
      const breakSec = (old.breaks || []).reduce((s, b) => s + (b.duration || 0), 0);
      old.autoCloseReason = 'Forgot to clock out';
      localStorage.setItem(key, JSON.stringify(old));

      toast('Yesterday (' + d.toISOString().split('T')[0] + ') was auto-closed at 23:59. You forgot to clock out.', 'error');

      if (currentUser) {
        bgSync('syncDaySummary', {
          employeeId: currentUser.ID,
          employeeName: currentUser.Name,
          checkIn: old.checkIn,
          checkOut: '23:59:59',
          totalMinutes: Math.round(totalSec / 60),
          breakMinutes: Math.round(breakSec / 60),
          netMinutes: Math.max(0, Math.round((totalSec - breakSec) / 60))
        });
      }
    }
  }
}

function localCheckIn() {
  const existing = getLocalDay();
  if (existing) return existing;
  const day = {
    checkIn: nowTimeStr(),
    checkOut: null,
    status: 'working',
    breaks: [],
    currentBreak: null
  };
  saveLocalDay(day);
  return day;
}

function localCheckOut() {
  const day = getLocalDay();
  if (!day || day.checkOut) return day;
  if (day.currentBreak) {
    day.currentBreak.end = nowTimeStr();
    day.currentBreak.duration = timeDiffSec(day.currentBreak.start, day.currentBreak.end);
    day.breaks.push(day.currentBreak);
    day.currentBreak = null;
  }
  day.checkOut = nowTimeStr();
  day.status = 'completed';
  saveLocalDay(day);
  return day;
}

function localStartBreak(type) {
  const day = getLocalDay();
  if (!day || day.checkOut || day.currentBreak) return;
  day.currentBreak = { start: nowTimeStr(), end: null, type: type || 'manual', duration: 0 };
  day.status = 'on-break';
  saveLocalDay(day);
}

function localEndBreak() {
  const day = getLocalDay();
  if (!day || !day.currentBreak) return;
  day.currentBreak.end = nowTimeStr();
  day.currentBreak.duration = timeDiffSec(day.currentBreak.start, day.currentBreak.end);
  day.breaks.push(day.currentBreak);
  day.currentBreak = null;
  day.status = 'working';
  saveLocalDay(day);
}

function timeDiffSec(start, end) {
  const toSec = t => { const p = t.split(':'); return +p[0]*3600 + +p[1]*60 + (+p[2]||0); };
  return Math.max(0, toSec(end) - toSec(start));
}

function formatSec(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h + ':' + m + ':' + sec;
}

function formatSecShort(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

function getDayTotalBreakSec(day) {
  let total = day.breaks.reduce((s, b) => s + (b.duration || 0), 0);
  if (day.currentBreak) {
    total += timeDiffSec(day.currentBreak.start, nowTimeStr());
  }
  return total;
}

// -------- IDLE DETECTION + ACTIVITY TRACKING --------

function initIdleDetection() {
  ['mousemove','keydown','click','scroll','touchstart','mousedown'].forEach(evt => {
    document.addEventListener(evt, onActivity, { passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    const day = getLocalDay();
    if (!day || day.checkOut) return;

    if (document.hidden) {
      tabFocused = false;
      focusLostAt = Date.now();
    } else {
      tabFocused = true;
      if (focusLostAt) {
        totalUnfocusedSec += Math.round((Date.now() - focusLostAt) / 1000);
        focusLostAt = null;
      }
      onActivity();
    }
  });

  idleCheckInterval = setInterval(checkIdle, 5000);

  clearInterval(activityMinuteTimer);
  activityMinuteTimer = setInterval(() => {
    activityHistory.push(minuteEvents);
    if (activityHistory.length > 60) activityHistory.shift();
    minuteEvents = 0;
    updateActivityUI();
  }, 60000);
}

function onActivity() {
  lastActivity = Date.now();
  minuteEvents++;
  totalEvents++;

  const day = getLocalDay();
  if (day && day.status === 'on-break' && day.currentBreak && day.currentBreak.type === 'auto-idle') {
    localEndBreak();
    syncBreakEnd();
    toast('Welcome back! Break ended.', 'success');
    document.getElementById('idle-bar').style.display = 'none';
    updateClockUI();
  }
}

function checkIdle() {
  const day = getLocalDay();
  if (!day || day.checkOut || day.status !== 'working') return;
  if (Date.now() - lastActivity > IDLE_TIMEOUT) {
    localStartBreak('auto-idle');
    syncBreakStart('auto-idle');
    toast('You seem away — break auto-started', 'info');
    document.getElementById('idle-bar').style.display = '';
    updateClockUI();
  }
}

// -------- ACTIVITY UI --------

function getProductivityScore() {
  const day = getLocalDay();
  if (!day || !day.checkIn || day.checkOut) return 0;

  const elapsedSec = timeDiffSec(day.checkIn, nowTimeStr());
  const breakSec = getDayTotalBreakSec(day);
  const workSec = Math.max(1, elapsedSec - breakSec);

  // Activity score (60%): based on avg events per minute
  const avgEpm = activityHistory.length > 0
    ? activityHistory.reduce((s, e) => s + e, 0) / activityHistory.length
    : minuteEvents;
  const activityScore = Math.min(100, avgEpm * 4); // 25+ events/min = 100%

  // Focus score (40%): percentage of work time the tab was focused
  let unfocused = totalUnfocusedSec;
  if (focusLostAt) unfocused += Math.round((Date.now() - focusLostAt) / 1000);
  const focusRatio = workSec > 0 ? Math.max(0, (workSec - unfocused)) / workSec : 1;
  const focusScore = focusRatio * 100;

  return Math.round(activityScore * 0.6 + focusScore * 0.4);
}

function getActivityLevel() {
  const recent = activityHistory.length > 0 ? activityHistory[activityHistory.length - 1] : minuteEvents;
  if (recent >= 25) return { level: 'high', bars: 5, text: 'High', cls: '' };
  if (recent >= 15) return { level: 'good', bars: 4, text: 'Good', cls: '' };
  if (recent >= 8)  return { level: 'medium', bars: 3, text: 'Medium', cls: 'medium' };
  if (recent >= 3)  return { level: 'low', bars: 2, text: 'Low', cls: 'low' };
  return { level: 'idle', bars: 0, text: 'Idle', cls: 'low' };
}

function updateActivityUI() {
  const day = getLocalDay();
  if (!day || !day.checkIn || day.checkOut) return;

  const score = getProductivityScore();
  const activity = getActivityLevel();

  // Score ring
  const ring = document.getElementById('score-ring-fill');
  const scoreEl = document.getElementById('productivity-score');
  if (ring && scoreEl) {
    ring.setAttribute('stroke-dasharray', score + ', 100');
    ring.className.baseVal = 'score-ring-fill' + (score < 50 ? ' low' : score < 75 ? ' medium' : '');
    scoreEl.textContent = score + '%';
  }

  // Activity bars
  const bars = document.querySelectorAll('#activity-bars .a-bar');
  bars.forEach((bar, i) => {
    bar.className = 'a-bar' + (i < activity.bars ? ' active' + (activity.cls ? ' ' + activity.cls : '') : '');
  });
  const levelText = document.getElementById('activity-level-text');
  if (levelText) levelText.textContent = activity.text;

  // Focus percentage
  const elapsedSec = timeDiffSec(day.checkIn, nowTimeStr());
  const breakSec = getDayTotalBreakSec(day);
  const workSec = Math.max(1, elapsedSec - breakSec);
  let unfocused = totalUnfocusedSec;
  if (focusLostAt) unfocused += Math.round((Date.now() - focusLostAt) / 1000);
  const focusPct = Math.round(Math.max(0, (workSec - unfocused)) / workSec * 100);

  const focusVal = document.getElementById('focus-value');
  const focusDet = document.getElementById('focus-detail');
  if (focusVal) focusVal.textContent = focusPct + '%';
  if (focusDet) focusDet.textContent = tabFocused ? 'Focused' : 'Away';
  if (focusDet) focusDet.style.color = tabFocused ? 'var(--success)' : 'var(--danger)';

  // Events per minute
  const epmEl = document.getElementById('events-per-min');
  const trendEl = document.getElementById('events-trend');
  const currentEpm = activityHistory.length > 0 ? activityHistory[activityHistory.length - 1] : minuteEvents;
  const avgEpm = activityHistory.length > 1
    ? Math.round(activityHistory.reduce((s, e) => s + e, 0) / activityHistory.length)
    : currentEpm;
  if (epmEl) epmEl.textContent = currentEpm;
  if (trendEl) {
    if (currentEpm > avgEpm + 5) { trendEl.textContent = 'Above avg'; trendEl.style.color = 'var(--success)'; }
    else if (currentEpm < avgEpm - 5) { trendEl.textContent = 'Below avg'; trendEl.style.color = 'var(--danger)'; }
    else { trendEl.textContent = 'Normal'; trendEl.style.color = 'var(--gray-500)'; }
  }

  // Save activity data locally
  const dayData = getLocalDay();
  if (dayData) {
    dayData.activityScore = score;
    dayData.focusPercent = focusPct;
    dayData.avgEventsPerMin = avgEpm;
    dayData.totalUnfocusedSec = unfocused;
    saveLocalDay(dayData);
  }
}

// -------- LIVE CLOCK --------

function startClock() {
  clearInterval(clockInterval);
  let tickCount = 0;
  clockInterval = setInterval(() => {
    document.getElementById('clock-current-time').textContent = nowTimeStr();
    const day = getLocalDay();
    if (day && day.checkIn && !day.checkOut) {
      const elapsed = timeDiffSec(day.checkIn, nowTimeStr());
      const breakSec = getDayTotalBreakSec(day);
      const net = Math.max(0, elapsed - breakSec);
      document.getElementById('work-timer').textContent = formatSec(elapsed);
      document.getElementById('break-timer-total').textContent = formatSecShort(breakSec);
      document.getElementById('net-work-timer').textContent = formatSec(net);

      // Update activity UI every 10 seconds
      tickCount++;
      if (tickCount % 10 === 0) updateActivityUI();
    }
  }, 1000);
}

function updateClockUI() {
  const day = getLocalDay();
  const beforeEl = document.getElementById('clock-before-checkin');
  const workingEl = document.getElementById('clock-working');
  const completedEl = document.getElementById('clock-completed');
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const breakBtn = document.getElementById('dash-break-btn');
  const breakText = document.getElementById('break-btn-text');
  const idleBar = document.getElementById('idle-bar');

  document.getElementById('clock-current-time').textContent = nowTimeStr();
  document.getElementById('clock-current-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // Check if yesterday was left open (forgot to clock out)
  checkYesterdayForgotten();

  if (!day || !day.checkIn) {
    beforeEl.style.display = '';
    workingEl.style.display = 'none';
    completedEl.style.display = 'none';
    dot.className = 'status-dot not-checked-in';
    statusText.textContent = 'Not Checked In';
    return;
  }

  if (day.checkOut) {
    beforeEl.style.display = 'none';
    workingEl.style.display = 'none';
    completedEl.style.display = '';
    dot.className = 'status-dot completed';
    statusText.textContent = 'Day Completed';

    const totalSec = timeDiffSec(day.checkIn, day.checkOut);
    const breakSec = getDayTotalBreakSec(day);
    document.getElementById('summary-checkin').textContent = day.checkIn;
    document.getElementById('summary-checkout').textContent = day.checkOut;
    document.getElementById('summary-net').textContent = formatSec(Math.max(0, totalSec - breakSec));
    document.getElementById('summary-breaks').textContent = day.breaks.length + ' (' + formatSecShort(breakSec) + ')';

    const syncEl = document.getElementById('sync-status');
    if (day.lastSyncStatus === 'synced') {
      syncEl.innerHTML = '&#10003; Synced to Google Sheets at ' + day.lastSyncTime;
      syncEl.style.color = 'var(--bamboo-dark)';
    } else if (day.lastSyncStatus === 'error') {
      syncEl.innerHTML = '&#10007; Sync failed: ' + (day.lastSyncError || 'Unknown error');
      syncEl.style.color = 'var(--danger)';
    } else if (day.lastSyncStatus === 'offline') {
      syncEl.innerHTML = '&#9888; Offline — will sync when connected';
      syncEl.style.color = 'var(--gold)';
    } else if (day.lastSyncStatus === 'syncing') {
      syncEl.innerHTML = '&#8987; Syncing to Google Sheets...';
      syncEl.style.color = 'var(--stone)';
    } else {
      syncEl.textContent = '';
    }
    return;
  }

  beforeEl.style.display = 'none';
  workingEl.style.display = '';
  completedEl.style.display = 'none';

  if (day.currentBreak) {
    dot.className = 'status-dot on-break';
    statusText.textContent = day.currentBreak.type === 'auto-idle' ? 'Away (Auto Break)' : 'On Break';
    breakText.textContent = 'End Break';
    breakBtn.className = 'btn btn-success';
    idleBar.style.display = day.currentBreak.type === 'auto-idle' ? '' : 'none';
  } else {
    dot.className = 'status-dot working';
    statusText.textContent = 'Working';
    breakText.textContent = 'Start Break';
    breakBtn.className = 'btn btn-warning';
    idleBar.style.display = 'none';
  }

  renderBreaksLog(day);
}

function renderBreaksLog(day) {
  const section = document.getElementById('today-breaks-section');
  const list = document.getElementById('today-breaks-list');
  const allBreaks = [...day.breaks];
  if (day.currentBreak) allBreaks.push(day.currentBreak);

  if (allBreaks.length === 0) { section.style.display = 'none'; return; }

  section.style.display = '';
  list.innerHTML = allBreaks.map(b => {
    const typeLabel = b.type === 'auto-idle' ? 'Auto (idle)' : (b.type || 'Manual');
    const durText = b.end ? formatSecShort(b.duration || 0) : 'ongoing...';
    return '<div class="break-item">' +
      '<span class="break-type">' + typeLabel + '</span>' +
      '<span class="break-time">' + b.start + ' — ' + (b.end || 'now') + '</span>' +
      '<span class="break-duration">' + durText + '</span>' +
      '</div>';
  }).join('');
}

// -------- ACTIONS (with Mood Check-in) --------

let selectedMood = null;

function doCheckIn() {
  document.getElementById('clock-before-checkin').style.display = 'none';
  document.getElementById('mood-selector').style.display = '';
  selectedMood = null;
  document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
}

function confirmMoodAndCheckIn() {
  if (!selectedMood) { toast('Please select your mood', 'error'); return; }
  const standup = document.getElementById('standup-input').value.trim();

  localCheckIn();
  const day = getLocalDay();
  if (day) {
    day.mood = selectedMood;
    day.standup = standup;
    saveLocalDay(day);
  }

  document.getElementById('mood-selector').style.display = 'none';
  updateClockUI();
  updateStreaksAndBadges();

  const shiftStart = 9 * 60 + 30;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin > shiftStart) {
    toast('Checked in — Late by ' + (nowMin - shiftStart) + ' minutes!', 'error');
  } else {
    toast('Checked in! Feeling ' + selectedMood + ' today', 'success');
  }
  syncCheckIn();
  startWellnessMonitor();
}

function doCheckOut() {
  const shiftEnd = 17 * 60 + 30; // 17:30
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < shiftEnd) {
    const earlyBy = shiftEnd - nowMin;
    const earlyH = Math.floor(earlyBy / 60);
    const earlyM = earlyBy % 60;
    if (!confirm('You are leaving ' + (earlyH > 0 ? earlyH + 'h ' : '') + earlyM + 'm early. Clock out anyway?')) return;
  } else {
    if (!confirm('Clock out for today?')) return;
  }

  const day = localCheckOut();
  updateClockUI();
  if (day) {
    const totalSec = timeDiffSec(day.checkIn, day.checkOut);
    const breakSec = getDayTotalBreakSec(day);
    const netMin = Math.round((totalSec - breakSec) / 60);
    const h = Math.floor(netMin / 60);
    const m = netMin % 60;
    toast('Clocked out! Net work: ' + h + 'h ' + m + 'm', 'success');
  }
  syncCheckOut();
}

function doBreakToggle() {
  const day = getLocalDay();
  if (!day || day.checkOut) return;

  if (day.currentBreak) {
    localEndBreak();
    toast('Break ended', 'success');
    syncBreakEnd();
  } else {
    localStartBreak('manual');
    toast('Break started', 'info');
    syncBreakStart('manual');
  }
  updateClockUI();
}

// -------- SYNC TO GOOGLE SHEETS (background, non-blocking) --------

function bgSync(action, params) {
  if (!API_URL) return;
  const clean = {};
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') clean[k] = v; });
  const query = new URLSearchParams({ action, ...clean }).toString();

  const day = getLocalDay();
  if (day) { day.lastSyncStatus = 'syncing'; saveLocalDay(day); }

  fetch(API_URL + '?' + query)
    .then(r => r.text())
    .then(t => {
      try {
        const d = JSON.parse(t);
        const day2 = getLocalDay();
        if (!d.success) {
          console.warn('Sync [' + action + ']:', d.error);
          if (day2) { day2.lastSyncStatus = 'error'; day2.lastSyncError = d.error; saveLocalDay(day2); }
        } else {
          console.log('Sync [' + action + '] OK');
          if (day2) { day2.lastSyncStatus = 'synced'; day2.lastSyncTime = nowTimeStr(); saveLocalDay(day2); }
        }
      } catch {
        console.warn('Sync [' + action + '] bad response');
        const day2 = getLocalDay();
        if (day2) { day2.lastSyncStatus = 'error'; saveLocalDay(day2); }
      }
      updateSyncIndicator();
    })
    .catch(e => {
      console.warn('Sync [' + action + '] failed:', e.message);
      const day2 = getLocalDay();
      if (day2) { day2.lastSyncStatus = 'offline'; saveLocalDay(day2); }
      updateSyncIndicator();
    });
}

function updateSyncIndicator() {
  const day = getLocalDay();
  const dot = document.getElementById('status-dot');
  if (!day || !dot) return;
  // If sync failed, we don't change the working status dot — data is still safe locally
}

function syncCheckIn() {
  // Use syncDaySummary which creates-or-updates (no "already checked in" error)
  const day = getLocalDay();
  if (!day) return;
  bgSync('syncDaySummary', {
    employeeId: currentUser.ID,
    employeeName: currentUser.Name,
    checkIn: day.checkIn,
    mood: day.mood || '',
    standup: day.standup || ''
  });
}

function syncCheckOut() {
  const day = getLocalDay();
  if (!day) return;

  const totalSec = timeDiffSec(day.checkIn, day.checkOut);
  const breakSec = getDayTotalBreakSec(day);
  const totalMin = Math.round(totalSec / 60);
  const breakMin = Math.round(breakSec / 60);
  const netMin = Math.max(0, totalMin - breakMin);

  bgSync('syncDaySummary', {
    employeeId: currentUser.ID,
    employeeName: currentUser.Name,
    checkIn: day.checkIn,
    checkOut: day.checkOut,
    totalMinutes: totalMin,
    breakMinutes: breakMin,
    netMinutes: netMin,
    breakCount: day.breaks.length,
    breakDetails: day.breaks.map(b => b.type + ':' + b.start + '-' + (b.end || 'ongoing') + '(' + Math.round((b.duration||0)/60) + 'm)').join('; '),
    activityScore: day.activityScore || 0,
    focusPercent: day.focusPercent || 0,
    avgEventsPerMin: day.avgEventsPerMin || 0
  });

  // Also sync tasks
  (day.tasks || []).forEach(t => {
    bgSync('addTask', {
      employeeId: currentUser.ID,
      employeeName: currentUser.Name,
      task: t.text,
      status: t.status,
      time: t.time
    });
  });
}

function syncBreakStart(type) {
  bgSync('startBreak', {
    employeeId: currentUser.ID,
    breakType: type || 'manual'
  });
}

function syncBreakEnd() {
  bgSync('endBreak', { employeeId: currentUser.ID });
}

// Periodic sync — every 5 min push current state to sheets (if working)
setInterval(() => {
  const day = getLocalDay();
  if (!day || !day.checkIn || day.checkOut || !currentUser) return;

  const totalSec = timeDiffSec(day.checkIn, nowTimeStr());
  const breakSec = getDayTotalBreakSec(day);
  const totalMin = Math.round(totalSec / 60);
  const breakMin = Math.round(breakSec / 60);

  bgSync('syncDaySummary', {
    employeeId: currentUser.ID,
    employeeName: currentUser.Name,
    checkIn: day.checkIn,
    totalMinutes: totalMin,
    breakMinutes: breakMin,
    netMinutes: Math.max(0, totalMin - breakMin)
  });
}, 5 * 60 * 1000);

// -------- API (for pages that need server data) --------

async function api(action, params = {}) {
  if (!API_URL) throw new Error('API_URL not configured');

  const query = new URLSearchParams(
    Object.fromEntries(Object.entries({ action, ...params }).filter(([, v]) => v != null && v !== ''))
  ).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(API_URL + '?' + query, { signal: controller.signal });
  clearTimeout(timeout);

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    console.error('Invalid response for ' + action + ':', text.substring(0, 300));
    throw new Error('Invalid server response');
  }
  if (!data.success) throw new Error(data.error || 'Server error');
  return data.data;
}

// -------- TOAST --------

function toast(message, type) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
}

// -------- SESSION --------

function saveSession(user, expiresAt) {
  currentUser = user;
  sessionExpiresAt = expiresAt;
  localStorage.setItem('wp_session', JSON.stringify({ user, expiresAt, loginTime: Date.now() }));
}

function loadSession() {
  try {
    const raw = localStorage.getItem('wp_session');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s.expiresAt || Date.now() > s.expiresAt) { clearSession(); return false; }
    currentUser = s.user;
    sessionExpiresAt = s.expiresAt;
    return true;
  } catch { clearSession(); return false; }
}

function clearSession() {
  currentUser = null;
  sessionExpiresAt = null;
  localStorage.removeItem('wp_session');
}

// -------- OTP AUTH --------

let otpEmail = '';
let otpCountdown = null;

async function handleSendOTP() {
  const email = document.getElementById('login-email').value.trim();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  if (!email) { errorEl.textContent = 'Please enter your email'; return; }

  const btn = document.getElementById('send-otp-btn');
  try {
    btn.disabled = true;
    btn.textContent = 'Sending OTP...';
    await api('sendOTP', { email });
    otpEmail = email;
    document.getElementById('login-step-email').style.display = 'none';
    document.getElementById('login-step-otp').style.display = '';
    document.getElementById('otp-sent-email').textContent = email;
    document.querySelectorAll('.otp-digit').forEach(d => d.value = '');
    document.querySelector('.otp-digit[data-idx="0"]').focus();
    startOTPCountdown();
    toast('OTP sent!', 'success');
  } catch (err) { errorEl.textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = 'Send OTP'; }
}

function startOTPCountdown() {
  let sec = 600;
  const el = document.getElementById('otp-timer');
  clearInterval(otpCountdown);
  otpCountdown = setInterval(() => {
    el.textContent = 'Expires in ' + Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0');
    if (sec-- <= 0) { el.textContent = 'Code expired'; clearInterval(otpCountdown); }
  }, 1000);
}

function getOTPValue() {
  return Array.from(document.querySelectorAll('.otp-digit')).map(d => d.value).join('');
}

async function handleVerifyOTP() {
  const otp = getOTPValue();
  const err = document.getElementById('otp-error');
  err.textContent = '';
  if (otp.length !== 6) { err.textContent = 'Enter all 6 digits'; return; }

  const btn = document.getElementById('verify-otp-btn');
  try {
    btn.disabled = true; btn.textContent = 'Verifying...';
    const result = await api('verifyOTP', { email: otpEmail, otp });
    saveSession(result.employee, result.expiresAt);
    clearInterval(otpCountdown);
    showApp();
    toast('Welcome, ' + result.employee.Name + '!', 'success');
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Verify & Sign In'; }
}

function showEmailStep() {
  document.getElementById('login-step-email').style.display = '';
  document.getElementById('login-step-otp').style.display = 'none';
  clearInterval(otpCountdown);
}

function setupOTPInputs() {
  const digits = document.querySelectorAll('.otp-digit');
  digits.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').charAt(0) || '';
      if (inp.value && i < 5) digits[i+1].focus();
      if (getOTPValue().length === 6) handleVerifyOTP();
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Backspace' && !inp.value && i > 0) digits[i-1].focus(); });
    inp.addEventListener('paste', e => {
      e.preventDefault();
      const p = (e.clipboardData.getData('text')||'').replace(/\D/g,'').slice(0,6);
      p.split('').forEach((c,j) => { if(digits[j]) digits[j].value = c; });
      if (p.length === 6) handleVerifyOTP();
    });
  });
}

// -------- STREAKS & BADGES --------

function getStreak() {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends
    const key = 'wp_day_' + d.toISOString().split('T')[0];
    const data = localStorage.getItem(key);
    if (!data) break;
    const day = JSON.parse(data);
    if (day.checkIn) streak++;
    else break;
  }
  return streak;
}

function getBadges() {
  const streak = getStreak();
  const day = getLocalDay();
  const allDays = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const raw = localStorage.getItem('wp_day_' + d.toISOString().split('T')[0]);
    if (raw) allDays.push(JSON.parse(raw));
  }

  const onTimeDays = allDays.filter(d => {
    if (!d.checkIn) return false;
    const parts = d.checkIn.split(':');
    return (+parts[0] * 60 + +parts[1]) <= 570; // before 09:30
  }).length;

  const longDays = allDays.filter(d => {
    if (!d.checkIn || !d.checkOut) return false;
    return timeDiffSec(d.checkIn, d.checkOut) >= 8 * 3600;
  }).length;

  const focusDays = allDays.filter(d => (d.activityScore || 0) >= 90).length;

  return [
    { icon: '&#127775;', name: 'Early Bird', desc: '5 on-time days', earned: onTimeDays >= 5 },
    { icon: '&#128293;', name: 'Streak 5', desc: '5-day streak', earned: streak >= 5 },
    { icon: '&#9889;', name: 'Streak 10', desc: '10-day streak', earned: streak >= 10 },
    { icon: '&#128170;', name: 'Iron Man', desc: '5 full 8h+ days', earned: longDays >= 5 },
    { icon: '&#127942;', name: 'Perfectionist', desc: '3 days 90%+ focus', earned: focusDays >= 3 },
    { icon: '&#128640;', name: 'Streak 30', desc: '30-day streak', earned: streak >= 30 }
  ];
}

function updateStreaksAndBadges() {
  const streak = getStreak();
  document.getElementById('streak-count').textContent = streak;
  const msgs = [
    'Clock in on time to start!', 'Keep going!', 'Nice streak!',
    'You are on fire!', 'Incredible consistency!', 'Unstoppable!'
  ];
  document.getElementById('streak-msg').textContent = msgs[Math.min(Math.floor(streak / 5), msgs.length - 1)];

  const badges = getBadges();
  document.getElementById('badges-grid').innerHTML = badges.map((b, i) =>
    '<div class="badge-card ' + (b.earned ? 'earned' : 'locked') + '" style="animation-delay:' + (i * .06) + 's">' +
    '<span class="badge-icon">' + b.icon + '</span>' +
    '<span class="badge-name">' + b.name + '</span>' +
    '<span class="badge-desc">' + b.desc + '</span></div>'
  ).join('');
}

// -------- POMODORO FOCUS TIMER --------

let pomoInterval = null;
let pomoSecondsLeft = 25 * 60;
let pomoPhase = 'focus'; // 'focus' or 'break'
let pomoSessions = 0;

function startPomodoro() {
  pomoSecondsLeft = pomoPhase === 'focus' ? 25 * 60 : 5 * 60;
  document.getElementById('pomo-start-btn').style.display = 'none';
  document.getElementById('pomo-stop-btn').style.display = '';
  const ring = document.getElementById('pomo-ring-fill');
  const totalSec = pomoSecondsLeft;
  ring.className.baseVal = 'pomo-ring-fill' + (pomoPhase === 'break' ? ' break-phase' : '');

  pomoInterval = setInterval(() => {
    pomoSecondsLeft--;
    const m = Math.floor(pomoSecondsLeft / 60);
    const s = pomoSecondsLeft % 60;
    document.getElementById('pomo-time').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    document.getElementById('pomo-phase').textContent = pomoPhase === 'focus' ? 'Focus' : 'Break';

    const progress = (totalSec - pomoSecondsLeft) / totalSec;
    ring.style.strokeDashoffset = 283 * (1 - progress);

    if (pomoSecondsLeft <= 0) {
      clearInterval(pomoInterval);
      if (pomoPhase === 'focus') {
        pomoSessions++;
        document.getElementById('pomo-count').textContent = pomoSessions;
        document.getElementById('pomo-deep-work').textContent = (pomoSessions * 25) + 'm';
        const day = getLocalDay();
        if (day) { day.pomodoroSessions = pomoSessions; saveLocalDay(day); }
        toast('Focus session done! Take a 5-min break.', 'success');
        pomoPhase = 'break';
      } else {
        toast('Break over! Ready for another focus session?', 'info');
        pomoPhase = 'focus';
      }
      document.getElementById('pomo-start-btn').style.display = '';
      document.getElementById('pomo-stop-btn').style.display = 'none';
      document.getElementById('pomo-start-btn').textContent = pomoPhase === 'focus' ? 'Start Focus' : 'Start Break';
      ring.style.strokeDashoffset = 0;
    }
  }, 1000);
}

function stopPomodoro() {
  clearInterval(pomoInterval);
  document.getElementById('pomo-start-btn').style.display = '';
  document.getElementById('pomo-stop-btn').style.display = 'none';
  document.getElementById('pomo-time').textContent = '25:00';
  document.getElementById('pomo-ring-fill').style.strokeDashoffset = 0;
  pomoPhase = 'focus';
  document.getElementById('pomo-start-btn').textContent = 'Start Focus';
}

// -------- WELLNESS ALERTS --------

let wellnessInterval = null;
let lastWellnessAlert = 0;

function startWellnessMonitor() {
  clearInterval(wellnessInterval);
  wellnessInterval = setInterval(() => {
    const day = getLocalDay();
    if (!day || !day.checkIn || day.checkOut) return;

    const elapsedMin = Math.round(timeDiffSec(day.checkIn, nowTimeStr()) / 60);
    const breakMin = Math.round(getDayTotalBreakSec(day) / 60);
    const workWithoutBreakMin = elapsedMin - breakMin;
    const lastBreakEnd = day.breaks.length > 0 ? day.breaks[day.breaks.length - 1].end : day.checkIn;
    const sinceLastBreak = lastBreakEnd ? Math.round(timeDiffSec(lastBreakEnd, nowTimeStr()) / 60) : workWithoutBreakMin;

    const now = Date.now();
    if (now - lastWellnessAlert < 30 * 60 * 1000) return; // max 1 alert per 30 min

    if (sinceLastBreak >= 120 && sinceLastBreak < 125) {
      toast('You have been working for 2 hours straight. Take a short break!', 'wellness');
      sendNotification('Break Reminder', 'You have been working 2 hours straight. Time to stretch!');
      showStretchReminder();
      lastWellnessAlert = now;
    } else if (sinceLastBreak >= 240 && sinceLastBreak < 245) {
      toast('4 hours without a break! Your body needs rest.', 'wellness');
      sendNotification('Health Alert', '4 hours without a break! Your body needs rest.');
      showStretchReminder();
      lastWellnessAlert = now;
    } else if (elapsedMin >= 540 && elapsedMin < 545) {
      toast('You have been working 9+ hours today. Consider wrapping up!', 'wellness');
      sendNotification('Long Day Alert', '9+ hours today. Consider wrapping up!');
      lastWellnessAlert = now;
    }
  }, 60000);
}

// -------- TEAM LIVE PULSE --------

async function loadTeamPulse() {
  if (!API_URL || currentUser.Role !== 'admin') return;
  try {
    const data = await api('getDashboard', { employeeId: currentUser.ID });
    const emps = await api('getEmployees');
    const att = await api('getAllAttendance', {
      month: String(new Date().getMonth() + 1).padStart(2, '0'),
      year: new Date().getFullYear()
    });

    const today = new Date().toISOString().split('T')[0];
    const todayAtt = att.filter(a => String(a.Date) === today);

    const grid = document.getElementById('pulse-grid');
    grid.innerHTML = emps.map(emp => {
      const rec = todayAtt.find(a => String(a.EmployeeID) === emp.ID);
      let status = 'offline', statusText = 'Not checked in', avatarCls = 'offline';
      if (rec) {
        if (rec.Status === 'completed') { status = 'completed'; statusText = 'Done (' + fmtMin(rec.NetMinutes) + ')'; avatarCls = 'working'; }
        else if (rec.Status === 'checked-in') { status = 'working'; statusText = 'Working since ' + rec.CheckIn; avatarCls = 'working'; }
      }
      return '<div class="pulse-card">' +
        '<div class="pulse-avatar ' + avatarCls + '">' + emp.Name.charAt(0) + '</div>' +
        '<div class="pulse-info"><span class="pulse-name">' + san(emp.Name) + '</span><span class="pulse-status">' + statusText + '</span></div>' +
        '</div>';
    }).join('');
  } catch {
    document.getElementById('pulse-grid').innerHTML = '<div class="empty-state">Could not load team data</div>';
  }
}

// -------- ZEN QUOTES --------

const ZEN_QUOTES = [
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'In the middle of difficulty lies opportunity.', author: 'Albert Einstein' },
  { text: 'The journey of a thousand miles begins with a single step.', author: 'Lao Tzu' },
  { text: 'Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.', author: 'Buddha' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'Fall seven times, stand up eight.', author: 'Japanese Proverb' },
  { text: 'The bamboo that bends is stronger than the oak that resists.', author: 'Japanese Proverb' },
  { text: 'Even dust, if piled up, can become a mountain.', author: 'Japanese Proverb' },
  { text: 'The flower that blooms in adversity is the rarest of all.', author: 'Mulan' },
  { text: 'Be like water — formless, shapeless. You put it in a cup, it becomes the cup.', author: 'Bruce Lee' },
  { text: 'Knowing others is intelligence; knowing yourself is true wisdom.', author: 'Lao Tzu' },
  { text: 'Vision without action is a daydream. Action without vision is a nightmare.', author: 'Japanese Proverb' },
  { text: 'One who chases two rabbits catches neither.', author: 'Japanese Proverb' },
  { text: 'The mind is everything. What you think, you become.', author: 'Buddha' },
  { text: 'A smooth sea never made a skilled sailor.', author: 'Franklin Roosevelt' },
  { text: 'Wabi-sabi: find beauty in imperfection.', author: 'Japanese Philosophy' },
  { text: 'The best time to plant a tree was 20 years ago. The second best time is now.', author: 'Chinese Proverb' },
  { text: 'Not all those who wander are lost.', author: 'J.R.R. Tolkien' },
  { text: 'If you want to go fast, go alone. If you want to go far, go together.', author: 'African Proverb' },
  { text: 'Nana korobi ya oki — Fall down seven times, get up eight.', author: 'Japanese Proverb' }
];

function showDailyQuote() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,0)) / 86400000);
  const q = ZEN_QUOTES[dayOfYear % ZEN_QUOTES.length];
  document.getElementById('zen-quote-text').textContent = q.text;
  document.getElementById('zen-quote-author').textContent = '— ' + q.author;
}

// -------- AMBIENT FOCUS SOUNDS (Web Audio API — no files needed) --------

let ambientCtx = null;
let ambientNodes = [];
let currentSoundName = null;
let ambientGain = null;

function getAudioCtx() {
  if (!ambientCtx) ambientCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (ambientCtx.state === 'suspended') ambientCtx.resume();
  return ambientCtx;
}

function createNoise(ctx, type) {
  const size = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

function buildSound(name) {
  const ctx = getAudioCtx();
  const nodes = [];
  const master = ctx.createGain();
  master.gain.value = document.getElementById('ambient-volume').value / 100;
  master.connect(ctx.destination);

  if (name === 'rain') {
    const noise = createNoise(ctx);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 800;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000;
    const g = ctx.createGain(); g.gain.value = 0.3;
    noise.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
    noise.start(); nodes.push(noise);

    const drip = createNoise(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 2;
    const dg = ctx.createGain(); dg.gain.value = 0.08;
    drip.connect(bp); bp.connect(dg); dg.connect(master);
    drip.start(); nodes.push(drip);
  }

  else if (name === 'forest') {
    const noise = createNoise(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const g = ctx.createGain(); g.gain.value = 0.15;
    noise.connect(lp); lp.connect(g); g.connect(master);
    noise.start(); nodes.push(noise);

    [800, 1200, 1600].forEach((f, i) => {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = 0;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3 + i * 0.15;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.02;
      lfo.connect(lfoG); lfoG.connect(og.gain);
      osc.connect(og); og.connect(master);
      osc.start(); lfo.start(); nodes.push(osc, lfo);
    });
  }

  else if (name === 'cafe') {
    const noise = createNoise(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0.2;
    noise.connect(bp); bp.connect(g); g.connect(master);
    noise.start(); nodes.push(noise);

    const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 180;
    const hg = ctx.createGain(); hg.gain.value = 0.015;
    hum.connect(hg); hg.connect(master);
    hum.start(); nodes.push(hum);
  }

  else if (name === 'waves') {
    const noise = createNoise(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1000;
    const g = ctx.createGain(); g.gain.value = 0.25;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.2;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    noise.connect(lp); lp.connect(g); g.connect(master);
    noise.start(); lfo.start(); nodes.push(noise, lfo);

    const deep = createNoise(ctx);
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 200;
    const dg = ctx.createGain(); dg.gain.value = 0.1;
    deep.connect(dlp); dlp.connect(dg); dg.connect(master);
    deep.start(); nodes.push(deep);
  }

  else if (name === 'wind') {
    const noise = createNoise(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800; bp.Q.value = 0.3;
    const g = ctx.createGain(); g.gain.value = 0.2;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.15;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    noise.connect(bp); bp.connect(g); g.connect(master);
    noise.start(); lfo.start(); nodes.push(noise, lfo);
  }

  else if (name === 'birds') {
    const noise = createNoise(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
    const bg = ctx.createGain(); bg.gain.value = 0.08;
    noise.connect(lp); lp.connect(bg); bg.connect(master);
    noise.start(); nodes.push(noise);

    [2400, 3200, 4000, 2800].forEach((f, i) => {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = 0;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 2 + i * 1.5;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.025;
      const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.2 + i * 0.1;
      const lfo2G = ctx.createGain(); lfo2G.gain.value = 0.025;
      lfo.connect(lfoG); lfoG.connect(og.gain);
      lfo2.connect(lfo2G); lfo2G.connect(og.gain);
      osc.connect(og); og.connect(master);
      osc.start(); lfo.start(); lfo2.start(); nodes.push(osc, lfo, lfo2);
    });
  }

  return { nodes, master };
}

function playAmbientSound(name) {
  stopAmbientSound();

  if (currentSoundName === name) { currentSoundName = null; return; }

  currentSoundName = name;
  const sound = buildSound(name);
  ambientNodes = sound.nodes;
  ambientGain = sound.master;

  document.getElementById('snd-' + name).classList.add('playing');
  document.getElementById('ambient-controls').style.display = '';
  document.getElementById('ambient-now-playing').textContent = 'Playing: ' + name.charAt(0).toUpperCase() + name.slice(1);
}

function stopAmbientSound() {
  ambientNodes.forEach(n => { try { n.stop(); } catch {} });
  ambientNodes = [];
  if (ambientGain) { try { ambientGain.disconnect(); } catch {} ambientGain = null; }
  currentSoundName = null;
  document.querySelectorAll('.ambient-btn').forEach(b => b.classList.remove('playing'));
  document.getElementById('ambient-controls').style.display = 'none';
}

// -------- KUDOS SYSTEM --------

function getKudos() {
  const raw = localStorage.getItem('wp_kudos');
  return raw ? JSON.parse(raw) : [];
}

function saveKudos(kudos) {
  localStorage.setItem('wp_kudos', JSON.stringify(kudos.slice(-50)));
}

function sendKudos() {
  const toEl = document.getElementById('kudos-to');
  const msgEl = document.getElementById('kudos-msg');
  const to = toEl.value;
  const msg = msgEl.value.trim();
  if (!to || !msg) { toast('Select a teammate and write a message', 'error'); return; }

  const kudos = getKudos();
  kudos.push({
    from: currentUser.Name,
    to: toEl.options[toEl.selectedIndex].text,
    toId: to,
    msg: msg,
    time: nowTimeStr(),
    date: new Date().toISOString().split('T')[0]
  });
  saveKudos(kudos);
  msgEl.value = '';
  renderKudosFeed();
  toast('Kudos sent!', 'success');

  bgSync('addTask', {
    employeeId: currentUser.ID,
    employeeName: currentUser.Name,
    task: 'Kudos to ' + toEl.options[toEl.selectedIndex].text + ': ' + msg,
    status: 'done',
    time: nowTimeStr()
  });
}

function renderKudosFeed() {
  const kudos = getKudos().reverse().slice(0, 10);
  const feed = document.getElementById('kudos-feed');
  if (!kudos.length) {
    feed.innerHTML = '<div class="empty-state" style="padding:16px;font-size:.85rem">No kudos yet. Be the first to appreciate a teammate!</div>';
    return;
  }
  feed.innerHTML = kudos.map(k =>
    '<div class="kudos-item">' +
    '<span class="kudos-star">&#11088;</span>' +
    '<span class="kudos-text"><strong>' + san(k.from) + '</strong> to <strong>' + san(k.to) + '</strong>: ' + san(k.msg) + '</span>' +
    '<span class="kudos-time">' + san(k.date) + '</span>' +
    '</div>'
  ).join('');
}

async function loadKudosTeammates() {
  const select = document.getElementById('kudos-to');
  if (select.options.length > 1) return;
  try {
    const emps = await api('getEmployees');
    emps.filter(e => e.ID !== currentUser.ID).forEach(e => {
      const o = document.createElement('option');
      o.value = e.ID;
      o.textContent = e.Name;
      select.appendChild(o);
    });
  } catch {}
}

// -------- STRETCH REMINDERS --------

const STRETCHES = [
  { icon: '&#129495;', title: 'Neck Roll', steps: '1. Slowly roll your head in a circle\n2. 5 times clockwise\n3. 5 times counter-clockwise\n4. Hold any tight spots for 5 seconds' },
  { icon: '&#128170;', title: 'Shoulder Shrug', steps: '1. Raise both shoulders to your ears\n2. Hold for 5 seconds\n3. Release and relax\n4. Repeat 5 times' },
  { icon: '&#128064;', title: '20-20-20 Eye Rest', steps: '1. Look away from your screen\n2. Focus on something 20 feet away\n3. Hold for 20 seconds\n4. Blink 20 times slowly' },
  { icon: '&#9995;', title: 'Wrist Stretch', steps: '1. Extend your arm, palm up\n2. Gently pull fingers back with other hand\n3. Hold 15 seconds\n4. Switch hands and repeat' },
  { icon: '&#128694;', title: 'Standing Stretch', steps: '1. Stand up from your chair\n2. Reach both arms overhead\n3. Lean gently to each side\n4. Touch your toes (or try!)' },
  { icon: '&#129506;', title: 'Seated Twist', steps: '1. Sit straight in your chair\n2. Place right hand on left knee\n3. Twist gently to the left\n4. Hold 15 seconds, switch sides' },
  { icon: '&#128588;', title: 'Deep Breathing', steps: '1. Breathe in for 4 seconds\n2. Hold for 4 seconds\n3. Breathe out for 6 seconds\n4. Repeat 5 times' }
];

function showStretchReminder() {
  const s = STRETCHES[Math.floor(Math.random() * STRETCHES.length)];
  document.getElementById('stretch-icon').innerHTML = s.icon;
  document.getElementById('stretch-title').textContent = s.title;
  document.getElementById('stretch-exercise').innerHTML = s.steps.split('\n').map(l => '<p>' + l + '</p>').join('');
  document.getElementById('stretch-modal').style.display = '';
}

function closeStretchModal() {
  document.getElementById('stretch-modal').style.display = 'none';
}

// -------- LOGOUT --------

function logout() {
  clearSession();
  clearInterval(clockInterval);
  clearInterval(idleCheckInterval);
  clearInterval(otpCountdown);
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  showEmailStep();
}

// -------- SHOW APP --------

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  document.getElementById('user-name').textContent = currentUser.Name;
  document.getElementById('user-role').textContent = currentUser.Role;
  document.getElementById('user-role').className = 'badge badge-' + currentUser.Role;
  document.getElementById('user-avatar').textContent = currentUser.Name.charAt(0).toUpperCase();

  const isAdmin = currentUser.Role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = isAdmin ? '' : 'none'; });

  startClock();
  initIdleDetection();
  requestNotificationPermission();
  startCheckInReminder();
  navigateTo('dashboard');
}

// -------- NAVIGATION --------

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  const navEl = document.querySelector('[data-page="' + page + '"]');
  if (pageEl) pageEl.classList.add('active');
  if (navEl) navEl.classList.add('active');
  closeSidebar();

  if (page === 'dashboard') {
    updateClockUI();
    updateStreaksAndBadges();
    loadDashboardStats();
    loadTeamPulse();
    showDailyQuote();
    renderKudosFeed();
    loadKudosTeammates();
    const day = getLocalDay();
    const isWorking = day && day.checkIn && !day.checkOut;
    document.getElementById('pomodoro-section').style.display = isWorking ? '' : 'none';
    document.getElementById('ambient-section').style.display = isWorking ? '' : 'none';
    if (isWorking) startWellnessMonitor();
  }
  else if (page === 'attendance') loadAttendance();
  else if (page === 'leaves') loadLeaves();
  else if (page === 'reports') loadReports();
  else if (page === 'employees') loadEmployees();
}

// -------- DASHBOARD STATS (from server) --------

async function loadDashboardStats() {
  if (!API_URL) return;
  try {
    const data = await api('getDashboard', { employeeId: currentUser.ID });
    document.getElementById('dash-month-hours').textContent = (data.myMonthly?.totalHours || 0) + ' hrs';
    document.getElementById('dash-days-worked').textContent = data.myMonthly?.daysWorked || 0;
    document.getElementById('dash-team-today').textContent = data.teamToday?.total || 0;
  } catch { /* stats are nice-to-have, clock works without them */ }
}

// -------- TASK TRACKER (synced to Google Sheets) --------

function addTask() {
  const input = document.getElementById('task-input');
  const status = document.getElementById('task-status-input').value;
  const text = input.value.trim();
  if (!text) return;

  const day = getLocalDay();
  if (!day) { toast('Clock in first to add tasks', 'error'); return; }

  if (!day.tasks) day.tasks = [];
  day.tasks.push({ id: Date.now(), text: text, status: status, time: nowTimeStr() });
  saveLocalDay(day);
  input.value = '';
  renderMyTasks();

  bgSync('addTask', {
    employeeId: currentUser.ID,
    employeeName: currentUser.Name,
    task: text,
    status: status,
    time: nowTimeStr()
  });
}

function deleteTask(taskId) {
  const day = getLocalDay();
  if (!day || !day.tasks) return;
  day.tasks = day.tasks.filter(t => t.id !== taskId);
  saveLocalDay(day);
  renderMyTasks();
}

function renderMyTasks() {
  const day = getLocalDay();
  const tasks = (day && day.tasks) ? day.tasks : [];
  const list = document.getElementById('task-list');
  if (!tasks.length) {
    list.innerHTML = '<div class="empty-state" style="padding:20px">No tasks yet. Log what you are working on!</div>';
    return;
  }
  list.innerHTML = tasks.map(t =>
    '<div class="task-item">' +
    '<span class="task-text">' + san(t.text) + '</span>' +
    '<span class="task-badge ' + t.status + '">' + t.status.replace('-', ' ') + '</span>' +
    '<span class="task-time">' + t.time + '</span>' +
    '<button class="task-delete" onclick="deleteTask(' + t.id + ')" title="Remove">&times;</button>' +
    '</div>'
  ).join('');
}

async function loadTeamTasks() {
  if (!API_URL || currentUser.Role !== 'admin') return;
  const card = document.getElementById('team-tasks-card');
  card.style.display = '';
  try {
    const tasks = await api('getTeamTasks', {});
    const list = document.getElementById('team-tasks-list');
    if (!tasks || !tasks.length) {
      list.innerHTML = '<div class="empty-state" style="padding:16px">No team tasks today yet</div>';
      return;
    }
    list.innerHTML = tasks.map(t =>
      '<div class="task-item">' +
      '<span class="task-text"><strong>' + san(t.EmployeeName) + ':</strong> ' + san(t.Task) + '</span>' +
      '<span class="task-badge ' + (t.Status || 'done') + '">' + san(t.Status || 'done').replace('-', ' ') + '</span>' +
      '<span class="task-time">' + san(t.Time) + '</span>' +
      '</div>'
    ).join('');
  } catch { card.style.display = 'none'; }
}

// -------- ATTENDANCE PAGE (role-based) --------

async function loadAttendance() {
  populateMonthYearSelects('att');
  renderMyTasks();

  const isAdmin = currentUser.Role === 'admin';

  if (isAdmin) {
    document.getElementById('att-employee-filter').style.display = '';
    loadTeamTasks();
    await loadAdminAttendance();
  } else {
    document.getElementById('att-employee-filter').style.display = 'none';
    document.getElementById('team-tasks-card').style.display = 'none';
    renderMyAttendanceHistory();
  }
}

// EMPLOYEE VIEW: own data from localStorage
function renderMyAttendanceHistory() {
  const thead = document.getElementById('att-thead');
  thead.innerHTML = '<tr><th>Date</th><th>Check In</th><th>Check Out</th><th>Net Hours</th><th>Breaks</th><th>Mood</th><th>Tasks</th><th>Status</th></tr>';

  const tbody = document.getElementById('attendance-tbody');
  const summary = document.getElementById('att-summary');
  const selectedMonth = +document.getElementById('att-month').value;
  const selectedYear = +document.getElementById('att-year').value;

  const rows = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    if (d.getMonth() + 1 !== selectedMonth || d.getFullYear() !== selectedYear) continue;
    const raw = localStorage.getItem('wp_day_' + d.toISOString().split('T')[0]);
    if (!raw) continue;
    const day = JSON.parse(raw);
    if (day.checkIn) rows.push({ date: d.toISOString().split('T')[0], ...day });
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No records this month</td></tr>';
    summary.innerHTML = '';
    return;
  }

  const moodMap = { energized: '&#9889;', happy: '&#128522;', neutral: '&#128528;', tired: '&#128564;', stressed: '&#128552;' };

  tbody.innerHTML = rows.map(r => {
    const totalSec = r.checkOut ? timeDiffSec(r.checkIn, r.checkOut) : 0;
    const brkSec = (r.breaks || []).reduce((s, b) => s + (b.duration || 0), 0);
    const netStr = r.checkOut ? formatSec(Math.max(0, totalSec - brkSec)) : '--';
    const tasks = r.tasks || [];
    const taskHtml = tasks.length ? taskCountBadge(tasks) : '--';

    return '<tr><td>' + san(r.date) + '</td><td>' + san(r.checkIn) + '</td><td>' + san(r.checkOut || '--') + '</td>' +
      '<td><strong>' + netStr + '</strong></td><td>' + formatSecShort(brkSec) + '</td>' +
      '<td class="mood-cell">' + (r.mood ? (moodMap[r.mood] || '') : '--') + '</td>' +
      '<td>' + taskHtml + '</td>' +
      '<td><span class="badge badge-' + (r.checkOut ? 'completed' : 'checked-in') + '">' + (r.checkOut ? 'completed' : 'working') + '</span></td></tr>';
  }).join('');

  const comp = rows.filter(r => r.checkOut);
  let netS = 0, brkS = 0;
  comp.forEach(r => { netS += Math.max(0, timeDiffSec(r.checkIn, r.checkOut) - (r.breaks || []).reduce((s, b) => s + (b.duration || 0), 0)); brkS += (r.breaks || []).reduce((s, b) => s + (b.duration || 0), 0); });
  const netM = Math.round(netS / 60), brkM = Math.round(brkS / 60), totalT = rows.reduce((s, r) => s + (r.tasks || []).length, 0), doneT = rows.reduce((s, r) => s + (r.tasks || []).filter(t => t.status === 'done').length, 0);
  summary.innerHTML =
    '<div class="summary-item"><span class="summary-label">Days</span><span class="summary-value">' + comp.length + '</span></div>' +
    '<div class="summary-item"><span class="summary-label">Net Work</span><span class="summary-value">' + fmtMin(netM) + '</span></div>' +
    '<div class="summary-item"><span class="summary-label">Breaks</span><span class="summary-value">' + fmtMin(brkM) + '</span></div>' +
    '<div class="summary-item"><span class="summary-label">Tasks</span><span class="summary-value">' + doneT + '/' + totalT + ' done</span></div>';
}

// ADMIN VIEW: all employees from Google Sheets
async function loadAdminAttendance() {
  const thead = document.getElementById('att-thead');
  thead.innerHTML = '<tr><th>Employee</th><th>Dept</th><th>Date</th><th>Check In</th><th>Check Out</th><th>Net Hours</th><th>Late?</th><th>Tasks</th><th>Status</th></tr>';

  const tbody = document.getElementById('attendance-tbody');
  const summary = document.getElementById('att-summary');
  const month = document.getElementById('att-month').value;
  const year = document.getElementById('att-year').value;
  const empFilter = document.getElementById('att-employee-filter').value;

  tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Loading team data...</td></tr>';

  try {
    const teamData = await api('getTeamAttendance', { month, year });

    // Populate employee filter dropdown
    const filterEl = document.getElementById('att-employee-filter');
    if (filterEl.options.length <= 1) {
      teamData.forEach(emp => {
        const o = document.createElement('option');
        o.value = emp.employee.id;
        o.textContent = emp.employee.name;
        filterEl.appendChild(o);
      });
    }

    let filtered = teamData;
    if (empFilter && empFilter !== 'all') {
      filtered = teamData.filter(e => e.employee.id === empFilter);
    }

    const allRows = [];
    filtered.forEach(emp => {
      emp.days.forEach(d => {
        allRows.push({ ...d, empName: emp.employee.name, empDept: emp.employee.department });
      });
    });

    allRows.sort((a, b) => b.date > a.date ? 1 : -1);

    if (!allRows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No records for this period</td></tr>';
      summary.innerHTML = '';
      return;
    }

    tbody.innerHTML = allRows.map(r => {
      const netStr = r.netMinutes ? fmtMin(r.netMinutes) : '--';
      const lateHtml = r.isLate ? '<span class="badge badge-pending">Late</span>' : '<span class="badge badge-approved">On time</span>';
      const tasks = r.tasks || [];
      let taskHtml = '--';
      if (tasks.length) {
        taskHtml = tasks.map(t => '<span title="' + san(t.time) + '">' + san(t.task) + ' <span class="task-badge ' + (t.status || 'done') + '" style="font-size:.65rem">' + san(t.status || 'done') + '</span></span>').join(', ');
      }

      return '<tr><td><strong>' + san(r.empName) + '</strong></td><td>' + san(r.empDept) + '</td>' +
        '<td>' + san(r.date) + '</td><td>' + san(r.checkIn || '--') + '</td><td>' + san(r.checkOut || '--') + '</td>' +
        '<td>' + netStr + '</td><td>' + lateHtml + '</td><td style="max-width:250px;font-size:.82rem">' + taskHtml + '</td>' +
        '<td><span class="badge badge-' + (r.status || 'checked-in') + '">' + san(r.status || '--') + '</span></td></tr>';
    }).join('');

    // Summary
    let totalDays = 0, totalNet = 0, totalTasks = 0, lateDays = 0;
    filtered.forEach(e => {
      totalDays += e.summary.daysPresent;
      totalNet += e.summary.totalWorkMin;
      totalTasks += e.summary.totalTasks;
      lateDays += e.summary.lateDays;
    });

    summary.innerHTML =
      '<div class="summary-item"><span class="summary-label">Employees</span><span class="summary-value">' + filtered.length + '</span></div>' +
      '<div class="summary-item"><span class="summary-label">Total Days</span><span class="summary-value">' + totalDays + '</span></div>' +
      '<div class="summary-item"><span class="summary-label">Total Hours</span><span class="summary-value">' + fmtMin(totalNet) + '</span></div>' +
      '<div class="summary-item"><span class="summary-label">Late Days</span><span class="summary-value" style="color:var(--danger)">' + lateDays + '</span></div>' +
      '<div class="summary-item"><span class="summary-label">Tasks Logged</span><span class="summary-value">' + totalTasks + '</span></div>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Could not load team data. Showing your local records.</td></tr>';
    renderMyAttendanceHistory();
  }
}

function taskCountBadge(tasks) {
  const done = tasks.filter(t => t.status === 'done').length;
  const wip = tasks.filter(t => t.status === 'in-progress').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  return '<span class="task-count-badge">' +
    (done ? '<span class="t-done">' + done + ' done</span> ' : '') +
    (wip ? '<span class="t-wip">' + wip + ' wip</span> ' : '') +
    (blocked ? '<span class="t-blocked">' + blocked + ' blocked</span>' : '') +
    '</span>';
}

// -------- LEAVES --------

async function loadLeaves() {
  if (!API_URL) return;
  try {
    const leaves = await api('getLeaves', { employeeId: currentUser.ID });
    renderLeavesTable(leaves);
    if (currentUser.Role === 'admin') {
      const pending = await api('getAllLeaves', { status: 'pending' });
      renderLeaveRequests(pending);
    }
  } catch { toast('Could not load leaves', 'error'); }
}

function renderLeavesTable(leaves) {
  const tbody = document.getElementById('leaves-tbody');
  if (!leaves || !leaves.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No leave records</td></tr>'; return; }
  tbody.innerHTML = leaves.map(l =>
    '<tr><td>' + san(l.Type) + '</td><td>' + san(l.StartDate) + '</td><td>' + san(l.EndDate) + '</td><td>' + (l.Days||'-') + '</td><td>' + san(l.Reason||'-') + '</td><td><span class="badge badge-' + l.Status + '">' + san(l.Status) + '</span></td></tr>'
  ).join('');
}

function renderLeaveRequests(leaves) {
  const list = document.getElementById('leave-requests-list');
  if (!leaves || !leaves.length) { list.innerHTML = '<div class="empty-state">No pending requests</div>'; return; }
  list.innerHTML = leaves.map(l =>
    '<div class="leave-request-card"><div class="leave-request-info"><h4>' + san(l.EmployeeName) + ' — ' + san(l.Type) + '</h4><p>' + san(l.StartDate) + ' to ' + san(l.EndDate) + ' (' + l.Days + ' days)</p></div><div class="leave-request-actions">' +
    '<button class="btn btn-success btn-sm" onclick="reviewLeave(\'' + san(l.ID) + '\',\'approved\')">Approve</button>' +
    '<button class="btn btn-danger btn-sm" onclick="reviewLeave(\'' + san(l.ID) + '\',\'rejected\')">Reject</button></div></div>'
  ).join('');
}

async function submitLeave() {
  const type = document.getElementById('leave-type').value;
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const reason = document.getElementById('leave-reason').value.trim();
  if (!start || !end) { toast('Select dates', 'error'); return; }
  if (new Date(end) < new Date(start)) { toast('End date must be after start', 'error'); return; }
  try {
    await api('applyLeave', { employeeId: currentUser.ID, employeeName: currentUser.Name, leaveType: type, startDate: start, endDate: end, reason });
    toast('Leave applied! Admin notified.', 'success');
    document.getElementById('leave-form-section').style.display = 'none';
    loadLeaves();
  } catch (e) { toast(e.message, 'error'); }
}

async function reviewLeave(id, status) {
  try {
    await api('reviewLeave', { leaveId: id, status, reviewedBy: currentUser.Name });
    toast('Leave ' + status, 'success');
    loadLeaves();
  } catch (e) { toast(e.message, 'error'); }
}

// -------- REPORTS --------

async function loadReports() {
  populateMonthYearSelects('rpt');
  if (!API_URL) return;
  generateReport();
}

async function generateReport() {
  try {
    const data = await api('getMonthlyReport', {
      month: document.getElementById('rpt-month').value,
      year: document.getElementById('rpt-year').value
    });
    renderReport(data);
  } catch { toast('Could not load report', 'error'); }
}

function renderReport(data) {
  const tbody = document.getElementById('report-tbody');
  const summaryEl = document.getElementById('report-summary');
  if (!data || !data.report || !data.report.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data</td></tr>';
    summaryEl.innerHTML = '';
    return;
  }
  const totalH = data.report.reduce((s,r) => s + r.totalWorkHours, 0);
  const totalD = data.report.reduce((s,r) => s + r.daysPresent, 0);
  const avg = data.report.length ? (totalH / data.report.length).toFixed(1) : 0;

  summaryEl.innerHTML =
    '<div class="stat-card"><div class="stat-icon green"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="stat-info"><span class="stat-label">Total Hours</span><span class="stat-value">' + totalH.toFixed(1) + '</span></div></div>' +
    '<div class="stat-card"><div class="stat-icon orange"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/></svg></div><div class="stat-info"><span class="stat-label">Total Days</span><span class="stat-value">' + totalD + '</span></div></div>' +
    '<div class="stat-card"><div class="stat-icon purple"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><div class="stat-info"><span class="stat-label">Avg Hrs</span><span class="stat-value">' + avg + '</span></div></div>';

  tbody.innerHTML = data.report.map(r =>
    '<tr><td><strong>' + san(r.name) + '</strong></td><td>' + san(r.department) + '</td><td>' + r.daysPresent + '</td><td>' + r.leaveDays + '</td><td>' + r.totalWorkHours + ' hrs</td><td>' + r.avgHoursPerDay + ' hrs</td></tr>'
  ).join('');
  renderChart(data.report);
}

function renderChart(report) {
  const ctx = document.getElementById('report-chart');
  if (reportChart) reportChart.destroy();
  reportChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: report.map(r => r.name),
      datasets: [
        { label: 'Work Hours', data: report.map(r => r.totalWorkHours), backgroundColor: 'rgba(22,163,74,.7)', borderRadius: 6 },
        { label: 'Break Hours', data: report.map(r => r.totalBreakHours), backgroundColor: 'rgba(245,158,11,.7)', borderRadius: 6 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });
}

function exportCSV() {
  const table = document.querySelector('#page-reports .data-table');
  if (!table) return;
  const csv = [];
  table.querySelectorAll('tr').forEach(row => {
    csv.push(Array.from(row.querySelectorAll('th,td')).map(c => '"' + c.textContent.trim().replace(/"/g,'""') + '"').join(','));
  });
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'report-' + document.getElementById('rpt-year').value + '-' + document.getElementById('rpt-month').value + '.csv';
  a.click();
  toast('Exported!', 'success');
}

// -------- EMPLOYEES --------

async function loadEmployees() {
  if (!API_URL) return;
  try {
    const emps = await api('getEmployees');
    const tbody = document.getElementById('employees-tbody');
    tbody.innerHTML = emps.map(e =>
      '<tr><td><code>' + san(e.ID) + '</code></td><td>' + san(e.Name) + '</td><td>' + san(e.Email) + '</td><td>' + san(e.Department) + '</td><td><span class="badge badge-' + e.Role + '">' + san(e.Role) + '</span></td><td><button class="btn btn-danger btn-sm" onclick="removeEmployee(\'' + san(e.ID) + '\')">Remove</button></td></tr>'
    ).join('');
  } catch { toast('Could not load employees', 'error'); }
}

async function submitEmployee() {
  const name = document.getElementById('emp-name').value.trim();
  const email = document.getElementById('emp-email').value.trim();
  if (!name || !email) { toast('Name and email required', 'error'); return; }
  try {
    await api('addEmployee', { name, email, department: document.getElementById('emp-dept').value.trim(), role: document.getElementById('emp-role').value });
    toast('Employee added!', 'success');
    document.getElementById('employee-form-section').style.display = 'none';
    ['emp-name','emp-email','emp-dept'].forEach(id => document.getElementById(id).value = '');
    loadEmployees();
  } catch (e) { toast(e.message, 'error'); }
}

async function removeEmployee(id) {
  if (!confirm('Remove this employee?')) return;
  try { await api('deleteEmployee', { employeeId: id }); toast('Removed', 'success'); loadEmployees(); }
  catch (e) { toast(e.message, 'error'); }
}

// -------- UTILITIES --------

function san(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function fmtMin(m) {
  if (!m || isNaN(m)) return '0h 0m';
  m = +m;
  return Math.floor(m/60) + 'h ' + Math.round(m%60) + 'm';
}

function populateMonthYearSelects(prefix) {
  const mEl = document.getElementById(prefix + '-month');
  const yEl = document.getElementById(prefix + '-year');
  if (mEl.options.length > 0) return;
  ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].forEach((m,i) => {
    const o = document.createElement('option');
    o.value = String(i+1).padStart(2,'0');
    o.textContent = m;
    mEl.appendChild(o);
  });
  const yr = new Date().getFullYear();
  for (let y = yr; y >= yr - 3; y--) { const o = document.createElement('option'); o.value = y; o.textContent = y; yEl.appendChild(o); }
  mEl.value = String(new Date().getMonth()+1).padStart(2,'0');
  yEl.value = yr;
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.add('hidden');
}

// -------- EVENT BINDINGS --------

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('send-otp-btn').addEventListener('click', handleSendOTP);
  document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') handleSendOTP(); });
  document.getElementById('verify-otp-btn').addEventListener('click', handleVerifyOTP);
  document.getElementById('resend-otp-btn').addEventListener('click', handleSendOTP);
  document.getElementById('change-email-btn').addEventListener('click', showEmailStep);
  setupOTPInputs();

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('logout-btn-mobile').addEventListener('click', logout);

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => { e.preventDefault(); navigateTo(item.dataset.page); });
  });

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('hidden');
  });
  document.getElementById('overlay').addEventListener('click', closeSidebar);

  document.getElementById('dash-checkin-btn').addEventListener('click', doCheckIn);
  document.getElementById('dash-checkout-btn').addEventListener('click', doCheckOut);
  document.getElementById('dash-break-btn').addEventListener('click', doBreakToggle);

  // Mood selector
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedMood = btn.dataset.mood;
    });
  });
  document.getElementById('mood-confirm-btn').addEventListener('click', confirmMoodAndCheckIn);

  // Pomodoro
  document.getElementById('pomo-start-btn').addEventListener('click', startPomodoro);
  document.getElementById('pomo-stop-btn').addEventListener('click', stopPomodoro);

  // Ambient sounds
  document.querySelectorAll('.ambient-btn').forEach(btn => {
    btn.addEventListener('click', () => playAmbientSound(btn.dataset.sound));
  });
  document.getElementById('ambient-stop').addEventListener('click', stopAmbientSound);
  document.getElementById('ambient-volume').addEventListener('input', e => {
    if (ambientGain) ambientGain.gain.value = e.target.value / 100;
  });

  // Kudos
  document.getElementById('send-kudos-btn').addEventListener('click', sendKudos);
  document.getElementById('kudos-msg').addEventListener('keydown', e => { if (e.key === 'Enter') sendKudos(); });

  // Stretch modal
  document.getElementById('stretch-close').addEventListener('click', closeStretchModal);
  document.getElementById('stretch-done-btn').addEventListener('click', closeStretchModal);

  document.getElementById('att-filter-btn').addEventListener('click', loadAttendance);
  document.getElementById('att-employee-filter').addEventListener('change', loadAttendance);

  // Task tracker
  document.getElementById('add-task-btn').addEventListener('click', addTask);
  document.getElementById('task-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

  document.getElementById('apply-leave-btn').addEventListener('click', () => { document.getElementById('leave-form-section').style.display = ''; });
  document.getElementById('cancel-leave-btn').addEventListener('click', () => { document.getElementById('leave-form-section').style.display = 'none'; });
  document.getElementById('submit-leave-btn').addEventListener('click', submitLeave);

  document.getElementById('rpt-filter-btn').addEventListener('click', generateReport);
  document.getElementById('rpt-export-btn').addEventListener('click', exportCSV);

  document.getElementById('add-employee-btn').addEventListener('click', () => { document.getElementById('employee-form-section').style.display = ''; });
  document.getElementById('cancel-emp-btn').addEventListener('click', () => { document.getElementById('employee-form-section').style.display = 'none'; });
  document.getElementById('submit-emp-btn').addEventListener('click', submitEmployee);

  if (loadSession()) { showApp(); }
});
