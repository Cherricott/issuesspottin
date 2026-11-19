"use strict";

const CFG = Object.assign({ AUTOSAVE_SECONDS: 60, FALLBACK_DOWNLOAD_MINUTES: 5 }, window.REVIEW_CONFIG || {});
const LS_ID = "issueReview.v2.id";
const lsDataKey = name => `issueReview.v2.feedback.${name}`;
const FS_OK = typeof window.showSaveFilePicker === "function" && typeof window.showOpenFilePicker === "function";
const FILE_TYPES = [{ description: "Feedback (.jsonl)", accept: { "text/plain": [".jsonl", ".json", ".txt"] } }];

const CAT_LABEL = {
  "Marriage & Family": "Hôn nhân & Gia đình", Civil: "Dân sự", Criminal: "Hình sự",
  Commercial: "Kinh doanh thương mại", Labor: "Lao động", Administrative: "Hành chính",
};
const LEVEL_LABEL = { de: "Dễ", trung_binh: "Trung bình", kho: "Khó" };

let reviewer = null;          // tên người review (lấy từ dữ liệu đã giải mã)
let questions = [];           // câu được giao, đúng thứ tự cố định
let qById = new Map();
let records = {};             // id câu -> bản ghi feedback
let fileHandle = null;        // file đang ghi đè (Chrome/Edge)
let pendingHandle = null;     // file của lần trước, chờ người dùng cho phép ghi tiếp
let changeVersion = 0;        // tăng mỗi lần dữ liệu đổi
let fileVersion = 0;          // phiên bản đã ghi vào file
let downloadVersion = 0;      // phiên bản đã tự tải (trình duyệt không ghi đè được)
let lastFileWrite = null;
let lastDownload = null;
let writeChain = Promise.resolve();
let persistTimer = null;
let declinedPicker = false;
let current = 0;              // vị trí flashcard đang hiện   // đã bấm Huỷ hộp chọn file thì không tự hỏi lại khi bấm Lưu

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ tiện ích
function normId(s) { return String(s || "").replace(/\s+/g, "").toLowerCase(); }

function slug(name) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "reviewer";
}

function fileName() { return `feedback_${slug(reviewer)}.jsonl`; }

