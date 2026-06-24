// ============================================================
// Work Processor & Attendance Tracker — Google Apps Script API
// v2: OTP Auth, Geolocation, Email Notifications
// Deploy as Web App: Execute as "Me", Access "Anyone"
// ============================================================

const SHEETS = {
  EMPLOYEES: 'Employees',
  ATTENDANCE: 'Attendance',
  BREAKS: 'Breaks',
  LEAVES: 'Leaves',
  TASKS: 'Tasks'
};

const OTP_EXPIRY_MINUTES = 10;

// ---------- SHIFT RULES (customize these) ----------
const SHIFT_START = '09:30';  // Late if check-in after this
const SHIFT_END   = '17:30';  // Early if check-out before this
const MIN_WORK_HOURS = 8;     // Minimum expected work hours

// ---------- INITIALIZATION ----------

function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const defs = [
    [SHEETS.EMPLOYEES, ['ID','Name','Email','Department','Role','JoinDate','Active']],
    [SHEETS.ATTENDANCE, ['ID','EmployeeID','EmployeeName','Date','CheckIn','CheckOut','TotalMinutes','NetMinutes','BreakMinutes','Status','BreakCount','BreakDetails','Mood','Standup','ActivityScore','FocusPercent','IsLate','LateMinutes']],
    [SHEETS.BREAKS, ['ID','AttendanceID','EmployeeID','Date','StartTime','EndTime','Type','DurationMinutes']],
    [SHEETS.LEAVES, ['ID','EmployeeID','EmployeeName','StartDate','EndDate','Type','Reason','Status','AppliedOn','ReviewedBy','ReviewedOn','Days']],
    [SHEETS.TASKS, ['ID','EmployeeID','EmployeeName','Date','Task','Status','Time','CreatedAt']]
  ];

  defs.forEach(([name, headers]) => {
    if (!ss.getSheetByName(name)) {
      const s = ss.insertSheet(name);
      s.appendRow(headers);
      s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      s.setFrozenRows(1);
    }
  });

  const empSheet = ss.getSheetByName(SHEETS.EMPLOYEES);
  if (empSheet.getLastRow() < 2) {
    empSheet.appendRow(['EMP001', 'Admin', 'admin@company.com', 'Management', 'admin', todayStr(), 'true']);
  }

  setupDailyTrigger();
}

// ---------- WEB APP ENTRY POINTS ----------

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  return handleRequest({ parameter: body });
}

function handleRequest(e) {
  try {
    const p = e.parameter || {};
    const action = p.action || '';

    const handlers = {
      'sendOTP': () => sendOTP(p.email),
      'verifyOTP': () => verifyOTP(p.email, p.otp),
      'login': () => login(p.email),
      'getEmployees': () => getEmployees(),
      'addEmployee': () => addEmployee(p),
      'updateEmployee': () => updateEmployee(p),
      'deleteEmployee': () => deleteEmployee(p.employeeId),
      'checkIn': () => checkIn(p.employeeId, p.employeeName, p.latitude, p.longitude),
      'checkOut': () => checkOut(p.employeeId, p.latitude, p.longitude),
      'getTodayStatus': () => getTodayStatus(p.employeeId),
      'startBreak': () => startBreak(p.employeeId, p.breakType),
      'endBreak': () => endBreak(p.employeeId),
      'getAttendance': () => getAttendance(p.employeeId, p.month, p.year),
      'getAllAttendance': () => getAllAttendance(p.month, p.year),
      'applyLeave': () => applyLeave(p),
      'getLeaves': () => getLeaves(p.employeeId),
      'getAllLeaves': () => getAllLeaves(p.status),
      'reviewLeave': () => reviewLeave(p.leaveId, p.status, p.reviewedBy),
      'getMonthlyReport': () => getMonthlyReport(p.month, p.year),
      'getEmployeeReport': () => getEmployeeReport(p.employeeId, p.month, p.year),
      'getDashboard': () => getDashboard(p.employeeId),
      'syncDaySummary': () => syncDaySummary(p),
      'getLateEarlyReport': () => getLateEarlyReport(p.month, p.year),
      'addTask': () => addTask(p),
      'getTasks': () => getTasks(p.employeeId, p.date),
      'getTeamTasks': () => getTeamTasks(p.date),
      'getTeamAttendance': () => getTeamAttendance(p.month, p.year),
      'init': () => { initializeSheets(); return { success: true, message: 'Sheets initialized' }; }
    };

    if (!handlers[action]) {
      return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }

    const result = handlers[action]();
    return jsonResponse({ success: true, data: result });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- HELPERS ----------

function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function nowStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss');
}

function generateId(prefix) {
  return prefix + '_' + new Date().getTime() + '_' + Math.random().toString(36).substr(2, 5);
}

function getSheetData(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function appendRow(sheetName, rowData) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName).appendRow(rowData);
}

