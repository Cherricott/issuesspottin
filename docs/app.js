const STATE_KEY = "issueSpottingFeedbackV1";
let allQuestions = [];
let currentQuestions = [];
let sheetRecords = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function getReviewer() {
  return $("#reviewer").value.trim();
}

function getLocalFeedback() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); }
  catch { return {}; }
}

function setLocalFeedback(feedback) {
  localStorage.setItem(STATE_KEY, JSON.stringify(feedback));
}

function reviewerKey() {
  return getReviewer() || "__anonymous__";
}

function recordKey(id) {
  return `${reviewerKey()}::${id}`;
}

function escapeText(value) {
  return String(value ?? "");
}

function levelLabel(level) {
  return ({ de: "Dễ", trung_binh: "Trung bình", kho: "Khó" })[level] || level;
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadSheetState() {
  const api = window.SHEET_API;
  if (!api) return null;
  const reviewer = encodeURIComponent(getReviewer());
  const code = encodeURIComponent($("#accessCode").value);
  const url = `${api}?action=status&reviewer=${reviewer}&code=${code}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error === "need_code" ? "Mã truy cập không đúng" : (result.error || "Không tải được dữ liệu"));
    return result;
  } catch (error) {
    $("#status").textContent = `Không kết nối được Google Sheet: ${error.message}`;
    return null;
  }
}

function chooseQuestions() {
  const local = getLocalFeedback();
  const mine = sheetRecords?.mine || {};
  const reviewed = new Set([
    ...Object.keys(local).filter(key => key.startsWith(`${reviewerKey()}::`)).map(key => key.split("::").slice(1).join("::")),
    ...Object.keys(mine)
  ]);
  const unreviewed = allQuestions.filter(question => !reviewed.has(String(question.id)));
  const pool = unreviewed.length >= 100 ? unreviewed : shuffled(allQuestions);
  currentQuestions = shuffled(pool).slice(0, Math.min(100, pool.length));
  renderQuestions();
}

function renderQuestions() {
  const cards = $("#cards");
  cards.replaceChildren();
  const template = $("#cardTemplate");

  currentQuestions.forEach((question, index) => {
    const fragment = template.content.cloneNode(true);
    const card = $(".card", fragment);
    card.dataset.id = question.id;
    $(".question-id", fragment).textContent = `#${index + 1} · ${question.id}`;
    $(".category", fragment).textContent = question.cat;
    $(".level", fragment).textContent = levelLabel(question.lvl);
    $(".question", fragment).textContent = question.input;

    const issueList = $(".issues", fragment);
    question.issues.forEach(issue => {
      const li = document.createElement("li");
      li.textContent = issue;
      issueList.append(li);
    });

    const markList = $(".issue-mark-list", fragment);
    question.issues.forEach((issue, issueIndex) => {
      const row = document.createElement("div");
      row.className = "issue-mark-row";
      const text = document.createElement("span");
      text.textContent = `${issueIndex + 1}. ${issue}`;
      const select = document.createElement("select");
      select.className = "issue-mark";
      select.dataset.issue = String(issueIndex + 1);
      select.innerHTML = `<option value="">Chưa đánh giá</option><option value="ok">Đúng</option><option value="bad">Sai / thiếu</option>`;
      row.append(text, select);
      markList.append(row);
    });

    const local = getLocalFeedback()[recordKey(question.id)];
    const remote = sheetRecords?.mine?.[String(question.id)];
    const saved = remote || local;
    if (saved) restoreCard(card, saved);
    cards.append(fragment);
  });

  updateProgress();
  $("#status").textContent = `${currentQuestions.length} câu đang chờ review`;
}

function restoreCard(card, saved) {
  if (saved.verdict) {
    const radio = $(`input[value="${saved.verdict}"]`, card);
    if (radio) radio.checked = true;
  }
  $$(".issue-mark", card).forEach(select => {
    select.value = saved.issue_marks?.[select.dataset.issue] || "";
  });
  $(".suggested", card).value = saved.suggested_answer || "";
  $(".note", card).value = saved.note || "";
  $(".saved-state", card).textContent = "Đã có đánh giá";
}

