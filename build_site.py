#!/usr/bin/env python3
"""Tạo dữ liệu cho web review Issue Spotting (GitHub Pages).

Các bước:
  1. Đọc bộ câu gốc data/questions_600.json (600 câu đã chọn từ mcq.jsonl).
  2. Bớt câu theo CATEGORY_LIMITS (mặc định bớt Hôn nhân & Gia đình), giữ tỉ lệ mức độ.
     Với Hôn nhân & Gia đình, ưu tiên bỏ các câu "ly hôn + nuôi con" lặp lại, giữ câu đa dạng.
  3. Ghi issue_open_ended.jsonl ({"input", "expected_answer"}) cho đúng bộ câu đang review.
  4. Chia câu cho từng người trong reviewers.json. Câu đã chia được lưu lại trong file này
     nên chạy lại script KHÔNG làm đổi câu của ai (cố định). Chỉ câu chưa có chủ mới được chia thêm.
  5. Mã hoá phần câu của từng người bằng ID của họ (AES-GCM, khoá suy ra từ ID bằng PBKDF2)
     -> docs/r/<mã>.bin. Không có ID đúng thì không đọc được, cũng không biết tổng số câu.

Cách chạy:
  pip install cryptography          # chỉ cần 1 lần
  python build_site.py              # dựng lại docs/ từ reviewers.json
  python build_site.py --reassign   # XOÁ cách chia cũ, chia lại từ đầu (cẩn thận: đổi câu của mọi người)
  python build_site.py --reselect   # chọn lại 600 câu từ mcq.jsonl rồi mới dựng (cần mcq.jsonl)

reviewers.json chứa ID (đóng vai trò mật khẩu) nên đã nằm trong .gitignore. Giữ file này cẩn thận:
mất nó thì không dựng lại được với ID cũ.
"""
import argparse
import base64
import hashlib
import json
import os
import random
import secrets
import sys
from collections import Counter, defaultdict
from pathlib import Path

# ======================= CẤU HÌNH (sửa ở đây) =======================
CATEGORY_LIMITS = {"Marriage & Family": 100}   # số câu tối đa mỗi category; category không ghi = giữ hết
DEFAULT_REVIEWERS = 5                          # số người tạo sẵn khi chưa có reviewers.json
SEED = 42
N_TOTAL = 600                                  # chỉ dùng với --reselect
PBKDF2_ITER = 150_000                          # phải khớp cách web suy khoá (đọc từ docs/site.json)
# ===================================================================

LEVEL_ORDER = ["de", "trung_binh", "kho"]
ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"   # bỏ ký tự dễ nhầm: i l o 0 1
ROUTINE_MF = ("ly hôn", "nuôi con", "trực tiếp nuôi", "cấp dưỡng", "vắng mặt", "quan hệ hôn nhân")


def allocate(counts: dict, total: int) -> dict:
    """Chia `total` theo tỉ lệ `counts` (phương pháp số dư lớn nhất), không vượt quá số câu có sẵn."""
    pool = sum(counts.values())
    if pool == 0:
        return {k: 0 for k in counts}
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


def is_routine_mf(q) -> bool:
    """Câu HNGĐ mà mọi issue chỉ xoay quanh ly hôn / nuôi con / cấp dưỡng / vắng mặt."""
    return all(any(k in issue.lower() for k in ROUTINE_MF) for issue in q["issues"])


# ---------------------------------------------------------------- bước 1 (tuỳ chọn)
def reselect_from_mcq(mcq_path: Path, pool_path: Path):
    if not mcq_path.is_file():
        raise SystemExit(f"Không tìm thấy {mcq_path}")
    rows = [json.loads(l) for l in mcq_path.open(encoding="utf-8") if l.strip()]
    rng = random.Random(SEED)
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r["category"]].append(r)
    cat_alloc = allocate({c: len(v) for c, v in by_cat.items()}, min(N_TOTAL, len(rows)))
    picked = []
    for cat in sorted(by_cat):
        by_lvl = defaultdict(list)
        for r in by_cat[cat]:
            by_lvl[r["muc_do"]].append(r)
        lvl_alloc = allocate({l: len(v) for l, v in by_lvl.items()}, cat_alloc[cat])
        for lvl, k in lvl_alloc.items():
            picked.extend(rng.sample(by_lvl[lvl], k))
    rng.shuffle(picked)
    pool = [{"id": str(r["id"]), "cat": r["category"], "lvl": r["muc_do"], "input": r["question"].rstrip(),
             "issues": [r["options"][a] for a in sorted(r["answer"])]} for r in picked]
    write_json_lines_array(pool_path, pool)
    print(f"Đã chọn lại {len(pool)} câu từ {mcq_path.name} -> {pool_path}")


