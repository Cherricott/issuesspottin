#!/usr/bin/env python3
"""Chọn 600 câu từ file MCQ gốc (giữ tỉ lệ category gốc, trong mỗi category giữ tỉ lệ mức độ)
rồi tạo:
  - issue_open_ended_600.jsonl : {"input": câu hỏi, "expected_answer": issue đúng dạng text}
  - docs/data.json            : dữ liệu cho web review (thêm id, category, mức độ để truy ngược)

Dòng thứ i trong issue_open_ended_600.jsonl và phần tử thứ i trong docs/data.json là cùng 1 câu.

Cách chạy (sửa đường dẫn ở khối CẤU HÌNH rồi chạy):
  python build_site.py
"""
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

# ======================= CẤU HÌNH (sửa ở đây) =======================
SCRIPT_DIR = Path(__file__).resolve().parent
SOURCE_PATH = SCRIPT_DIR / "mcq.jsonl"                       # file JSONL gốc
OUT_JSONL = SCRIPT_DIR / "issue_open_ended_600.jsonl"        # file 2 trường cho 600 câu
SITE_DATA = SCRIPT_DIR / "docs" / "data.json"                # dữ liệu cho web (GitHub Pages đọc thư mục docs/)
N_TOTAL = 600
SEED = 42                                                    # đổi seed để ra bộ 600 câu khác
# ===================================================================

LEVEL_ORDER = ["de", "trung_binh", "kho"]


def allocate(counts: dict, total: int) -> dict:
    """Chia `total` theo tỉ lệ `counts` (phương pháp số dư lớn nhất), không vượt quá số câu có sẵn."""
    pool = sum(counts.values())
    quota = {k: total * v / pool for k, v in counts.items()}
    alloc = {k: min(int(q), counts[k]) for k, q in quota.items()}
    rest = total - sum(alloc.values())
    for k in sorted(counts, key=lambda k: quota[k] - int(quota[k]), reverse=True):
        if rest <= 0:
            break
        if alloc[k] < counts[k]:
            alloc[k] += 1
            rest -= 1
    return alloc


def expected_text(issues: list) -> str:
    if len(issues) == 1:
        return issues[0]
    return "\n".join(f"{i}. {t}" for i, t in enumerate(issues, 1))


def main():
    if not SOURCE_PATH.is_file():
        raise SystemExit(f"Không tìm thấy {SOURCE_PATH}. Sửa SOURCE_PATH ở đầu build_site.py.")
    rows = [json.loads(l) for l in SOURCE_PATH.open(encoding="utf-8") if l.strip()]
    if N_TOTAL > len(rows):
        raise SystemExit(f"N_TOTAL={N_TOTAL} lớn hơn số câu có sẵn ({len(rows)})")
    rng = random.Random(SEED)

    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r["category"]].append(r)
    cat_alloc = allocate({c: len(v) for c, v in by_cat.items()}, N_TOTAL)

    picked = []
    for cat in sorted(by_cat):
        by_lvl = defaultdict(list)
        for r in by_cat[cat]:
            by_lvl[r["muc_do"]].append(r)
        lvl_alloc = allocate({l: len(v) for l, v in by_lvl.items()}, cat_alloc[cat])
        for lvl, k in lvl_alloc.items():
            picked.extend(rng.sample(by_lvl[lvl], k))
    rng.shuffle(picked)

    site = []
    SITE_DATA.parent.mkdir(parents=True, exist_ok=True)
    with OUT_JSONL.open("w", encoding="utf-8") as f:
        for r in picked:
            issues = [r["options"][a] for a in sorted(r["answer"])]
            question = r["question"].rstrip()
            f.write(json.dumps({"input": question, "expected_answer": expected_text(issues)}, ensure_ascii=False) + "\n")
            site.append({"id": str(r["id"]), "cat": r["category"], "lvl": r["muc_do"],
                         "input": question, "issues": issues})
    body = "[\n" + ",\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in site) + "\n]\n"
    SITE_DATA.write_text(body, encoding="utf-8")

    print(f"Đã chọn {len(picked)} câu -> {OUT_JSONL.name}, {SITE_DATA.relative_to(SCRIPT_DIR)}")
    cat_n = Counter(r["category"] for r in picked)
    for cat in sorted(cat_n, key=lambda c: -cat_n[c]):
        lv = Counter(r["muc_do"] for r in picked if r["category"] == cat)
        print(f"  {cat:<18} {cat_n[cat]:>4}  (" + ", ".join(f"{l}={lv.get(l, 0)}" for l in LEVEL_ORDER) + ")")


if __name__ == "__main__":
    main()