function updateProgress() {
  const local = getLocalFeedback();
  const reviewed = new Set([
    ...Object.keys(local).filter(key => key.startsWith(`${reviewerKey()}::`)).map(key => key.split("::").slice(1).join("::")),
    ...Object.keys(sheetRecords?.mine || {})
  ]);
  const count = currentQuestions.filter(question => reviewed.has(String(question.id))).length;
  $("#progressText").textContent = `${count} / ${currentQuestions.length} đã review`;
  $("#progressBar").style.width = `${currentQuestions.length ? (count / currentQuestions.length * 100) : 0}%`;
}

async function saveCard(card) {
  const reviewer = getReviewer();
  if (!reviewer) {
    $("#reviewer").focus();
    $("#status").textContent = "Vui lòng nhập tên người review";
    return;
  }

  const verdict = $('input[name="verdict"]:checked', card)?.value;
  if (!verdict) {
    const state = $(".saved-state", card);
    state.textContent = "Hãy chọn Đúng / Đúng một phần / Sai";
    state.className = "saved-state error";
    return;
  }

  const question = allQuestions.find(item => String(item.id) === card.dataset.id);
  const issue_marks = {};
  $$(".issue-mark", card).forEach(select => {
    if (select.value) issue_marks[select.dataset.issue] = select.value;
  });
  const record = {
    ts: new Date().toISOString(),
    reviewer,
    id: String(question.id),
    category: question.cat,
    level: question.lvl,
    verdict,
    issue_marks,
    suggested_answer: $(".suggested", card).value,
    note: $(".note", card).value,
    expected_answer: question.issues.join("\n")
  };

  const local = getLocalFeedback();
  local[recordKey(record.id)] = record;
  setLocalFeedback(local);

  const state = $(".saved-state", card);
  state.className = "saved-state";
  state.textContent = "Đã lưu trên trình duyệt";

  const api = window.SHEET_API;
  if (api) {
    try {
      const response = await fetch(api, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...record, code: $("#accessCode").value })
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error === "need_code" ? "Mã truy cập không đúng" : (result.error || "Lưu Sheet thất bại"));
      state.textContent = "Đã lưu trên Sheet";
    } catch (error) {
      state.textContent = `Đã lưu trên trình duyệt; chưa gửi Sheet: ${error.message}`;
      state.className = "saved-state error";
    }
  }
  updateProgress();
}

function exportFeedback() {
  const local = getLocalFeedback();
  const reviewer = getReviewer();
  let records = Object.values(local);
  if (reviewer) records = records.filter(record => record.reviewer === reviewer);
  const body = records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  const blob = new Blob([body], { type: "application/x-jsonlines;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "feedback.jsonl";
  link.click();
  URL.revokeObjectURL(url);
}

async function start() {
  const reviewer = getReviewer();
  if (!reviewer) {
    $("#reviewer").focus();
    $("#status").textContent = "Vui lòng nhập tên người review";
    return;
  }
  localStorage.setItem("issueSpottingReviewer", reviewer);
  $("#status").textContent = "Đang đồng bộ...";
  sheetRecords = await loadSheetState();
  chooseQuestions();
}

async function init() {
  try {
    const response = await fetch("data.json");
    if (!response.ok) throw new Error(`Không tải được data.json (${response.status})`);
    allQuestions = await response.json();
    if (!Array.isArray(allQuestions) || !allQuestions.length) throw new Error("data.json không có dữ liệu");

    const savedReviewer = localStorage.getItem("issueSpottingReviewer");
    if (savedReviewer) $("#reviewer").value = savedReviewer;
    $("#status").textContent = `Đã tải ${allQuestions.length} câu`;
    $("#startBtn").addEventListener("click", start);
    $("#reloadBtn").addEventListener("click", () => {
      if (!allQuestions.length) return;
      if (getReviewer()) start();
      else chooseQuestions();
    });
    $("#exportBtn").addEventListener("click", exportFeedback);
    $("#cards").addEventListener("click", event => {
      const saveButton = event.target.closest(".save");
      if (saveButton) saveCard(saveButton.closest(".card"));
    });
    $("#reviewer").addEventListener("keydown", event => {
      if (event.key === "Enter") start();
    });

    chooseQuestions();
  } catch (error) {
    $("#status").textContent = error.message;
  }
}

init();
