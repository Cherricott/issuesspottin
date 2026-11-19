# Review Issue Spotting (600 câu)

Web tĩnh chạy trên GitHub Pages để review đáp án issue spotting. Mỗi lần mở trang sẽ hiện 100 câu ngẫu nhiên trong 600 câu, ưu tiên những câu người review chưa góp ý. Feedback được ghi vào một Google Sheet qua Google Apps Script.

```
build_site.py               chọn 600 câu từ mcq.jsonl -> issue_open_ended_600.jsonl + docs/data.json
apps_script.gs              code backend dán vào Google Apps Script
docs/index.html             trang web
docs/config.js              chỗ dán URL của Apps Script
docs/data.json              dữ liệu 600 câu (đã tạo sẵn, seed 42)
issue_open_ended_600.jsonl  600 câu dạng {"input", "expected_answer"}
```

## 1. (Tuỳ chọn) Tạo lại bộ 600 câu
Đặt `mcq.jsonl` cạnh `build_site.py`, rồi sửa khối CẤU HÌNH nếu cần (đường dẫn, `N_TOTAL`, `SEED`):
```bash
python build_site.py
```
Script chia số câu theo tỉ lệ category gốc, và trong mỗi category lại chia theo tỉ lệ mức độ dễ / trung bình / khó.
`mcq.jsonl` đã có trong `.gitignore` để không bị đẩy toàn bộ bộ câu hỏi lên GitHub.

## 2. Tạo Google Sheet nhận feedback
1. Tạo một Google Sheet mới, chọn **Tiện ích mở rộng → Apps Script**.
2. Xoá code mặc định, dán toàn bộ `apps_script.gs` vào rồi bấm Save.
   Muốn bắt người review nhập mã thì điền `ACCESS_CODE`.
3. Chọn **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Bấm Deploy, cấp quyền, rồi copy **Web app URL** (kết thúc bằng `/exec`).
4. Dán URL đó vào `SHEET_API` trong `docs/config.js`.

Nếu sửa `apps_script.gs` sau khi đã deploy: vào **Deploy → Manage deployments → Edit → Version: New version → Deploy**. URL không đổi.

## 3. Đưa lên GitHub Pages
Repository đã có workflow `.github/workflows/pages.yml`. Chỉ cần:

1. Đẩy code lên nhánh `main`.
2. Vào repo trên GitHub, chọn **Settings → Pages → Build and deployment**.
3. Chọn **Source: GitHub Actions**.
4. Vào **Actions**, chạy hoặc chờ workflow **Deploy GitHub Pages** hoàn tất.

Website sẽ chạy tại `https://<user>.github.io/<repo>/`.

## Feedback
- Mỗi lần bấm "Lưu" thêm một dòng vào sheet `feedback` (giữ lịch sử).
  Các cột: `ts, reviewer, id, category, level, verdict, issue_marks, suggested_answer, note, expected_answer`.
- Nút "Tải feedback (.jsonl)" trên web tải bản đã gộp: mỗi người × mỗi câu chỉ giữ lần lưu mới nhất.
- `verdict` nhận một trong ba giá trị: `correct` (Đúng), `partial` (Đúng một phần), `wrong` (Sai).
  `issue_marks` có dạng `{"1": "ok", "2": "bad"}`, đánh giá từng issue với câu có nhiều issue.
- `id` là id của câu trong `mcq.jsonl` gốc.

Nếu để trống `SHEET_API`, web vẫn chạy nhưng feedback chỉ lưu trên trình duyệt của từng người. Họ phải bấm "Tải feedback" rồi gửi file lại cho bạn.

## Thử trên máy trước khi push
```bash
cd docs && python -m http.server 8000   # mở http://localhost:8000
```