function clock(d) {
  return d ? d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

function notice(text, isError = false) {
  const el = $("#notice");
  el.textContent = text || "";
  el.className = isError ? "notice error" : "notice";
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${Math.max(el.scrollHeight + 2, 42)}px`;
}

// ------------------------------------------------------------------ giải mã dữ liệu theo ID
async function unlock(id) {
  const siteRes = await fetch("site.json", { cache: "no-store" });
  if (!siteRes.ok) throw new Error(`không đọc được site.json (${siteRes.status})`);
  const site = await siteRes.json();
  const salt = Uint8Array.from(atob(site.salt), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(normId(id)), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: site.iter, hash: "SHA-256" }, base, 384));
  const tag = [...bits.slice(32)].map(b => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(`r/${tag}.bin`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  } catch {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// ------------------------------------------------------------------ bản ghi feedback
function hasContent(rec) {
  return !!rec && (rec.issues.some(i => i.text || i.status === "removed")
    || rec.added_issues.some(Boolean) || !!rec.note);
}

function finalIssues(rec) {
  const out = [];
  rec.issues.forEach(i => {
    if (i.status === "removed") return;
    out.push(i.status === "edited" ? i.text : i.original);
  });
  rec.added_issues.forEach(t => { if (t) out.push(t); });
  return out;
}

function buildRecord(q, parts, done, ts) {
  const issues = q.issues.map((original, idx) => {
    const p = parts.issues[idx] || { text: "", removed: false };
    const text = (p.text || "").trim();
    const status = p.removed ? "removed" : (text ? "edited" : "ok");
    return { no: idx + 1, original, text, status };
  });
  const rec = {
    reviewer, id: String(q.id), category: q.cat, level: q.lvl, done: !!done, ts: ts || new Date().toISOString(),
    issues, added_issues: (parts.added || []).map(t => (t || "").trim()).filter(Boolean),
    final_issues: [], note: (parts.note || "").trim(),
  };
  rec.final_issues = finalIssues(rec);
  return rec;
}

/** Chuẩn hoá bản ghi đọc từ file / localStorage theo đúng câu hỏi hiện tại. */
function normalizeRecord(q, obj) {
  const byNo = new Map((obj.issues || []).map(i => [Number(i.no), i]));
  const parts = {
    issues: q.issues.map((_, idx) => {
      const i = byNo.get(idx + 1) || {};
      return { text: i.text || i.edited || "", removed: i.status === "removed" };
    }),
    added: Array.isArray(obj.added_issues) ? obj.added_issues : [],
    note: obj.note || "",
  };
  return buildRecord(q, parts, obj.done, obj.ts);
}

function readCard(card) {
  return {
    issues: $$(".issue-box.original", card).map(box => ({
      text: $("textarea", box).value,
      removed: $(".remove-cb", box).checked,
    })),
    added: $$(".issue-box.added textarea", card).map(t => t.value),
    note: $(".note", card).value,
  };
}

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(lsDataKey(reviewer)) || "{}");
    const out = {};
    Object.values(raw).forEach(r => {
      const q = qById.get(String(r.id));
      if (q) out[q.id] = normalizeRecord(q, r);
    });
    return out;
  } catch {
    return {};
  }
}

function persistLocalSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistLocal, 300);
}

function persistLocal() {
  clearTimeout(persistTimer);
  try {
    localStorage.setItem(lsDataKey(reviewer), JSON.stringify(records));
  } catch (err) {
    notice(`Không lưu được vào trình duyệt: ${err.message}`, true);
  }
}

function serialize() {
  return questions.map(q => records[q.id]).filter(r => r && (r.done || hasContent(r)))
    .map(r => JSON.stringify(r)).join("\n") + "\n";
}

function touched() {
  changeVersion += 1;
  persistLocalSoon();
  updateFileState();
}

// ------------------------------------------------------------------ giao diện thẻ câu hỏi
function addIssueBox(card, text = "") {
  const box = document.createElement("div");
  box.className = "issue-box added";
  const top = document.createElement("div");
  top.className = "issue-top";
  const label = document.createElement("span");
  label.className = "issue-no";
  label.textContent = "Issue thêm";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del-added";
  del.textContent = "Xoá";
  top.append(label, del);
  const ta = document.createElement("textarea");
  ta.rows = 2;
  ta.placeholder = "Viết issue còn thiếu";
  ta.value = text;
  box.append(top, ta);
  $(".added-list", card).append(box);
  return ta;
}

function renderCards() {
  const wrap = $("#cards");
  wrap.replaceChildren();
  const tpl = $("#cardTemplate");
  questions.forEach(q => {
    const frag = tpl.content.cloneNode(true);
    const card = $(".card", frag);
    card.dataset.id = q.id;
    $(".category", frag).textContent = CAT_LABEL[q.cat] || q.cat;
    $(".level", frag).textContent = LEVEL_LABEL[q.lvl] || q.lvl;
    $(".question-id", frag).textContent = `Mã câu ${q.id}`;
    $(".facts", frag).textContent = q.input;
    const list = $(".issue-list", frag);
    q.issues.forEach((issue, idx) => {
      const box = document.createElement("div");
      box.className = "issue-box original";
      box.innerHTML = `<div class="issue-top"><span class="issue-no"></span>
        <label class="remove-toggle"><input type="checkbox" class="remove-cb"> Bỏ issue này</label></div>
        <p class="issue-text"></p>
        <textarea rows="1" placeholder="Để trống nếu issue này đúng. Nếu sai, viết lại issue đúng."></textarea>`;
      $(".issue-no", box).textContent = `Issue ${idx + 1}`;
      $(".issue-text", box).textContent = issue;
      list.append(box);
    });
    wrap.append(frag);
  });
  $$(".card", wrap).forEach(c => { c.hidden = true; });
  questions.forEach(q => fillCard(cardOf(q.id), records[q.id]));
  updateProgress();
}

function cardOf(id) { return $(`.card[data-id="${CSS.escape(String(id))}"]`); }

function fillCard(card, rec) {
  const boxes = $$(".issue-box.original", card);
  boxes.forEach((box, idx) => {
    const i = rec ? rec.issues[idx] : null;
    $("textarea", box).value = i ? i.text : "";
    $(".remove-cb", box).checked = !!i && i.status === "removed";
  });
  $(".added-list", card).replaceChildren();
  (rec ? rec.added_issues : []).forEach(t => addIssueBox(card, t));
  $(".note", card).value = rec ? rec.note : "";
  $$("textarea", card).forEach(autoGrow);
  paintCard(card);
}

function paintCard(card) {
  const rec = records[card.dataset.id];
  $$(".issue-box.original", card).forEach(box => {
    const removed = $(".remove-cb", box).checked;
    box.classList.toggle("removed", removed);
    box.classList.toggle("edited", !removed && !!$("textarea", box).value.trim());
  });
  const state = $(".saved-state", card);
  card.classList.toggle("done", !!rec && rec.done);
  card.classList.toggle("changed", !!rec && !rec.done && hasContent(rec));
  if (rec && rec.done) {
    state.textContent = `Đã lưu lúc ${clock(new Date(rec.ts))}`;
    state.className = "saved-state ok";
  } else if (rec && hasContent(rec)) {
    state.textContent = "Có thay đổi, chưa bấm Lưu";
    state.className = "saved-state warn";
  } else {
    state.textContent = "";
    state.className = "saved-state";
  }
}

function onCardEdit(card) {
  const q = qById.get(card.dataset.id);
  const rec = buildRecord(q, readCard(card), false);
  if (hasContent(rec) || (records[q.id] && records[q.id].done)) records[q.id] = rec;
  else delete records[q.id];
  paintCard(card);
  updateProgress();
  touched();
}

function updateProgress() {
  const done = questions.filter(q => records[q.id] && records[q.id].done).length;
  $("#progressBar").style.width = `${questions.length ? (done / questions.length) * 100 : 0}%`;
  $("#allDone").hidden = !(questions.length && done === questions.length);
}

function isDone(id) { return !!(records[id] && records[id].done); }

function firstUndone(from = 0) {
  const n = questions.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (!isDone(questions[i].id)) return i;
  }
  return -1;
}

/** Hiện flashcard thứ i (ẩn các thẻ khác). dir: 1 = tiến, -1 = lùi. */
function show(i, dir = 0) {
  if (!questions.length) return;
  current = Math.max(0, Math.min(i, questions.length - 1));
  const cards = $$("#cards .card");
  cards.forEach((c, k) => { c.hidden = k !== current; });
  const card = cards[current];
  $(".back", card).disabled = current === 0;
  $(".next", card).textContent = current === questions.length - 1 ? "Lưu & kết thúc" : "Lưu & tiếp →";
  $$("textarea", card).forEach(autoGrow);
  $(".facts", card).scrollTop = 0;
  if (dir) {
    card.style.setProperty("--dx", dir > 0 ? "16px" : "-16px");
    card.classList.remove("flash-enter");
    void card.offsetWidth;
    card.classList.add("flash-enter");
  }
  const top = $("#workspace").getBoundingClientRect().top + window.scrollY - 8;
  if (window.scrollY > top) window.scrollTo(0, top);
}

function jumpUndone() {
  const i = firstUndone(current + 1);
  if (i < 0) {
    $("#allDone").hidden = false;
    notice("Bạn đã lưu tất cả các câu.");
    return;
  }
  show(i, i > current ? 1 : -1);
}

/** Lưu thẻ đang hiện (đánh dấu đã xong). Câu đã lưu mà không sửa gì thì giữ nguyên thời gian lưu cũ. */
function saveCard(card) {
  const q = qById.get(card.dataset.id);
  const rec = buildRecord(q, readCard(card), true);
  const old = records[q.id];
  const same = old && old.done && JSON.stringify({ ...old, ts: "" }) === JSON.stringify({ ...rec, ts: "" });
  if (!same) {
    records[q.id] = rec;
    persistLocal();
    touched();
  }
  paintCard(card);
  updateProgress();
}

// ------------------------------------------------------------------ lưu file (ghi đè) / tải file
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("issueReview", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* không bắt buộc */ }
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const req = db.transaction("handles").objectStore("handles").get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function hasPermission(handle, ask) {
  try {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return ask ? (await handle.requestPermission(opts)) === "granted" : false;
  } catch {
    return false;
  }
}

function writeFile() {
  if (!fileHandle) return Promise.resolve(false);
  writeChain = writeChain.then(async () => {
    const version = changeVersion;
    const body = serialize();
    const w = await fileHandle.createWritable();
    await w.write(body);
    await w.close();
    fileVersion = version;
    lastFileWrite = new Date();
    updateFileState();
    return true;
  }).catch(err => {
    notice(`Chưa ghi được vào file: ${err.message}. Dữ liệu vẫn đang được giữ trong trình duyệt.`, true);
    updateFileState();
    return false;
  });
  return writeChain;
}

/** Gộp nội dung file vào bản hiện tại: mỗi câu giữ bản có thời gian mới hơn. */
function mergeText(text) {
  let merged = 0, foreign = 0, bad = 0;
  text.split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { bad += 1; return; }
    if (obj.reviewer && obj.reviewer !== reviewer) { foreign += 1; return; }
    const q = qById.get(String(obj.id));
    if (!q) { foreign += 1; return; }
    const cur = records[q.id];
    if (!cur || String(obj.ts || "") >= String(cur.ts || "")) {
      records[q.id] = normalizeRecord(q, obj);
      merged += 1;
    }
  });
  if (merged) {
    persistLocal();
    questions.forEach(q => fillCard(cardOf(q.id), records[q.id]));
    updateProgress();
    changeVersion += 1;
    const i = firstUndone(0);
    show(i < 0 ? current : i);
  }
  return { merged, foreign, bad };
}

async function useHandle(handle, mergeExisting) {
  if (mergeExisting) {
    try {
      const text = await (await handle.getFile()).text();
      const r = mergeText(text);
      if (r.foreign && !r.merged) {
        notice("File này là feedback của người khác hoặc bộ câu khác, không dùng được.", true);
        return false;
      }
    } catch { /* file mới, rỗng */ }
  }
  fileHandle = handle;
  pendingHandle = null;
  await idbSet(`h:${reviewer}`, handle);
  await writeFile();
  return true;
}

async function pickSaveFile() {
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: fileName(), types: FILE_TYPES });
  } catch {
    declinedPicker = true;              // người dùng bấm Huỷ
    return false;
  }
  const ok = await useHandle(handle, true); // chọn trúng file cũ thì gộp trước, không ghi đè mất dữ liệu
  if (ok) notice(`Từ giờ feedback được ghi đè vào ${handle.name}.`);
  return ok;
}

async function ensureFile(interactive) {
  if (fileHandle && await hasPermission(fileHandle, interactive)) return true;
  if (pendingHandle && interactive) {
    if (await hasPermission(pendingHandle, true)) return useHandle(pendingHandle, true);
  }
  if (interactive && !fileHandle && !pendingHandle && !declinedPicker) return pickSaveFile();
  return false;
}

function downloadNow() {
  const blob = new Blob([serialize()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  downloadVersion = changeVersion;
  lastDownload = new Date();
  updateFileState();
}

async function openFileToResume() {
  if (FS_OK) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    } catch {
      return;
    }
    const text = await (await handle.getFile()).text();
    const r = mergeText(text);
    if (!r.merged && r.foreign) {
      notice("File này là feedback của người khác hoặc bộ câu khác.", true);
      return;
    }
    if (!r.merged) notice(`File ${handle.name} không có gì mới hơn tiến độ đang có.`);
    if (await hasPermission(handle, true)) {
      fileHandle = handle;
      pendingHandle = null;
      await idbSet(`h:${reviewer}`, handle);
      await writeFile();
      if (r.merged) notice(`Đã cập nhật tiến độ từ ${handle.name}. Feedback tiếp theo sẽ được ghi đè vào chính file này.`);
    } else {
      notice(`Đã khôi phục từ ${handle.name}, nhưng chưa được phép ghi vào file đó. Bấm "Chọn file lưu" để chọn nơi lưu.`);
    }
  } else {
    $("#fileInput").value = "";
    $("#fileInput").click();
  }
}

function updateFileState() {
  if (!reviewer) return;
  const dot = $("#fileDot");
  const text = $("#fileText");
  const pick = $("#pickFileBtn");
  if (!FS_OK) {
    pick.hidden = true;
    const n = Number(CFG.FALLBACK_DOWNLOAD_MINUTES) || 0;
    const last = lastDownload ? ` Lần tải gần nhất: ${clock(lastDownload)}.` : "";
    text.textContent = (n > 0
      ? `Trình duyệt này không ghi đè được file, web tự tải file feedback mỗi ${n} phút khi có thay đổi.`
      : "Trình duyệt này không ghi đè được file, hãy bấm \"Tải file feedback\" thường xuyên.")
      + last + " Dùng Chrome hoặc Edge để ghi đè vào một file duy nhất.";
    dot.className = "dot warn";
    return;
  }
  pick.hidden = false;
  if (fileHandle) {
    pick.textContent = "Đổi file lưu";
    const pending = changeVersion !== fileVersion;
    text.textContent = `Đang ghi đè vào ${fileHandle.name}`
      + (lastFileWrite ? ` · lần ghi gần nhất ${clock(lastFileWrite)}` : "")
      + (pending ? " · có thay đổi chưa ghi" : "");
    dot.className = pending ? "dot warn" : "dot ok";
  } else if (pendingHandle) {
    pick.textContent = `Ghi tiếp vào ${pendingHandle.name}`;
    text.textContent = "Cần bấm cho phép để tiếp tục ghi đè file lần trước. Dữ liệu vẫn đang được giữ trong trình duyệt.";
    dot.className = "dot warn";
  } else {
    pick.textContent = "Chọn file lưu";
    text.textContent = "Chưa chọn file lưu. Dữ liệu đang được giữ tạm trong trình duyệt.";
    dot.className = "dot warn";
  }
}

function startTimers() {
  const sec = Math.max(10, Number(CFG.AUTOSAVE_SECONDS) || 60);
  setInterval(async () => {
    if (FS_OK && fileHandle && changeVersion !== fileVersion && await hasPermission(fileHandle, false)) writeFile();
  }, sec * 1000);
  const mins = Number(CFG.FALLBACK_DOWNLOAD_MINUTES) || 0;
  if (!FS_OK && mins > 0) {
    lastDownload = null;
    let since = Date.now();
    setInterval(() => {
      if (changeVersion !== downloadVersion && Date.now() - (lastDownload ? lastDownload.getTime() : since) >= mins * 60000) {
        downloadNow();
      }
    }, 15000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistLocal();
      if (fileHandle && changeVersion !== fileVersion) writeFile();
    }
  });
  window.addEventListener("beforeunload", event => {
    persistLocal();
    if (FS_OK && fileHandle && changeVersion !== fileVersion) {
      writeFile();
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

// ------------------------------------------------------------------ đăng nhập / khởi động
async function login(id, silent) {
  const msg = $("#loginMsg");
  const btn = $("#loginBtn");
  if (!normId(id)) {
    msg.className = "login-msg";
    msg.textContent = "Hãy nhập ID.";
    return;
  }
  if (!window.crypto || !crypto.subtle) {
    msg.className = "login-msg";
    msg.textContent = "Trình duyệt không hỗ trợ giải mã. Hãy mở trang qua https (GitHub Pages) hoặc localhost.";
    return;
  }
  msg.className = "login-msg info";
  msg.textContent = "Đang kiểm tra ID...";
  btn.disabled = true;
  let payload;
  try {
    payload = await unlock(id);
  } catch (err) {
    msg.className = "login-msg";
    msg.textContent = `Không tải được dữ liệu: ${err.message}`;
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if (!payload) {
    localStorage.removeItem(LS_ID);
    msg.className = "login-msg";
    msg.textContent = silent ? "" : "ID không đúng. Bạn không có quyền truy cập.";
    return;
  }
  localStorage.setItem(LS_ID, id);
  reviewer = payload.name;
  questions = payload.questions.map(q => ({ ...q, id: String(q.id) }));
  qById = new Map(questions.map(q => [q.id, q]));
  records = loadLocal();

  $("#login").hidden = true;
  $("#workspace").hidden = false;
  $("#who").hidden = false;
  $("#whoName").textContent = reviewer;
  renderCards();
  const startAt = firstUndone(0);
  show(startAt < 0 ? 0 : startAt);

  if (FS_OK) {
    const saved = await idbGet(`h:${reviewer}`);
    if (saved) {
      if (await hasPermission(saved, false)) {
        fileHandle = saved;
      } else {
        pendingHandle = saved;
      }
    }
  }
  updateFileState();
  startTimers();
  if (FS_OK && !fileHandle && !pendingHandle) {
    notice("Bấm \"Lưu & tiếp\" lần đầu, web sẽ hỏi chỗ lưu file feedback rồi tự ghi đè sau mỗi câu. Đã có file từ lần trước thì bấm \"Tải lên file .jsonl\".");
  }
}

function bindEvents() {
  $("#loginForm").addEventListener("submit", event => {
    event.preventDefault();
    login($("#idInput").value, false);
  });
  $("#logoutBtn").addEventListener("click", () => {
    if (reviewer) persistLocal();
    localStorage.removeItem(LS_ID);
    location.reload();
  });

  $("#pickFileBtn").addEventListener("click", async () => {
    if (pendingHandle && !fileHandle) {
      if (await hasPermission(pendingHandle, true)) {
        if (await useHandle(pendingHandle, true)) notice(`Tiếp tục ghi đè vào ${fileHandle.name}.`);
      } else {
        notice("Chưa được cho phép ghi vào file cũ. Có thể chọn file khác.", true);
      }
      updateFileState();
      return;
    }
    await pickSaveFile();
    updateFileState();
  });
  $("#openFileBtn").addEventListener("click", openFileToResume);
  $("#downloadBtn").addEventListener("click", downloadNow);
  $("#undoneBtn").addEventListener("click", jumpUndone);
  $("#fileInput").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    const r = mergeText(await file.text());
    if (r.merged) notice(`Đã cập nhật tiến độ từ ${file.name}.`);
    else if (r.foreign) notice("File này là feedback của người khác hoặc bộ câu khác.", true);
    else notice("File không có dữ liệu mới hơn bản đang có.");
    updateFileState();
  });

  const cards = $("#cards");
  cards.addEventListener("input", event => {
    if (event.target.tagName === "TEXTAREA") autoGrow(event.target);
    const card = event.target.closest(".card");
    if (card) onCardEdit(card);
  });
  cards.addEventListener("click", async event => {
    const card = event.target.closest(".card");
    if (!card) return;
    if (event.target.closest(".add-issue")) {
      addIssueBox(card).focus();
      return;
    }
    if (event.target.closest(".del-added")) {
      event.target.closest(".issue-box").remove();
      onCardEdit(card);
      return;
    }
    if (event.target.closest(".back")) {
      if (current > 0) show(current - 1, -1);
      return;
    }
    if (event.target.closest(".next")) {
      // hỏi chọn file ngay trong cú bấm (trình duyệt chỉ cho mở hộp chọn file khi người dùng vừa bấm)
      const fileReady = FS_OK ? ensureFile(true) : Promise.resolve(false);
      saveCard(card);
      if (current < questions.length - 1) {
        show(current + 1, 1);
      } else {
        const i = firstUndone(0);
        if (i < 0) {
          $("#allDone").hidden = false;
          notice("Đã lưu câu cuối cùng.");
        } else {
          notice("Đã lưu. Vẫn còn câu chưa làm, bấm \"Đến câu chưa làm\" để quay lại câu đó.");
        }
      }
      if (await fileReady) await writeFile();
      updateFileState();
    }
  });
}

bindEvents();
const rememberedId = localStorage.getItem(LS_ID);
if (rememberedId) {
  $("#idInput").value = rememberedId;
  login(rememberedId, true);
}