function updateRow(sheetName, matchCol, matchVal, updates) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = headers.indexOf(matchCol);
  if (colIdx === -1) return false;

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][colIdx]) === String(matchVal)) {
      Object.entries(updates).forEach(([key, val]) => {
        const ki = headers.indexOf(key);
        if (ki !== -1) sheet.getRange(i + 2, ki + 1).setValue(val);
      });
      return true;
    }
  }
  return false;
}

function diffMinutes(start, end) {
  if (!start || !end) return 0;
  const toMin = t => {
    const parts = String(t).split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]) + (parts[2] ? parseInt(parts[2]) / 60 : 0);
  };
  return Math.round(toMin(end) - toMin(start));
}

function countBusinessDays(startDate, endDate) {
  let count = 0;
  const d = new Date(startDate);
  const end = new Date(endDate);
  while (d <= end) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ---------- OTP AUTH ----------

function sendOTP(email) {
  if (!email) throw new Error('Email is required');

  const employees = getSheetData(SHEETS.EMPLOYEES);
  const emp = employees.find(e => String(e.Email).toLowerCase() === email.toLowerCase() && String(e.Active) === 'true');
  if (!emp) throw new Error('Employee not found or inactive');

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiry = new Date().getTime() + OTP_EXPIRY_MINUTES * 60 * 1000;

  const props = PropertiesService.getScriptProperties();
  props.setProperty('otp_' + email.toLowerCase(), JSON.stringify({ otp, expiry }));

  MailApp.sendEmail({
    to: email,
    subject: 'Work Processor — Your Login OTP',
    htmlBody: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#4f46e5;margin-bottom:8px">Work Processor</h2>
        <p>Hi ${emp.Name},</p>
        <p>Your one-time login code is:</p>
        <div style="background:#f3f4f6;border-radius:12px;padding:24px;text-align:center;margin:20px 0">
          <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1f2937">${otp}</span>
        </div>
        <p style="color:#6b7280;font-size:14px">This code expires in ${OTP_EXPIRY_MINUTES} minutes. Do not share it with anyone.</p>
      </div>
    `
  });

  return { message: 'OTP sent to ' + email, expiresIn: OTP_EXPIRY_MINUTES };
}

function verifyOTP(email, otp) {
  if (!email || !otp) throw new Error('Email and OTP are required');

  const props = PropertiesService.getScriptProperties();
  const key = 'otp_' + email.toLowerCase();
  const stored = props.getProperty(key);

  if (!stored) throw new Error('No OTP found. Please request a new one.');

  const { otp: savedOtp, expiry } = JSON.parse(stored);

  if (new Date().getTime() > expiry) {
    props.deleteProperty(key);
    throw new Error('OTP expired. Please request a new one.');
  }

  if (String(otp) !== String(savedOtp)) {
    throw new Error('Invalid OTP. Please try again.');
  }

  props.deleteProperty(key);

  const employees = getSheetData(SHEETS.EMPLOYEES);
  const emp = employees.find(e => String(e.Email).toLowerCase() === email.toLowerCase() && String(e.Active) === 'true');
  if (!emp) throw new Error('Employee not found');

  const sessionToken = Utilities.getUuid();
  const sessionExpiry = new Date().getTime() + 8 * 60 * 60 * 1000;
  props.setProperty('session_' + sessionToken, JSON.stringify({
    employeeId: emp.ID,
    email: email.toLowerCase(),
    expiry: sessionExpiry
  }));

  return { employee: emp, sessionToken, expiresAt: sessionExpiry };
}

function login(email) {
  if (!email) throw new Error('Email is required');
  const employees = getSheetData(SHEETS.EMPLOYEES);
  const emp = employees.find(e => String(e.Email).toLowerCase() === email.toLowerCase() && String(e.Active) === 'true');
  if (!emp) throw new Error('Employee not found or inactive');
  return emp;
}

// ---------- EMPLOYEE MANAGEMENT ----------

function getEmployees() {
  return getSheetData(SHEETS.EMPLOYEES).filter(e => String(e.Active) === 'true');
}

function addEmployee(p) {
  const id = 'EMP' + String(getSheetData(SHEETS.EMPLOYEES).length + 1).padStart(3, '0');
  appendRow(SHEETS.EMPLOYEES, [id, p.name, p.email, p.department, p.role || 'employee', todayStr(), 'true']);
  return { id, message: 'Employee added' };
}

function updateEmployee(p) {
  const updates = {};
  if (p.name) updates.Name = p.name;
  if (p.email) updates.Email = p.email;
  if (p.department) updates.Department = p.department;
  if (p.role) updates.Role = p.role;
  updateRow(SHEETS.EMPLOYEES, 'ID', p.employeeId, updates);
  return { message: 'Employee updated' };
}

function deleteEmployee(employeeId) {
  updateRow(SHEETS.EMPLOYEES, 'ID', employeeId, { Active: 'false' });
  return { message: 'Employee deactivated' };
}

// ---------- ATTENDANCE ----------

function checkIn(employeeId, employeeName, latitude, longitude) {
  if (!employeeId) throw new Error('Employee ID required');
  const today = todayStr();
  const existing = getSheetData(SHEETS.ATTENDANCE).find(
    a => String(a.EmployeeID) === employeeId && String(a.Date) === today
  );
  if (existing && existing.CheckIn && !existing.CheckOut) {
    throw new Error('Already checked in today');
  }
  if (existing && existing.CheckOut) {
    throw new Error('Already completed attendance for today');
  }

  const id = generateId('ATT');
  const now = nowStr();
  appendRow(SHEETS.ATTENDANCE, [
    id, employeeId, employeeName || '', today, now, '', 0, 0, 0, 'checked-in',
    latitude || '', longitude || '', '', ''
  ]);

  if (isLateCheckIn(now)) {
    notifyLateArrival(employeeName || employeeId, '', now, getLateMinutes(now));
  }

  return { id, checkIn: now, isLate: isLateCheckIn(now), lateBy: getLateMinutes(now), message: 'Checked in successfully' };
}

function checkOut(employeeId, latitude, longitude) {
  if (!employeeId) throw new Error('Employee ID required');
  const today = todayStr();
  const records = getSheetData(SHEETS.ATTENDANCE);
  const record = records.find(
    a => String(a.EmployeeID) === employeeId && String(a.Date) === today && a.Status === 'checked-in'
  );
  if (!record) throw new Error('No active check-in found for today');

  const activeBreak = getSheetData(SHEETS.BREAKS).find(
    b => String(b.EmployeeID) === employeeId && String(b.Date) === today && !b.EndTime
  );
  if (activeBreak) {
    endBreak(employeeId);
  }

  const now = nowStr();
  const totalMin = diffMinutes(record.CheckIn, now);

  const breaks = getSheetData(SHEETS.BREAKS).filter(
    b => String(b.AttendanceID) === record.ID
  );
  const breakMin = breaks.reduce((sum, b) => sum + (Number(b.DurationMinutes) || 0), 0);
  const netMin = totalMin - breakMin;

  const updates = {
    CheckOut: now,
    TotalMinutes: totalMin,
    NetMinutes: netMin,
    BreakMinutes: breakMin,
    Status: 'completed'
  };
  if (latitude) updates.CheckOutLat = latitude;
  if (longitude) updates.CheckOutLng = longitude;

  updateRow(SHEETS.ATTENDANCE, 'ID', record.ID, updates);

  return {
    checkOut: now,
    totalMinutes: totalMin,
    breakMinutes: breakMin,
    netMinutes: netMin,
    message: 'Checked out successfully'
  };
}

function getTodayStatus(employeeId) {
  const today = todayStr();
  const record = getSheetData(SHEETS.ATTENDANCE).find(
    a => String(a.EmployeeID) === employeeId && String(a.Date) === today
  );
  const activeBreak = getSheetData(SHEETS.BREAKS).find(
    b => String(b.EmployeeID) === employeeId && String(b.Date) === today && !b.EndTime
  );
  const todayBreaks = getSheetData(SHEETS.BREAKS).filter(
    b => String(b.EmployeeID) === employeeId && String(b.Date) === today
  );
  return {
    attendance: record || null,
    activeBreak: activeBreak || null,
    breaks: todayBreaks,
    isCheckedIn: record ? record.Status === 'checked-in' : false,
    isOnBreak: !!activeBreak
  };
}

// ---------- BREAKS ----------

function startBreak(employeeId, breakType) {
  const today = todayStr();
  const attendance = getSheetData(SHEETS.ATTENDANCE).find(
    a => String(a.EmployeeID) === employeeId && String(a.Date) === today && a.Status === 'checked-in'
  );
  if (!attendance) throw new Error('Must be checked in to start a break');

  const activeBreak = getSheetData(SHEETS.BREAKS).find(
    b => String(b.EmployeeID) === employeeId && String(b.Date) === today && !b.EndTime
  );
  if (activeBreak) throw new Error('Already on a break');

  const id = generateId('BRK');
  appendRow(SHEETS.BREAKS, [id, attendance.ID, employeeId, today, nowStr(), '', breakType || 'general', 0]);
  return { id, startTime: nowStr(), message: 'Break started' };
}

function endBreak(employeeId) {
  const today = todayStr();
  const activeBreak = getSheetData(SHEETS.BREAKS).find(
    b => String(b.EmployeeID) === employeeId && String(b.Date) === today && !b.EndTime
  );
  if (!activeBreak) throw new Error('No active break found');

  const now = nowStr();
  const duration = diffMinutes(activeBreak.StartTime, now);
  updateRow(SHEETS.BREAKS, 'ID', activeBreak.ID, { EndTime: now, DurationMinutes: duration });
  return { endTime: now, duration, message: 'Break ended' };
}

// ---------- ATTENDANCE QUERIES ----------

function getAttendance(employeeId, month, year) {
  const records = getSheetData(SHEETS.ATTENDANCE).filter(a => {
    if (String(a.EmployeeID) !== employeeId) return false;
    if (month && year) {
      const d = String(a.Date).split('-');
      return d[0] === String(year) && d[1] === String(month).padStart(2, '0');
    }
    return true;
  });

  const breaks = getSheetData(SHEETS.BREAKS).filter(b => String(b.EmployeeID) === employeeId);

  return records.map(r => ({
    ...r,
    breaks: breaks.filter(b => String(b.AttendanceID) === String(r.ID))
  }));
}

function getAllAttendance(month, year) {
  const records = getSheetData(SHEETS.ATTENDANCE).filter(a => {
    if (month && year) {
      const d = String(a.Date).split('-');
      return d[0] === String(year) && d[1] === String(month).padStart(2, '0');
    }
    return true;
  });
  return records;
}

// ---------- LEAVE MANAGEMENT ----------

function applyLeave(p) {
  const id = generateId('LV');
  const days = countBusinessDays(p.startDate, p.endDate);
  appendRow(SHEETS.LEAVES, [
    id, p.employeeId, p.employeeName || '', p.startDate, p.endDate,
    p.leaveType, p.reason, 'pending', todayStr(), '', '', days
  ]);

  notifyAdminsLeaveApplied(p.employeeName || p.employeeId, p.leaveType, p.startDate, p.endDate, days, p.reason);

  return { id, days, message: 'Leave applied' };
}

function getLeaves(employeeId) {
  return getSheetData(SHEETS.LEAVES).filter(l => String(l.EmployeeID) === employeeId);
}

function getAllLeaves(status) {
  const leaves = getSheetData(SHEETS.LEAVES);
  if (status && status !== 'all') return leaves.filter(l => l.Status === status);
  return leaves;
}

function reviewLeave(leaveId, status, reviewedBy) {
  updateRow(SHEETS.LEAVES, 'ID', leaveId, {
    Status: status,
    ReviewedBy: reviewedBy,
    ReviewedOn: todayStr()
  });

  const leave = getSheetData(SHEETS.LEAVES).find(l => String(l.ID) === leaveId);
  if (leave) {
    notifyEmployeeLeaveReviewed(leave, status, reviewedBy);
  }

  return { message: 'Leave ' + status };
}

// ---------- EMAIL NOTIFICATIONS ----------

function getAdminEmails() {
  return getSheetData(SHEETS.EMPLOYEES)
    .filter(e => e.Role === 'admin' && String(e.Active) === 'true')
    .map(e => e.Email);
}

function notifyAdminsLeaveApplied(empName, leaveType, startDate, endDate, days, reason) {
  try {
    const admins = getAdminEmails();
    if (admins.length === 0) return;

    MailApp.sendEmail({
      to: admins.join(','),
      subject: `Leave Request — ${empName} (${leaveType})`,
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#4f46e5">New Leave Request</h2>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px 0;color:#6b7280;width:120px">Employee</td><td style="padding:8px 0;font-weight:600">${empName}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Type</td><td style="padding:8px 0">${leaveType}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Dates</td><td style="padding:8px 0">${startDate} to ${endDate} (${days} days)</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Reason</td><td style="padding:8px 0">${reason || 'Not specified'}</td></tr>
          </table>
          <p style="color:#6b7280;font-size:14px">Log in to Work Processor to approve or reject this request.</p>
        </div>
      `
    });
  } catch (e) {
    console.log('Email notification failed: ' + e.message);
  }
}