def write_json_lines_array(path: Path, items: list):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "[\n" + ",\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in items) + "\n]\n"
    path.write_text(body, encoding="utf-8")


# ---------------------------------------------------------------- bước 2
def apply_limits(pool: list) -> list:
    rng = random.Random(SEED)
    keep_ids = set()
    by_cat = defaultdict(list)
    for q in pool:
        by_cat[q["cat"]].append(q)
    for cat, items in by_cat.items():
        limit = CATEGORY_LIMITS.get(cat)
        if limit is None or limit >= len(items):
            keep_ids.update(q["id"] for q in items)
            continue
        by_lvl = defaultdict(list)
        for q in items:
            by_lvl[q["lvl"]].append(q)
        lvl_alloc = allocate({l: len(v) for l, v in by_lvl.items()}, limit)
        for lvl, k in lvl_alloc.items():
            cand = sorted(by_lvl[lvl], key=lambda q: q["id"])
            rng.shuffle(cand)
            if cat == "Marriage & Family":
                cand.sort(key=is_routine_mf)          # câu đa dạng lên trước, câu ly hôn/nuôi con thường lệ xuống sau
            keep_ids.update(q["id"] for q in cand[:k])
    return [q for q in pool if q["id"] in keep_ids]


# ---------------------------------------------------------------- bước 4
def norm_id(s: str) -> str:
    return "".join(str(s).split()).lower()


def new_id(taken: set) -> str:
    while True:
        raw = "".join(secrets.choice(ID_ALPHABET) for _ in range(8))
        rid = raw[:4] + "-" + raw[4:]
        if norm_id(rid) not in taken:
            return rid


def load_reviewers(path: Path) -> list:
    if not path.is_file():
        taken = set()
        people = []
        for i in range(1, DEFAULT_REVIEWERS + 1):
            rid = new_id(taken)
            taken.add(norm_id(rid))
            people.append({"name": f"Người {i}", "id": rid, "questions": []})
        print(f"Chưa có {path.name}: đã tạo {DEFAULT_REVIEWERS} người mẫu. Sửa tên trong file rồi chạy lại.")
        return people
    data = json.loads(path.read_text(encoding="utf-8"))
    people = data["reviewers"] if isinstance(data, dict) else data
    taken = set()
    names = set()
    for p in people:
        p["name"] = str(p.get("name", "")).strip()
        if not p["name"]:
            raise SystemExit("reviewers.json: có người chưa có tên")
        if p["name"] in names:
            raise SystemExit(f"reviewers.json: trùng tên {p['name']!r}")
        names.add(p["name"])
        if not str(p.get("id", "")).strip():
            p["id"] = new_id(taken)
            print(f"  Tạo ID mới cho {p['name']}: {p['id']}")
        if norm_id(p["id"]) in taken:
            raise SystemExit(f"reviewers.json: trùng ID {p['id']!r}")
        taken.add(norm_id(p["id"]))
        p["questions"] = [str(x) for x in p.get("questions", [])]
    return people


def assign(people: list, questions: list, reassign: bool):
    valid = {q["id"]: q for q in questions}
    owner = {}
    for p in people:
        if reassign:
            p["questions"] = []
        kept = []
        for qid in p["questions"]:
            if qid not in valid:
                print(f"  ! {p['name']}: câu {qid} không còn trong bộ review, bỏ khỏi danh sách")
            elif qid in owner:
                print(f"  ! câu {qid} đang được giao cho cả {owner[qid]} và {p['name']}, giữ cho {owner[qid]}")
            else:
                owner[qid] = p["name"]
                kept.append(qid)
        p["questions"] = kept

    rng = random.Random(f"{SEED}-assign-{len(owner)}")
    free = [q for q in questions if q["id"] not in owner]
    if not free:
        return
    # xếp theo category + mức độ rồi chia vòng cho người đang ít câu nhất -> mỗi người có đủ loại
    rng.shuffle(free)
    free.sort(key=lambda q: (q["cat"], LEVEL_ORDER.index(q["lvl"]) if q["lvl"] in LEVEL_ORDER else 9))
    new_for = defaultdict(list)
    turn = 0
    for q in free:
        counts = [len(p["questions"]) + len(new_for[p["name"]]) for p in people]
        low = min(counts)
        order = list(range(turn, len(people))) + list(range(turn))
        k = next(i for i in order if counts[i] == low)
        new_for[people[k]["name"]].append(q["id"])
        turn = (k + 1) % len(people)
    for p in people:
        extra = new_for[p["name"]]
        rng.shuffle(extra)                 # thứ tự hiển thị ngẫu nhiên, nhưng cố định sau khi lưu
        p["questions"].extend(extra)
    print(f"  Đã chia thêm {len(free)} câu chưa có người review")


