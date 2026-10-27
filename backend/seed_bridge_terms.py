"""一次性匯入種子橋樑詞（概念標籤）與關係句型（共 33 個橋樑詞、41 個句型，每個句型附家族分類）。
可重複執行：
- 已存在的標籤（含別名）一律沿用，不修改其維度與定義。
- 已存在的句型一律略過；唯一例外是「家族欄位為空」的既有句型，會補上種子指定的家族。
  已有家族的句型絕不覆蓋，所以你手動改過的分類不會被改回去。
用法：先啟動後端（啟動時會自動替既有資料庫補上 family 欄位），再在本檔所在資料夾執行
    python seed_bridge_terms.py --base http://127.0.0.1:8000 --dry-run   （只列出將做的事，不寫入）
    python seed_bridge_terms.py --base http://127.0.0.1:8000             （正式寫入）
執行前請先備份 SQLite 資料庫檔。
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request

# 維度必須與 types.ts 的 DEFAULT_FACETS 逐字相同
FACETS = {"結構／實體", "功能／過程", "問題／現象", "方法／工具", "屬性／原則"}
PLACEHOLDERS = {"A", "B", "結果"}

# 家族值必須與 schemas.py 的 PatternFamily、types.ts 的 PatternFamily 一致
FAMILY_FAILURE = "failure"  # 失效與承載
FAMILY_CONSTRAINT = "constraint"  # 卡住與限制
FAMILY_FEEDBACK = "feedback"  # 回饋與調節
FAMILY_CHANGE = "change"  # 變化的形狀
FAMILY_EVIDENCE = "evidence"  # 判讀與證據
FAMILIES = {FAMILY_FAILURE, FAMILY_CONSTRAINT, FAMILY_FEEDBACK, FAMILY_CHANGE, FAMILY_EVIDENCE}

# (橋樑詞, 維度, 一句話定義)
SEED_TERMS = [
    # --- 第一批（9 個） ---
    ("負載轉移", "問題／現象", "原承擔者失效或退出後，負擔被迫轉由其他承擔者吸收。"),
    ("負回饋調節", "功能／過程", "系統偏離基準時，產生反向作用把它拉回基準。"),
    ("正回饋", "功能／過程", "變化會引發同方向的進一步變化，使偏離越滾越大。"),
    ("回饋延遲", "屬性／原則", "修正訊號抵達的時間落後於問題發生的時間。"),
    ("瓶頸效應", "問題／現象", "整體產出被流程中容量最小的單一環節所限制。"),
    ("取捨", "屬性／原則", "兩個目標彼此消長，無法同時達到最大。"),
    ("臨界閾值", "屬性／原則", "量累積到某一點時，系統行為發生突然的質變。"),
    ("過度擬合", "問題／現象", "對既有經驗貼合過度，導致遇到新情境時表現失準。"),
    ("單點失效", "問題／現象", "系統中單一元件失效就足以使整體失效。"),
    # --- 第二批（24 個） ---
    ("邊際效應遞減", "屬性／原則", "每多投入一單位，帶來的額外收益逐步下降。"),
    ("適應", "功能／過程", "系統承受刺激後調整自身狀態，使之後面對同類刺激時反應改變。"),
    ("路徑依賴", "屬性／原則", "過去的選擇或經歷限制了後續可走的路徑，使系統難以轉向。"),
    ("訊噪比", "屬性／原則", "有用訊號相對於雜訊的比例，比例越低越難辨識真實變化。"),
    ("測量擾動", "問題／現象", "觀測或測量的動作本身改變了被觀測的對象，使結果失真。"),
    ("冗餘備援", "結構／實體", "以額外的備份元件，使單一元件失效時整體仍能運作。"),
    ("穩健性", "屬性／原則", "系統在擾動或部分失效下仍維持功能的程度。"),
    ("連鎖失效", "問題／現象", "一個環節失效後，沿著相連的環節依序擴散成更大範圍的失效。"),
    ("振盪", "問題／現象", "系統在目標值兩側反覆過頭與回彈，無法穩定下來。"),
    ("指數成長", "屬性／原則", "增加量與現有規模成正比，使規模以倍數越長越快。"),
    ("均值回歸", "功能／過程", "極端的觀測值之後，下一次觀測傾向回到平均附近。"),
    ("倖存者偏誤", "問題／現象", "只看見通過篩選而留下的樣本，因而對整體做出錯誤判斷。"),
    ("混淆因子", "問題／現象", "第三個因素同時影響兩個變數，使它們看起來有直接的因果關係。"),
    ("槓桿放大", "功能／過程", "以小的輸入換取不成比例的大輸出，同時也放大錯誤與損失。"),
    ("存量耗竭", "問題／現象", "消耗速度長期超過補充速度，使存量下降到不足以支撐運作。"),
    ("存量與流量", "屬性／原則", "存量只能透過流入與流出改變，是流量長期累積的結果。"),
    ("局部最佳", "問題／現象", "只優化局部而使整體變差，或搜尋停在局部最佳而錯過更好的整體解。"),
    ("緩衝", "結構／實體", "在兩個速率不同的環節之間預留的容量，用來吸收波動。"),
    ("適用範圍", "屬性／原則", "結論或方法只在特定條件內成立，超出範圍就可能失效。"),
    ("非線性", "屬性／原則", "輸出的變化與輸入的變化不成比例。"),
    ("過載", "問題／現象", "負荷超過承載能力，導致功能退化或失效。"),
    ("指標失真", "問題／現象", "指標一旦被當作目標來最佳化，就不再反映它原本要衡量的東西。"),
    ("摩擦成本", "屬性／原則", "狀態轉換或交換時必然損耗的阻力，使實際結果低於理想值。"),
    ("組合爆炸", "問題／現象", "選項的組合數隨變數增加而急遽膨脹，使窮舉變得不可行。"),
]

# (句型名稱, 橋樑詞, 模板, 透鏡問句, 家族)；同一個橋樑詞可有多個句型
SEED_PATTERNS = [
    # --- 第一批（9 個） ---
    ("負載轉移（代償）", "負載轉移", "{A} 失效或撤出，{B} 被迫接手並出現 {結果}", "壓力或工作量被移到別處了嗎？", FAMILY_FAILURE),
    ("負回饋調節", "負回饋調節", "{A} 偏離基準時觸發 {B}，將系統拉回 {結果}", "輸出會回頭拉住輸入嗎？", FAMILY_FEEDBACK),
    ("正回饋（自我強化）", "正回饋", "{A} 強化 {B}，{B} 再反過來放大 {A}，導致 {結果}", "輸出會回頭放大輸入嗎？", FAMILY_FEEDBACK),
    ("回饋延遲", "回饋延遲", "{A} 的修正訊號延遲抵達 {B}，導致矯枉過正並產生 {結果}", "回饋訊號太慢才到達嗎？", FAMILY_FEEDBACK),
    ("瓶頸效應", "瓶頸效應", "{A} 的容量上限卡住 {B}，使整體產出受限於 {結果}", "整體被單一最弱環節卡住嗎？", FAMILY_CONSTRAINT),
    ("取捨（互斥目標）", "取捨", "提升 {A} 必然犧牲 {B}，兩者形成 {結果} 的取捨", "兩個目標無法同時最大化嗎？", FAMILY_CONSTRAINT),
    ("臨界閾值", "臨界閾值", "{A} 累積跨越 {B} 後，系統狀態突變為 {結果}", "量累積到某點後行為突變嗎？", FAMILY_CHANGE),
    ("過度擬合", "過度擬合", "{A} 過度適應特定情境 {B}，遇到新環境時產生 {結果}", "對歷史經驗貼太緊反而失準嗎？", FAMILY_EVIDENCE),
    ("單點失效", "單點失效", "{A} 缺乏 {B} 備援，一旦失效即引發 {結果}", "單一元件壞掉就全倒，還是有備援？", FAMILY_FAILURE),
    # --- 第二批：既有橋樑詞的其他句型（8 個） ---
    ("風險轉移", "負載轉移", "{A} 把風險或成本移給 {B}，自身安全但 {B} 出現 {結果}", "風險或成本被轉嫁給別人了嗎？", FAMILY_FAILURE),
    ("探索與利用取捨", "取捨", "資源用於探索 {A} 就無法用於利用 {B}，取捨的結果是 {結果}", "要嘗試新的，還是深耕已知的？", FAMILY_CONSTRAINT),
    ("速度與精度取捨", "取捨", "加快 {A} 的速度會降低 {B} 的精度，形成 {結果}", "變快會不會變不準？", FAMILY_CONSTRAINT),
    ("最慢一環限制整體", "瓶頸效應", "{A} 是流程中最慢的一環，即使改善 {B}，{結果} 也不會提升", "改善別的地方有用嗎？", FAMILY_CONSTRAINT),
    ("惡性循環", "正回饋", "{A} 惡化 {B}，{B} 又加劇 {A}，形成惡性循環 {結果}", "兩件事會互相加劇嗎？", FAMILY_FEEDBACK),
    ("穩態維持", "負回饋調節", "{A} 偏離設定值 {B} 時，系統反向調整以維持 {結果}", "系統怎麼維持穩定？", FAMILY_FEEDBACK),
    ("已知與未知表現落差", "過度擬合", "{A} 在已知的 {B} 上表現極佳，面對未知情境時出現 {結果}", "已知很好、遇新情境就變差？", FAMILY_EVIDENCE),
    ("越過門檻才驟變", "臨界閾值", "{A} 逐步增加而 {結果} 幾乎不變，直到越過 {B} 才驟變", "逐步增加卻突然質變？", FAMILY_CHANGE),
    # --- 第二批：新橋樑詞的句型（24 個） ---
    ("邊際效應遞減", "邊際效應遞減", "持續增加 {A} 的投入，{B} 每單位帶來的 {結果} 逐步減少", "多投入還值得嗎？", FAMILY_CHANGE),
    ("適應", "適應", "{A} 反覆施加於 {B}，{B} 調整自身，之後面對同樣刺激呈現 {結果}", "同樣的刺激越來越沒效？", FAMILY_FEEDBACK),
    ("路徑依賴", "路徑依賴", "早期的 {A} 使 {B} 被鎖定，之後難以轉向而出現 {結果}", "早期選擇鎖住了後續嗎？", FAMILY_CONSTRAINT),
    ("訊號被雜訊淹沒", "訊噪比", "{A} 中的雜訊淹沒了 {B} 的訊號，導致 {結果}", "看到的變化是真的還是雜訊？", FAMILY_EVIDENCE),
    ("測量改變對象", "測量擾動", "對 {A} 進行 {B} 這個測量，本身改變了 {A}，使得到的 {結果} 失真", "測量動作本身有影響嗎？", FAMILY_EVIDENCE),
    ("冗餘備援", "冗餘備援", "{A} 有 {B} 作為備援，所以 {A} 失效時仍維持 {結果}", "壞了還撐得住嗎？", FAMILY_FAILURE),
    ("擾動下仍維持", "穩健性", "面對 {A} 的擾動，{B} 仍維持 {結果}", "受衝擊後還能運作嗎？", FAMILY_FAILURE),
    ("連鎖擴散", "連鎖失效", "{A} 失效後波及 {B}，逐級擴散成 {結果}", "一處壞掉會不會拖垮其他？", FAMILY_FAILURE),
    ("過頭來回擺盪", "振盪", "{A} 的調整過度，使 {B} 在目標兩側來回擺動，形成 {結果}", "調整會不會過頭？", FAMILY_FEEDBACK),
    ("倍數成長", "指數成長", "{A} 的增加量與其自身規模成正比，使 {B} 以倍數成長為 {結果}", "越大長得越快？", FAMILY_CHANGE),
    ("極端後回到平均", "均值回歸", "{A} 出現極端偏離後，{B} 傾向回到 {結果} 的常態水準", "極端之後會不會自己回來？", FAMILY_FEEDBACK),
    ("只看見倖存者", "倖存者偏誤", "只觀察到通過 {A} 篩選的 {B}，因而對整體做出 {結果} 的錯誤判斷", "沒被看到的樣本去哪了？", FAMILY_EVIDENCE),
    ("第三因素造成假關聯", "混淆因子", "{A} 同時影響 {B} 與 {結果}，使 {B} 與 {結果} 看似有直接因果", "兩者相關是因為第三者嗎？", FAMILY_EVIDENCE),
    ("小輸入大輸出", "槓桿放大", "{A} 作為槓桿，使 {B} 的小幅變動被放大成 {結果}", "小動作會不會被放大？", FAMILY_CHANGE),
    ("消耗快於補充", "存量耗竭", "{A} 的消耗速度超過補充速度，{B} 的存量下降至 {結果}", "用掉的比補回的多嗎？", FAMILY_FAILURE),
    ("流入大於流出", "存量與流量", "{A} 的流入大於流出，使 {B} 的存量累積成 {結果}", "存量是怎麼累積或消失的？", FAMILY_CHANGE),
    ("局部優化損害整體", "局部最佳", "優化 {A} 這個局部，使 {B} 變差，整體得到 {結果}", "改善局部會不會害到整體？", FAMILY_CONSTRAINT),
    ("緩衝吸收波動", "緩衝", "{A} 與 {B} 之間的緩衝吸收了波動，避免 {結果}", "快慢兩端之間有緩衝嗎？", FAMILY_FAILURE),
    ("條件內成立", "適用範圍", "{A} 只在 {B} 條件內成立，超出範圍時出現 {結果}", "這個結論在什麼條件下成立？", FAMILY_EVIDENCE),
    ("不成比例的反應", "非線性", "{A} 的小幅變動造成 {B} 不成比例的 {結果}", "投入與反應成比例嗎？", FAMILY_CHANGE),
    ("超出承載", "過載", "{A} 的負荷超過 {B} 的承載能力，導致 {結果}", "撐不住是因為負荷太大嗎？", FAMILY_FAILURE),
    ("指標被當成目標", "指標失真", "把 {A} 當作目標去最佳化，使 {A} 不再反映 {B}，出現 {結果}", "衡量的東西還有意義嗎？", FAMILY_EVIDENCE),
    ("轉換有損耗", "摩擦成本", "{A} 轉換到 {B} 需付出摩擦成本，使實際 {結果} 低於理想值", "切換或交換要付多少代價？", FAMILY_CONSTRAINT),
    ("選項膨脹", "組合爆炸", "{A} 增加使 {B} 的組合數急遽膨脹，窮舉不可行而出現 {結果}", "選項是不是多到算不完？", FAMILY_CONSTRAINT),
]


def validate_seed() -> None:
    """寫入前先檢查種子資料本身，有錯就整批不動，避免做到一半才失敗。"""
    names = [n for n, _, _ in SEED_TERMS]
    if len(set(names)) != len(names):
        sys.exit("種子資料錯誤：橋樑詞名稱重複")
    for name, facet, definition in SEED_TERMS:
        if facet not in FACETS:
            sys.exit(f"種子資料錯誤：「{name}」的維度「{facet}」不在 DEFAULT_FACETS 內")
        if not definition.strip():
            sys.exit(f"種子資料錯誤：「{name}」缺少定義")
    labels = [p[0] for p in SEED_PATTERNS]
    if len(set(labels)) != len(labels):
        sys.exit("種子資料錯誤：句型名稱重複")
    for label, term, template, _, family in SEED_PATTERNS:
        if term not in names:
            sys.exit(f"種子資料錯誤：句型「{label}」指向不存在的橋樑詞「{term}」")
        if family not in FAMILIES:
            sys.exit(f"種子資料錯誤：句型「{label}」的家族「{family}」不合法")
        found = re.findall(r"\{([^{}]*)\}", template)
        if not found or any(p not in PLACEHOLDERS for p in found):
            sys.exit(f"種子資料錯誤：句型「{label}」的模板佔位符不合法")


def call(base: str, method: str, path: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"{base}/api{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        sys.exit(f"失敗：{method} {path} → HTTP {e.code}：{detail}")
    except urllib.error.URLError as e:
        sys.exit(f"無法連線到 {base}：{e.reason}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000", help="後端網址（請改成你實際的位址）")
    ap.add_argument("--dry-run", action="store_true", help="只列出將做的事，不寫入任何資料")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    dry = args.dry_run

    validate_seed()

    # 以正式名稱與別名建立查找表，只看概念軸標籤
    lookup: dict[str, list[dict]] = {}
    for t in call(base, "GET", "/tags")["tags"]:
        if t["axis"] in ("concept", "free"):
            for key in [t["name"], *t.get("aliases", [])]:
                lookup.setdefault(key.lower(), []).append(t)

    tag_ids: dict[str, str] = {}
    new_tags = skipped_tags = 0
    for name, facet, definition in SEED_TERMS:
        found = lookup.get(name.lower(), [])
        if len({t["id"] for t in found}) > 1:
            sys.exit(f"失敗：有多個標籤使用「{name}」（含別名），請先合併或改名後再執行")
        if found:
            tag_ids[name] = found[0]["id"]
            skipped_tags += 1
            print(f"略過（標籤已存在，沿用既有標籤）：{name}")
            continue
        if dry:
            tag_ids[name] = ""
            new_tags += 1
            print(f"[試跑] 將建立標籤：{name}（{facet}）")
            continue
        created = call(
            base, "POST", "/tags",
            {"name": name, "axis": "concept", "parent_id": None, "facet": facet, "definition": definition},
        )
        tag_ids[name] = created["id"]
        new_tags += 1
        print(f"已建立標籤：{name}（{facet}）")

    existing = {p["label"]: p for p in call(base, "GET", "/relation-patterns")["patterns"]}
    new_patterns = skipped_patterns = backfilled = 0
    for label, term, template, note, family in SEED_PATTERNS:
        current = existing.get(label)
        if current is not None:
            if current.get("family"):
                skipped_patterns += 1
                print(f"略過（句型已存在）：{label}")
            elif dry:
                backfilled += 1
                print(f"[試跑] 將補分類：{label} → {family}")
            else:
                call(base, "PATCH", f"/relation-patterns/{current['id']}", {"family": family})
                backfilled += 1
                print(f"已補分類：{label} → {family}")
            continue
        if dry:
            new_patterns += 1
            print(f"[試跑] 將建立句型：{label} → {term}（{family}）")
            continue
        call(
            base, "POST", "/relation-patterns",
            {"label": label, "template": template, "bridge_tag_id": tag_ids[term], "note": note, "family": family},
        )
        new_patterns += 1
        print(f"已建立句型：{label} → {term}（{family}）")

    mode = "試跑（未寫入任何資料）" if dry else "完成"
    print(
        f"\n{mode}：標籤 新增 {new_tags}／沿用 {skipped_tags}；"
        f"句型 新增 {new_patterns}／補分類 {backfilled}／略過 {skipped_patterns}"
    )


if __name__ == "__main__":
    main()