function notifyEmployeeLeaveReviewed(leave, status, reviewedBy) {
  try {
    const emp = getSheetData(SHEETS.EMPLOYEES).find(e => String(e.ID) === String(leave.EmployeeID));
    if (!emp) return;

    const color = status === 'approved' ? '#22c55e' : '#ef4444';
    const icon = status === 'approved' ? '&#10003;' : '&#10007;';

    MailApp.sendEmail({
      to: emp.Email,
      subject: `Leave ${status.charAt(0).toUpperCase() + status.slice(1)} — ${leave.StartDate} to ${leave.EndDate}`,
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#4f46e5">Leave Update</h2>
          <div style="background:${status === 'approved' ? '#f0fdf4' : '#fef2f2'};border-radius:12px;padding:20px;text-align:center;margin:16px 0">
            <span style="font-size:32px;color:${color}">${icon}</span>
            <p style="font-size:18px;font-weight:600;color:${color};margin:8px 0">Leave ${status.toUpperCase()}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px 0;color:#6b7280;width:120px">Type</td><td style="padding:8px 0">${leave.Type}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Dates</td><td style="padding:8px 0">${leave.StartDate} to ${leave.EndDate}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Reviewed by</td><td style="padding:8px 0">${reviewedBy}</td></tr>
          </table>
        </div>
      `
    });
  } catch (e) {
    console.log('Email notification failed: ' + e.message);
  }
}

// ---------- DAILY SUMMARY TRIGGER ----------

function setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(t => t.getHandlerFunction() === 'sendDailySummary');
  if (!exists) {
    ScriptApp.newTrigger('sendDailySummary')
      .timeBased()
      .atHour(18)
      .everyDays(1)
      .create();
  }
}

function sendDailySummary() {
  try {
    const admins = getAdminEmails();
    if (admins.length === 0) return;

    const today = todayStr();
    const attendance = getSheetData(SHEETS.ATTENDANCE).filter(a => String(a.Date) === today);
    const employees = getEmployees();

    const checkedIn = attendance.filter(a => a.Status === 'checked-in');
    const completed = attendance.filter(a => a.Status === 'completed');
    const absent = employees.filter(emp =>
      !attendance.some(a => String(a.EmployeeID) === emp.ID)
    );

    const pendingLeaves = getSheetData(SHEETS.LEAVES).filter(l => l.Status === 'pending').length;

    let absentList = absent.map(a => `<li>${a.Name} (${a.Department})</li>`).join('');
    if (!absentList) absentList = '<li>None</li>';

    let stillWorkingList = checkedIn.map(a => `<li>${a.EmployeeName}</li>`).join('');
    if (!stillWorkingList) stillWorkingList = '<li>None</li>';

    MailApp.sendEmail({
      to: admins.join(','),
      subject: `Daily Attendance Summary — ${today}`,
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#4f46e5">Daily Summary — ${today}</h2>
          <div style="display:flex;gap:16px;margin:20px 0">
            <div style="background:#f0fdf4;border-radius:12px;padding:16px;flex:1;text-align:center">
              <div style="font-size:28px;font-weight:bold;color:#22c55e">${completed.length}</div>
              <div style="color:#6b7280;font-size:13px">Completed</div>
            </div>
            <div style="background:#fffbeb;border-radius:12px;padding:16px;flex:1;text-align:center">
              <div style="font-size:28px;font-weight:bold;color:#f59e0b">${checkedIn.length}</div>
              <div style="color:#6b7280;font-size:13px">Still Working</div>
            </div>
            <div style="background:#fef2f2;border-radius:12px;padding:16px;flex:1;text-align:center">
              <div style="font-size:28px;font-weight:bold;color:#ef4444">${absent.length}</div>
              <div style="color:#6b7280;font-size:13px">Absent</div>
            </div>
          </div>
          <h3 style="margin-top:24px">Absent Today</h3>
          <ul>${absentList}</ul>
          <h3 style="margin-top:16px">Still Checked In</h3>
          <ul>${stillWorkingList}</ul>
          <p style="color:#6b7280;font-size:13px;margin-top:20px">Pending leave requests: ${pendingLeaves}</p>
        </div>
      `
    });
  } catch (e) {
    console.log('Daily summary failed: ' + e.message);
  }
}