# ---------------------------------------------------------------- bước 5
def encrypt_site(people: list, questions: list, site_dir: Path):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise SystemExit("Thiếu thư viện mã hoá. Chạy: pip install cryptography")
    byid = {q["id"]: q for q in questions}
    out_dir = site_dir / "r"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.bin"):
        old.unlink()
    salt = os.urandom(16)
    for p in people:
        bits = hashlib.pbkdf2_hmac("sha256", norm_id(p["id"]).encode("utf-8"), salt, PBKDF2_ITER, dklen=48)
        key, tag = bits[:32], bits[32:].hex()
        payload = {"name": p["name"], "questions": [byid[qid] for qid in p["questions"]]}
        plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        iv = os.urandom(12)
        (out_dir / f"{tag}.bin").write_bytes(iv + AESGCM(key).encrypt(iv, plain, None))
    (site_dir / "site.json").write_text(json.dumps({
        "salt": base64.b64encode(salt).decode(), "iter": PBKDF2_ITER}) + "\n", encoding="utf-8")
    old_data = site_dir / "data.json"
    if old_data.exists():
        old_data.unlink()                  # không để lộ toàn bộ câu hỏi dạng chữ thường trên web


def main():
    root_default = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=root_default, help="thư mục repo (mặc định: thư mục chứa script)")
    ap.add_argument("--reassign", action="store_true", help="xoá cách chia cũ và chia lại từ đầu")
    ap.add_argument("--reselect", action="store_true", help="chọn lại 600 câu từ mcq.jsonl")
    args = ap.parse_args()
    root = args.root.resolve()
    pool_path = root / "data" / "questions_600.json"
    reviewers_path = root / "reviewers.json"

    if args.reselect:
        reselect_from_mcq(root / "mcq.jsonl", pool_path)
    if not pool_path.is_file():
        raise SystemExit(f"Không tìm thấy {pool_path}")
    pool = json.loads(pool_path.read_text(encoding="utf-8"))
    questions = apply_limits(pool)

    with (root / "issue_open_ended.jsonl").open("w", encoding="utf-8") as f:
        for q in questions:
            f.write(json.dumps({"input": q["input"], "expected_answer": expected_text(q["issues"])},
                               ensure_ascii=False) + "\n")

    people = load_reviewers(reviewers_path)
    if not people:
        raise SystemExit("reviewers.json không có ai")
    assign(people, questions, args.reassign)
    reviewers_path.write_text(json.dumps({"reviewers": people}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    encrypt_site(people, questions, root / "docs")

    # Tóm tắt (chỉ in ra máy của bạn, không đưa lên web)
    print(f"\nBộ review: {len(questions)} câu (gốc {len(pool)}) -> issue_open_ended.jsonl")
    cat_n = Counter(q["cat"] for q in questions)
    for cat in sorted(cat_n, key=lambda c: -cat_n[c]):
        lv = Counter(q["lvl"] for q in questions if q["cat"] == cat)
        print(f"  {cat:<18} {cat_n[cat]:>4}  (" + ", ".join(f"{l}={lv.get(l, 0)}" for l in LEVEL_ORDER) + ")")
    byid = {q["id"]: q for q in questions}
    print("\nNgười review          ID           số câu  theo category")
    for p in people:
        cc = Counter(byid[qid]["cat"] for qid in p["questions"])
        detail = ", ".join(f"{c.split()[0]}={n}" for c, n in sorted(cc.items()))
        print(f"  {p['name']:<20} {p['id']:<12} {len(p['questions']):>5}   {detail}")
    print(f"\nĐã ghi docs/site.json và {len(people)} file docs/r/*.bin. Danh sách ID nằm trong {reviewers_path.name}.")


if __name__ == "__main__":
    sys.exit(main())
