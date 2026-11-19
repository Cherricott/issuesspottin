# Review Issue Spotting

Web tĩnh chạy trên GitHub Pages để review đáp án issue spotting. Mỗi người review đăng nhập bằng ID riêng và chỉ thấy bộ câu cố định được giao cho mình, mỗi câu là một flashcard. Sai ID thì không vào được, và trang không hiện tổng số câu.

```
build_site.py               đọc dữ liệu issue_spotting, chia câu và mã hoá dữ liệu vào docs/
reviewers.json              tên + ID + danh sách câu của từng người (KHÔNG đẩy lên GitHub)
data/issue_spotting.jsonl   nguồn 600 câu (id, category, difficulty, input, expected_answers)
issue_open_ended.jsonl      bộ câu đang review dạng {"input", "expected_answer"}
docs/index.html, app.js     trang web
docs/config.js              chỉnh thời gian tự lưu
docs/site.json, docs/r/     dữ liệu đã mã hoá theo ID của từng người (do build_site.py tạo)
```

## 1. Đặt tên người review và dựng dữ liệu
```bash
pip install cryptography        # chỉ cần 1 lần
python build_site.py
```
- Lần đầu chạy, script tạo `reviewers.json` với 7 người mẫu (`Người 1`…`Người 7`) và ID ngẫu nhiên. Sửa tên (và ID nếu muốn, ví dụ dùng MSSV), rồi chạy lại `python build_site.py`.
- Để trống `"id"` thì script tự tạo ID. ID không phân biệt hoa/thường và khoảng trắng.
- Quota theo **vị trí** trong `reviewers.json` (không theo tên): người thứ 1–3 mỗi người 150 câu; người thứ 4–6 mỗi người 35 câu; người thứ 7 có 45 câu. Đổi quota ở `REVIEWER_QUESTION_COUNTS` đầu `build_site.py` (tổng phải bằng số câu trong `issue_spotting.jsonl`).
- Đổi tên trong `reviewers.json` rồi chạy `python build_site.py` (không cần `--reassign`): câu của mỗi người giữ nguyên.
- Câu đã giao được giữ trong `reviewers.json`. Muốn chia lại theo quota từ đầu: `python build_site.py --reassign`.

Script in ra bảng tên, ID và số câu của từng người. Gửi riêng ID cho từng người.
`reviewers.json` đã nằm trong `.gitignore`: giữ file này cẩn thận, mất nó thì không dựng lại được với ID cũ.

## 2. Đưa lên GitHub Pages
Repo đã có workflow `.github/workflows/pages.yml` đăng thư mục `docs/`.
1. Commit và push lên nhánh `main` (gồm `docs/site.json` và `docs/r/*.bin`).
2. Lần đầu: vào **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Chờ workflow **Deploy GitHub Pages** chạy xong. Web ở `https://<user>.github.io/<repo>/`.

Mỗi lần chạy lại `build_site.py` thì commit + push lại `docs/`.

## 3. Người review dùng web thế nào
- Nhập ID → thấy tên mình. Mỗi lần chỉ hiện **một câu (flashcard)**, mở ra ở câu chưa làm đầu tiên.
- Mỗi issue trong đáp án có một ô. **Ô để trống = issue đúng.** Issue sai thì viết lại issue đúng vào ô. Issue không nên có thì tick **Bỏ issue này**.
- Thiếu issue thì bấm **+ Thêm issue** (mỗi issue một ô).
- **Lưu & tiếp →**: lưu câu đang xem (kể cả khi mọi issue đều đúng) rồi sang câu kế tiếp.
- **← Quay lại**: về câu trước để xem hoặc sửa, sửa xong bấm **Lưu & tiếp** để lưu lại.
- **Đến câu chưa làm**: nhảy tới câu chưa lưu gần nhất.

### Tự lưu file feedback, tải lên để cập nhật tiến độ
- **Chrome / Edge**: lần đầu bấm **Lưu & tiếp**, web hỏi chỗ lưu file (`feedback_<tên>.jsonl`). Từ đó file được **ghi đè** sau mỗi câu và định kỳ mỗi `AUTOSAVE_SECONDS` giây (mặc định 60) nếu có thay đổi, gồm cả phần đang gõ dở.
- **Firefox / Safari** không ghi đè được file: web tự tải file mỗi `FALLBACK_DOWNLOAD_MINUTES` phút (mặc định 5) khi có thay đổi. Bấm **Tải xuống feedback** để tải ngay.
- **Tải lên file .jsonl**: chọn file feedback đã lưu để cập nhật tiến độ (dùng khi đổi máy, đổi trình duyệt, hoặc xoá dữ liệu trình duyệt). Mỗi câu giữ bản mới hơn giữa file và trình duyệt, rồi web mở câu chưa làm đầu tiên. Trên Chrome/Edge, web tiếp tục ghi đè vào chính file vừa tải lên.
- Trên cùng một trình duyệt, dữ liệu còn được giữ trong trình duyệt nên tải lại trang không mất gì.
- File của người khác sẽ bị từ chối khi tải lên.

## Định dạng feedback
Mỗi dòng của `feedback_<tên>.jsonl` là một câu:
```json
{"reviewer": "Người 1", "id": "1006531", "category": "Criminal", "level": "kho",
 "done": true, "ts": "2026-11-19T10:00:00.000Z",
 "issues": [
   {"no": 1, "original": "...", "text": "", "status": "ok"},
   {"no": 2, "original": "...", "text": "issue viết lại", "status": "edited"},
   {"no": 3, "original": "...", "text": "", "status": "removed"}],
 "added_issues": ["issue còn thiếu"],
 "final_issues": ["...", "issue viết lại", "issue còn thiếu"],
 "note": ""}
```
- `status`: `ok` (ô trống = đúng), `edited` (đã viết lại), `removed` (bỏ issue).
- `final_issues`: danh sách issue sau khi sửa, dùng làm đáp án mới.
- `done: false` là câu đang làm dở, chưa bấm Lưu.
- `id` là id của câu trong `mcq.jsonl` gốc.

Gộp file của mọi người: nối các file lại (`cat feedback_*.jsonl > all.jsonl`), mỗi người × mỗi câu chỉ có một dòng.

## Thử trên máy trước khi push
```bash
python -m http.server 8000 --directory docs   # mở http://localhost:8000
```
Phải mở qua `localhost` hoặc `https` (không mở thẳng file `index.html`), vì trình duyệt chỉ cho giải mã dữ liệu và ghi file trong môi trường an toàn.