// ---------- LATE / EARLY DETECTION ----------

function timeToMinutes(t) {
  if (!t) return 0;
  const parts = String(t).split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function isLateCheckIn(checkInTime) {
  return timeToMinutes(checkInTime) > timeToMinutes(SHIFT_START);
}

function isEarlyCheckOut(checkOutTime) {
  return timeToMinutes(checkOutTime) < timeToMinutes(SHIFT_END);
}

function getLateMinutes(checkInTime) {
  return Math.max(0, timeToMinutes(checkInTime) - timeToMinutes(SHIFT_START));
}

function getEarlyMinutes(checkOutTime) {
  return Math.max(0, timeToMinutes(SHIFT_END) - timeToMinutes(checkOutTime));
}

function notifyLateArrival(empName, empEmail, checkInTime, lateBy) {
  try {
    const admins = getAdminEmails();
    if (admins.length === 0) return;

    const h = Math.floor(lateBy / 60);
    const m = lateBy % 60;
    const lateStr = h > 0 ? h + 'h ' + m + 'm' : m + ' minutes';

    MailApp.sendEmail({
      to: admins.join(','),
      subject: '⚠ Late Arrival — ' + empName + ' (' + lateStr + ' late)',
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
        '<h2 style="color:#f59e0b">Late Arrival Alert</h2>' +
        '<div style="background:#fffbeb;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #f59e0b">' +
        '<p style="margin:0"><strong>' + empName + '</strong> checked in at <strong>' + checkInTime + '</strong></p>' +
        '<p style="margin:4px 0 0;color:#92400e">Late by <strong>' + lateStr + '</strong> (shift starts at ' + SHIFT_START + ')</p>' +
        '</div>' +
        '<p style="color:#6b7280;font-size:13px">Date: ' + todayStr() + '</p>' +
        '</div>'
    });
  } catch (e) {
    console.log('Late notification failed: ' + e.message);
  }
}

function notifyEarlyDeparture(empName, empEmail, checkOutTime, earlyBy) {
  try {
    const admins = getAdminEmails();
    if (admins.length === 0) return;

    const h = Math.floor(earlyBy / 60);
    const m = earlyBy % 60;
    const earlyStr = h > 0 ? h + 'h ' + m + 'm' : m + ' minutes';

    MailApp.sendEmail({
      to: admins.join(','),
      subject: '⚠ Early Departure — ' + empName + ' (' + earlyStr + ' early)',
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
        '<h2 style="color:#ef4444">Early Departure Alert</h2>' +
        '<div style="background:#fef2f2;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #ef4444">' +
        '<p style="margin:0"><strong>' + empName + '</strong> checked out at <strong>' + checkOutTime + '</strong></p>' +
        '<p style="margin:4px 0 0;color:#991b1b">Left <strong>' + earlyStr + '</strong> early (shift ends at ' + SHIFT_END + ')</p>' +
        '</div>' +
        '<p style="color:#6b7280;font-size:13px">Date: ' + todayStr() + '</p>' +
        '</div>'
    });
  } catch (e) {
    console.log('Early departure notification failed: ' + e.message);
  }
}

function getLateEarlyReport(month, year) {
  const attendance = getAllAttendance(month, year);
  const employees = getEmployees();

  const report = employees.map(emp => {
    const empAtt = attendance.filter(a => String(a.EmployeeID) === emp.ID && a.Status === 'completed');
    const lateDays = empAtt.filter(a => isLateCheckIn(a.CheckIn));
    const earlyDays = empAtt.filter(a => isEarlyCheckOut(a.CheckOut));
    const totalLateMins = lateDays.reduce((s, a) => s + getLateMinutes(a.CheckIn), 0);
    const totalEarlyMins = earlyDays.reduce((s, a) => s + getEarlyMinutes(a.CheckOut), 0);

    return {
      employeeId: emp.ID,
      name: emp.Name,
      department: emp.Department,
      totalDays: empAtt.length,
      lateDays: lateDays.length,
      earlyDays: earlyDays.length,
      totalLateMinutes: totalLateMins,
      totalEarlyMinutes: totalEarlyMins,
      punctualityScore: empAtt.length > 0 ?
        Math.round((1 - (lateDays.length + earlyDays.length) / (empAtt.length * 2)) * 100) : 100
    };
  });

  return { month, year, report };
}

// ---------- SYNC DAY SUMMARY (from local clock) ----------

function syncDaySummary(p) {
  if (!p.employeeId) throw new Error('Employee ID required');
  const today = todayStr();

  var late = p.checkIn ? isLateCheckIn(p.checkIn) : false;
  var lateMins = p.checkIn ? getLateMinutes(p.checkIn) : 0;

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const records = getSheetData(SHEETS.ATTENDANCE);
    const existing = records.find(
      a => String(a.EmployeeID) === p.employeeId && String(a.Date) === today
    );

    var resultId;

    if (existing) {
      var updates = {
        CheckIn: p.checkIn || existing.CheckIn,
        CheckOut: p.checkOut || existing.CheckOut,
        TotalMinutes: p.totalMinutes || existing.TotalMinutes,
        NetMinutes: p.netMinutes || existing.NetMinutes,
        BreakMinutes: p.breakMinutes || existing.BreakMinutes,
        Status: p.checkOut ? 'completed' : existing.Status
      };
      if (p.breakCount) updates.BreakCount = p.breakCount;
      if (p.breakDetails) updates.BreakDetails = p.breakDetails;
      if (p.mood) updates.Mood = p.mood;
      if (p.standup) updates.Standup = p.standup;
      if (p.activityScore) updates.ActivityScore = p.activityScore;
      if (p.focusPercent) updates.FocusPercent = p.focusPercent;
      updates.IsLate = late ? 'YES' : 'NO';
      updates.LateMinutes = lateMins;

      updateRow(SHEETS.ATTENDANCE, 'ID', existing.ID, updates);
      resultId = existing.ID;
    } else {
      resultId = generateId('ATT');
      appendRow(SHEETS.ATTENDANCE, [
        resultId,
        p.employeeId,
        p.employeeName || '',
        today,
        p.checkIn || '',
        p.checkOut || '',
        p.totalMinutes || 0,
        p.netMinutes || 0,
        p.breakMinutes || 0,
        p.checkOut ? 'completed' : 'checked-in',
        p.breakCount || 0,
        p.breakDetails || '',
        p.mood || '',
        p.standup || '',
        p.activityScore || 0,
        p.focusPercent || 0,
        late ? 'YES' : 'NO',
        lateMins
      ]);
    }

    // Late/Early alerts when day is completed
    if (p.checkOut && p.checkIn) {
      var empName = p.employeeName || p.employeeId;
      var emp = getSheetData(SHEETS.EMPLOYEES).find(function(e) { return String(e.ID) === p.employeeId; });
      var empEmail = emp ? emp.Email : '';

      if (late) {
        notifyLateArrival(empName, empEmail, p.checkIn, lateMins);
      }
      if (isEarlyCheckOut(p.checkOut)) {
        notifyEarlyDeparture(empName, empEmail, p.checkOut, getEarlyMinutes(p.checkOut));
      }
    }

    return { message: 'Day summary synced', id: resultId };
  } finally {
    lock.releaseLock();
  }
}

