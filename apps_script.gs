/**
 * Backend lưu feedback vào Google Sheet cho web review Issue Spotting (GitHub Pages).
 *
 * Cài đặt:
 *  1. Tạo 1 Google Sheet mới -> Extensions (Tiện ích mở rộng) -> Apps Script.
 *  2. Xoá code mặc định, dán toàn bộ file này vào, bấm Save.
 *  3. Deploy -> New deployment -> chọn loại "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     -> Deploy -> cấp quyền -> copy "Web app URL" (kết thúc bằng /exec).
 *  4. Dán URL đó vào docs/config.js.
 *  Sửa code này sau khi đã deploy: Deploy -> Manage deployments -> Edit -> Version: New version -> Deploy
 *  (URL giữ nguyên).
 *
 * Mỗi lần người review bấm "Lưu" là thêm 1 dòng (giữ lịch sử). Khi đọc, dòng mới nhất
 * của mỗi (reviewer, id) được tính. Tải bản gộp: <URL>?action=export
 */

// ======================= CẤU HÌNH =======================
const SHEET_NAME = 'feedback';
const ACCESS_CODE = '';   // để trống = không cần mã. Điền vd 'vtlegal2026' thì người review phải nhập mã này.
// ========================================================

const HEADERS = ['ts', 'reviewer', 'id', 'category', 'level', 'verdict', 'issue_marks',
                 'suggested_answer', 'note', 'expected_answer'];
const VERDICTS = ['correct', 'partial', 'wrong'];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function codeOk_(code) {
  return !ACCESS_CODE || String(code || '') === ACCESS_CODE;
}

function text_(v) {
  if (v instanceof Date) return v.toISOString();
  return v == null ? '' : String(v);
}

function parseMarks_(v) {
  try { return JSON.parse(v || '{}'); } catch (e) { return {}; }
}

/** Dòng mới nhất cho mỗi (reviewer, id), các dòng được thêm theo thứ tự thời gian. */
function latest_() {
  const sh = sheet_();
  const n = sh.getLastRow();
  if (n < 2) return [];
  const values = sh.getRange(2, 1, n - 1, HEADERS.length).getValues();
  const map = {};
  values.forEach(function (r) {
    const rec = {};
    HEADERS.forEach(function (h, i) { rec[h] = text_(r[i]); });
    if (!rec.reviewer || !rec.id) return;
    rec.issue_marks = parseMarks_(rec.issue_marks);
    map[rec.reviewer + '\u0001' + rec.id] = rec;
  });
  return Object.keys(map).map(function (k) { return map[k]; });
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!codeOk_(p.code)) return json_({ ok: false, error: 'need_code' });
  const recs = latest_();

  if (p.action === 'export') {
    const out = recs.map(function (r) { return JSON.stringify(r); }).join('\n') + (recs.length ? '\n' : '');
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.TEXT);
  }

  const reviewer = String(p.reviewer || '').trim();
  const mine = {};
  const counts = {};
  const reviewers = {};
  recs.forEach(function (r) {
    counts[r.id] = (counts[r.id] || 0) + 1;
    reviewers[r.reviewer] = true;
    if (reviewer && r.reviewer === reviewer) {
      mine[r.id] = { ts: r.ts, verdict: r.verdict, issue_marks: r.issue_marks,
                     suggested_answer: r.suggested_answer, note: r.note };
    }
  });
  return json_({ ok: true, mine: mine, counts: counts,
                 reviewed_ids: Object.keys(counts).length, reviewers: Object.keys(reviewers).length });
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Dữ liệu gửi lên không phải JSON' });
  }
  if (!codeOk_(p.code)) return json_({ ok: false, error: 'need_code' });
  const reviewer = String(p.reviewer || '').trim().slice(0, 80);
  if (!reviewer) return json_({ ok: false, error: 'Thiếu tên người review' });
  if (!p.id) return json_({ ok: false, error: 'Thiếu id câu hỏi' });
  if (VERDICTS.indexOf(p.verdict) < 0) return json_({ ok: false, error: 'Đánh giá chung không hợp lệ' });

  const marks = {};
  Object.keys(p.issue_marks || {}).forEach(function (k) {
    const v = p.issue_marks[k];
    if (/^\d+$/.test(k) && (v === 'ok' || v === 'bad')) marks[k] = v;
  });
  const ts = new Date().toISOString();
  // Ô bắt đầu bằng "=" sẽ bị Sheets hiểu là công thức -> thêm dấu ' để giữ nguyên là chữ.
  const safe = function (s, max) { s = String(s == null ? '' : s).slice(0, max); return /^=/.test(s) ? "'" + s : s; };
  const row = [ts, safe(reviewer, 80), safe(p.id, 64), safe(p.category, 64), safe(p.level, 32), p.verdict,
               JSON.stringify(marks), safe(p.suggested_answer, 10000), safe(p.note, 5000),
               safe(p.expected_answer, 40000)];

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_();
    const range = sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length);
    range.setNumberFormat('@');  // giữ id, thời gian... ở dạng chữ, không để Sheets tự đổi kiểu
    range.setValues([row]);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, ts: ts });
}