// ---------- TASKS (synced to sheet) ----------

function addTask(p) {
  if (!p.employeeId || !p.task) throw new Error('Employee ID and task required');
  const id = generateId('TSK');
  appendRow(SHEETS.TASKS, [
    id, p.employeeId, p.employeeName || '', p.date || todayStr(),
    p.task, p.status || 'done', p.time || nowStr(), new Date().toISOString()
  ]);
  return { id, message: 'Task added' };
}

function getTasks(employeeId, date) {
  return getSheetData(SHEETS.TASKS).filter(t =>
    String(t.EmployeeID) === employeeId &&
    (!date || String(t.Date) === date)
  );
}

function getTeamTasks(date) {
  const d = date || todayStr();
  return getSheetData(SHEETS.TASKS).filter(t => String(t.Date) === d);
}

// ---------- TEAM ATTENDANCE (admin view) ----------

function getTeamAttendance(month, year) {
  const employees = getEmployees();
  const attendance = getAllAttendance(month, year);
  const tasks = getSheetData(SHEETS.TASKS);

  return employees.map(emp => {
    const empAtt = attendance.filter(a => String(a.EmployeeID) === emp.ID);
    const empTasks = tasks.filter(t => String(t.EmployeeID) === emp.ID);

    return {
      employee: { id: emp.ID, name: emp.Name, department: emp.Department },
      days: empAtt.map(a => {
        const dayTasks = empTasks.filter(t => String(t.Date) === String(a.Date));
        return {
          date: a.Date,
          checkIn: a.CheckIn,
          checkOut: a.CheckOut,
          totalMinutes: a.TotalMinutes,
          netMinutes: a.NetMinutes,
          breakMinutes: a.BreakMinutes,
          status: a.Status,
          isLate: a.CheckIn ? isLateCheckIn(a.CheckIn) : false,
          tasks: dayTasks.map(t => ({ task: t.Task, status: t.Status, time: t.Time }))
        };
      }),
      summary: {
        daysPresent: empAtt.filter(a => a.Status === 'completed').length,
        totalWorkMin: empAtt.reduce((s, a) => s + (Number(a.NetMinutes) || 0), 0),
        totalTasks: empTasks.length,
        doneTasks: empTasks.filter(t => t.Status === 'done').length,
        lateDays: empAtt.filter(a => a.CheckIn && isLateCheckIn(a.CheckIn)).length
      }
    };
  });
}

// ---------- REPORTS ----------

function getMonthlyReport(month, year) {
  const employees = getEmployees();
  const attendance = getAllAttendance(month, year);
  const leaves = getSheetData(SHEETS.LEAVES);

  const report = employees.map(emp => {
    const empAttendance = attendance.filter(a => String(a.EmployeeID) === emp.ID);
    const empLeaves = leaves.filter(l =>
      String(l.EmployeeID) === emp.ID &&
      l.Status === 'approved'
    );

    const totalWorkMin = empAttendance.reduce((s, a) => s + (Number(a.NetMinutes) || 0), 0);
    const totalBreakMin = empAttendance.reduce((s, a) => s + (Number(a.BreakMinutes) || 0), 0);
    const daysPresent = empAttendance.filter(a => a.Status === 'completed').length;
    const leaveDays = empLeaves.reduce((s, l) => s + (Number(l.Days) || 0), 0);

    return {
      employeeId: emp.ID,
      name: emp.Name,
      department: emp.Department,
      daysPresent,
      leaveDays,
      totalWorkHours: Math.round(totalWorkMin / 60 * 100) / 100,
      totalBreakHours: Math.round(totalBreakMin / 60 * 100) / 100,
      avgHoursPerDay: daysPresent > 0 ? Math.round(totalWorkMin / daysPresent / 60 * 100) / 100 : 0
    };
  });

  return {
    month,
    year,
    totalEmployees: employees.length,
    report
  };
}

function getEmployeeReport(employeeId, month, year) {
  const attendance = getAttendance(employeeId, month, year);
  const leaves = getLeaves(employeeId).filter(l => {
    if (!month || !year) return true;
    const sd = String(l.StartDate).split('-');
    return sd[0] === String(year) && sd[1] === String(month).padStart(2, '0');
  });

  const totalWorkMin = attendance.reduce((s, a) => s + (Number(a.NetMinutes) || 0), 0);
  const totalBreakMin = attendance.reduce((s, a) => s + (Number(a.BreakMinutes) || 0), 0);
  const daysPresent = attendance.filter(a => a.Status === 'completed').length;

  return {
    attendance,
    leaves,
    summary: {
      daysPresent,
      totalWorkHours: Math.round(totalWorkMin / 60 * 100) / 100,
      totalBreakHours: Math.round(totalBreakMin / 60 * 100) / 100,
      avgHoursPerDay: daysPresent > 0 ? Math.round(totalWorkMin / daysPresent / 60 * 100) / 100 : 0,
      leaveDays: leaves.filter(l => l.Status === 'approved').reduce((s, l) => s + (Number(l.Days) || 0), 0)
    }
  };
}

// ---------- DASHBOARD ----------

function getDashboard(employeeId) {
  const today = todayStr();
  const todayStatus = getTodayStatus(employeeId);
  const allAttendance = getSheetData(SHEETS.ATTENDANCE);

  const todayAll = allAttendance.filter(a => String(a.Date) === today);
  const checkedInCount = todayAll.filter(a => a.Status === 'checked-in').length;
  const completedCount = todayAll.filter(a => a.Status === 'completed').length;

  const pendingLeaves = getSheetData(SHEETS.LEAVES).filter(l => l.Status === 'pending').length;

  const thisMonth = todayStr().substring(0, 7).split('-');
  const myMonthly = allAttendance.filter(a => {
    if (String(a.EmployeeID) !== employeeId) return false;
    const d = String(a.Date).split('-');
    return d[0] === thisMonth[0] && d[1] === thisMonth[1];
  });

  const monthWorkMin = myMonthly.reduce((s, a) => s + (Number(a.NetMinutes) || 0), 0);
  const monthDays = myMonthly.filter(a => a.Status === 'completed').length;

  return {
    today: todayStatus,
    teamToday: {
      checkedIn: checkedInCount,
      completed: completedCount,
      total: checkedInCount + completedCount
    },
    pendingLeaves,
    myMonthly: {
      daysWorked: monthDays,
      totalHours: Math.round(monthWorkMin / 60 * 100) / 100,
      avgHours: monthDays > 0 ? Math.round(monthWorkMin / monthDays / 60 * 100) / 100 : 0
    }
  };
}
