"""後端驗收測試。每個測試註明「它在證明什麼」，而不只是「做了什麼」。"""
import sqlite3

import pytest


# B1：外鍵約束真的生效。若沒開，刪除會留下指向不存在資料的殘列，而且不會報錯。
def test_b1_foreign_keys_enforced(settings, client):
    from app.db import open_conn  # 驗證的是「應用程式自己開的連線」，不是測試自己的連線

    conn = open_conn(settings.db_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO card_tags (card_id, tag_id) VALUES ('nope', 'nope')")
    finally:
        conn.close()


# B2：刪標籤的原子性。在最後一步（刪標籤本身）注入失敗，前面已做的「子節點上移」
# 「卡片改歸屬」「刪歸屬」必須全部回滾，否則會留下半套分類結構。
def test_b2_delete_tag_is_atomic(client, api, db):
    cabinet = api.tag("櫃子")
    drawer = api.tag("抽屜", parent_id=cabinet["id"])
    sub = api.tag("小格", parent_id=drawer["id"])
    card = api.card("c", tag_ids=[drawer["id"]])
    db.execute("CREATE TRIGGER boom BEFORE DELETE ON tags BEGIN SELECT RAISE(ABORT, 'boom'); END;")
    db.commit()
    r = client.delete(f"/api/tags/{drawer['id']}")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "INTERNAL_ERROR"
    assert db.execute("SELECT parent_id FROM tags WHERE id=?", (sub["id"],)).fetchone()[0] == drawer["id"]
    got = {r[0] for r in db.execute("SELECT tag_id FROM card_tags WHERE card_id=?", (card["id"],))}
    assert got == {drawer["id"]}  # 沒有被改歸屬到櫃子，原歸屬也還在


# B3：刪標籤的語意：有父節點→子抽屜上移、卡片改歸父節點；最上層→卡片變未分類。
def test_b3_delete_tag_semantics(client, api):
    cabinet = api.tag("櫃子")
    drawer = api.tag("抽屜", parent_id=cabinet["id"])
    sub = api.tag("小格", parent_id=drawer["id"])
    c1 = api.card("in-drawer", tag_ids=[drawer["id"]])
    r = client.delete(f"/api/tags/{drawer['id']}")
    assert r.status_code == 200
    tags = {t["id"]: t for t in client.get("/api/tags").json()["tags"]}
    assert drawer["id"] not in tags
    assert tags[sub["id"]]["parent_id"] == cabinet["id"]
    detail = client.get(f"/api/cards/{c1['id']}").json()
    assert [t["id"] for t in detail["tags"]] == [cabinet["id"]]
    # 刪最上層櫃子：卡片進未分類
    client.delete(f"/api/tags/{cabinet['id']}")
    assert client.get(f"/api/cards/{c1['id']}").json()["tags"] == []
    unc = client.get("/api/cards", params={"unclassified": True}).json()["items"]
    assert [c["id"] for c in unc] == [c1["id"]]
    # 小格上移後變成最上層
    assert {t["id"]: t for t in client.get("/api/tags").json()["tags"]}[sub["id"]]["parent_id"] is None


# B3b：上移後會同名衝突 → 拒絕，且不改任何資料（避免默默合併改變分類語意）
def test_b3_delete_rejected_on_name_conflict(client, api):
    cabinet = api.tag("櫃子")
    drawer = api.tag("抽屜", parent_id=cabinet["id"])
    api.tag("重名", parent_id=drawer["id"])
    api.tag("重名", parent_id=cabinet["id"])
    card = api.card("c", tag_ids=[drawer["id"]])
    prev = client.get(f"/api/tags/{drawer['id']}/delete-preview").json()
    assert prev["conflicts"] == ["重名"]
    r = client.delete(f"/api/tags/{drawer['id']}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "NAME_CONFLICT"
    assert r.json()["error"]["details"]["names"] == ["重名"]
    assert [t["id"] for t in client.get(f"/api/cards/{card['id']}").json()["tags"]] == [drawer["id"]]


# B4：「未分類」＝沒有領域軸歸屬。只有自由 tag 的卡片仍須算未分類，否則會從收件匣消失、永遠沒人整理。
def test_b4_unclassified_means_no_domain_tag(client, api):
    free = api.tag("待讀", axis="free")
    dom = api.tag("解剖")
    only_free = api.card("only-free", tag_ids=[free["id"]])
    filed = api.card("filed", tag_ids=[dom["id"], free["id"]])
    bare = api.card("bare")
    ids = {c["id"] for c in client.get("/api/cards", params={"unclassified": True}).json()["items"]}
    assert ids == {only_free["id"], bare["id"]}
    assert client.get("/api/tags").json()["unclassified_count"] == 2
    assert filed["id"] not in ids


# 查上層要包含所有後代，且同一張卡片不會因為同時在父與子而重複出現。
def test_tag_filter_includes_descendants_without_duplicates(client, api):
    a = api.tag("A")
    b = api.tag("B", parent_id=a["id"])
    both = api.card("both", tag_ids=[a["id"], b["id"]])
    deep = api.card("deep", tag_ids=[b["id"]])
    items = client.get("/api/cards", params={"tag_id": a["id"]}).json()["items"]
    assert sorted(c["id"] for c in items) == sorted([both["id"], deep["id"]])


# B5（v2 升級）：有向具名關係。同一 (source_id, target_id, relation_type) 冪等；可附理由與 confirmed/hypothesis 狀態。
def test_b5_links_idempotent_and_symmetric(client, api, db):
    a, b = api.card("a"), api.card("b")
    r1 = client.put(
        "/api/links",
        json={
            "source_id": a["id"],
            "target_id": b["id"],
            "relation_type": "support",
            "status": "confirmed",
            "reason": "實驗數據支持",
        },
    )
    r2 = client.put(
        "/api/links",
        json={"source_id": a["id"], "target_id": b["id"], "relation_type": "support"},
    )
    assert r1.json()["existed"] is False and r2.json()["existed"] is True
    assert r2.json()["reason"] == "實驗數據支持"
    assert db.execute("SELECT COUNT(*) FROM links").fetchone()[0] == 1
    a_links = client.get(f"/api/cards/{a['id']}").json()["links"]
    b_links = client.get(f"/api/cards/{b['id']}").json()["links"]
    assert len(a_links) == 1 and a_links[0]["id"] == b["id"] and a_links[0]["direction"] == "outgoing"
    assert len(b_links) == 1 and b_links[0]["id"] == a["id"] and b_links[0]["direction"] == "incoming"
    assert client.put("/api/links", json={"source_id": a["id"], "target_id": a["id"]}).status_code == 422
    assert client.delete(f"/api/links/{b['id']}/{a['id']}").status_code == 200
    assert client.delete(f"/api/links/{b['id']}/{a['id']}").status_code == 404


# B6：刪卡片會從所有白板消失；從白板移除卻不能刪卡片。兩者混淆就是資料遺失。
def test_b6_delete_vs_remove(client, api, db):
    c, other = api.card("c"), api.card("o")
    b1, b2 = api.board("one"), api.board("two")
    api.to_board(b1["id"], c["id"])
    api.to_board(b2["id"], c["id"], x=50, y=60)
    api.to_board(b1["id"], other["id"])
    client.put("/api/links", json={"card_id": c["id"], "other_id": other["id"]})
    assert client.delete(f"/api/boards/{b1['id']}/cards/{c['id']}").status_code == 200
    assert client.get(f"/api/cards/{c['id']}").status_code == 200
    on_b2 = client.get(f"/api/boards/{b2['id']}").json()["cards"]
    assert [(x["card_id"], x["x"], x["y"]) for x in on_b2] == [(c["id"], 50, 60)]
    imp = client.get(f"/api/cards/{c['id']}/impact").json()
    assert imp["board_count"] == 1 and imp["link_count"] == 1
    assert client.delete(f"/api/cards/{c['id']}").status_code == 200
    assert db.execute("SELECT COUNT(*) FROM board_cards WHERE card_id=?", (c["id"],)).fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM links").fetchone()[0] == 0
    assert client.get(f"/api/cards/{other['id']}").status_code == 200


# 刪白板只刪白板與位置，不刪卡片。
def test_delete_board_keeps_cards(client, api):
    c = api.card("c")
    b = api.board()
    api.to_board(b["id"], c["id"])
    assert client.delete(f"/api/boards/{b['id']}").status_code == 200
    assert client.get(f"/api/cards/{c['id']}").status_code == 200


# 同一張卡片在同一塊白板只能出現一次；批次更新中任一張不在白板上則整批回滾（不做部分更新）。
def test_board_cards_rules(client, api):
    c1, c2 = api.card("1"), api.card("2")
    b = api.board()
    api.to_board(b["id"], c1["id"], 1, 2)
    r = client.post(f"/api/boards/{b['id']}/cards", json={"card_id": c1["id"], "x": 0, "y": 0})
    assert r.status_code == 409 and r.json()["error"]["code"] == "CARD_ALREADY_ON_BOARD"
    r = client.patch(
        f"/api/boards/{b['id']}/cards",
        json={"items": [{"card_id": c1["id"], "x": 99, "y": 99}, {"card_id": c2["id"], "x": 5, "y": 5}]},
    )
    assert r.status_code == 404
    pos = client.get(f"/api/boards/{b['id']}").json()["cards"][0]
    assert (pos["x"], pos["y"]) == (1, 2)  # 第一張沒有被改到
    r = client.patch(f"/api/boards/{b['id']}/cards", json={"items": [{"card_id": c1["id"], "x": 7, "y": 8, "w": 300, "h": 200}]})
    assert r.status_code == 200
    pos = client.get(f"/api/boards/{b['id']}").json()["cards"][0]
    assert (pos["x"], pos["y"], pos["w"], pos["h"]) == (7, 8, 300, 200)


# 白板只回傳「兩端都在這塊白板上」的連結。
def test_board_returns_only_internal_links(client, api):
    a, b, c = api.card("a"), api.card("b"), api.card("c")
    bd = api.board()
    api.to_board(bd["id"], a["id"])
    api.to_board(bd["id"], b["id"])
    client.put("/api/links", json={"card_id": a["id"], "other_id": b["id"]})
    client.put("/api/links", json={"card_id": a["id"], "other_id": c["id"]})
    links = client.get(f"/api/boards/{bd['id']}").json()["links"]
    assert len(links) == 1 and {links[0]["card_a"], links[0]["card_b"]} == {a["id"], b["id"]}


# B9：搜尋 `%`/`_` 必須當成普通字元，否則搜「%」會回傳全部卡片、看起來像搜尋壞了或「全部都符合」。
def test_b9_like_escaping(client, api):
    api.card("百分比", body="成功率 50% 以上")
    api.card("底線", body="a_b")
    api.card("普通", body="nothing special")
    pct = client.get("/api/cards", params={"q": "%"}).json()["items"]
    assert [c["title"] for c in pct] == ["百分比"]
    und = client.get("/api/cards", params={"q": "_"}).json()["items"]
    assert [c["title"] for c in und] == ["底線"]
    assert "50%" in pct[0]["snippet"]


# B10：標籤移動不能成環、不能跨軸；自由標籤不能有父節點。
def test_b10_move_rules(client, api):
    a = api.tag("A")
    b = api.tag("B", parent_id=a["id"])
    c = api.tag("C", parent_id=b["id"])
    r = client.patch(f"/api/tags/{a['id']}", json={"parent_id": c["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "CYCLE_DETECTED"
    assert client.patch(f"/api/tags/{a['id']}", json={"parent_id": a["id"]}).json()["error"]["code"] == "CYCLE_DETECTED"
    t = api.tag("T", axis="type")
    r = client.patch(f"/api/tags/{t['id']}", json={"parent_id": a["id"]})
    assert r.json()["error"]["code"] == "AXIS_MISMATCH"
    f = api.tag("F", axis="free")
    r = client.post("/api/tags", json={"name": "子", "axis": "free", "parent_id": f["id"]})
    assert r.json()["error"]["code"] == "AXIS_MISMATCH"
    r = client.post("/api/tags", json={"name": "子", "axis": "type", "parent_id": a["id"]})
    assert r.json()["error"]["code"] == "AXIS_MISMATCH"
    # 合法移動：移到最上層、再移回
    assert client.patch(f"/api/tags/{c['id']}", json={"parent_id": None}).json()["parent_id"] is None
    assert client.patch(f"/api/tags/{c['id']}", json={"parent_id": a["id"]}).json()["parent_id"] == a["id"]


# 同層同名：最上層（parent_id 為 NULL）也必須擋住。SQLite 的 UNIQUE 對 NULL 不擋，所以這裡驗證部分索引與預檢有效。
def test_sibling_name_uniqueness_including_roots(client, api):
    api.tag("同名")
    r = client.post("/api/tags", json={"name": "同名", "axis": "domain"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NAME_CONFLICT"
    api.tag("同名", axis="type")  # 不同軸可以同名
    p = api.tag("父")
    api.tag("同名", parent_id=p["id"])  # 不同父節點可以同名
    other = api.tag("別的", parent_id=p["id"])
    r = client.patch(f"/api/tags/{other['id']}", json={"name": "同名"})
    assert r.json()["error"]["code"] == "NAME_CONFLICT"


# B11：版本不符不覆蓋。否則開兩個分頁時，後存的會悄悄蓋掉先存的。
def test_b11_stale_version(client, api):
    c = api.card("t", body="v1")
    first = client.patch(f"/api/cards/{c['id']}", json={"body": "v2", "expected_updated_at": c["updated_at"]})
    assert first.status_code == 200
    stale = client.patch(f"/api/cards/{c['id']}", json={"body": "v3", "expected_updated_at": c["updated_at"]})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "STALE_VERSION"
    assert stale.json()["error"]["details"]["current"]["body"] == "v2"
    assert client.get(f"/api/cards/{c['id']}").json()["body"] == "v2"
    ok = client.patch(f"/api/cards/{c['id']}", json={"title": "新", "expected_updated_at": first.json()["updated_at"]})
    assert ok.status_code == 200 and ok.json()["body"] == "v2" and ok.json()["title"] == "新"
    assert client.patch(f"/api/cards/{c['id']}", json={"expected_updated_at": ok.json()["updated_at"]}).status_code == 422


# 刪除標籤直接走 SQL 必須失敗（RESTRICT），逼所有刪除都走程序，不會留下殘列。
def test_direct_tag_delete_is_restricted(client, api, db):
    t = api.tag("T")
    api.card("c", tag_ids=[t["id"]])
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM tags WHERE id=?", (t["id"],))


# 卡片歸屬標籤的冪等與取消；建立卡片時帶不存在的標籤要失敗而不是默默忽略。
def test_card_tag_assignment(client, api):
    t = api.tag("T")
    c = api.card("c")
    assert client.put(f"/api/cards/{c['id']}/tags/{t['id']}").json()["existed"] is False
    assert client.put(f"/api/cards/{c['id']}/tags/{t['id']}").json()["existed"] is True
    assert client.delete(f"/api/cards/{c['id']}/tags/{t['id']}").status_code == 200
    assert client.delete(f"/api/cards/{c['id']}/tags/{t['id']}").status_code == 404
    r = client.post("/api/cards", json={"title": "x", "tag_ids": ["不存在"]})
    assert r.status_code == 404
    assert client.get("/api/cards", params={"tag_id": "x", "unclassified": True}).status_code == 422


def test_validation_error_format(client):
    r = client.post("/api/boards", json={"name": "  "})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


# Checkpoint 1A：驗證別名解析（完全符合正式標籤、完全符合別名、一詞多義跨維度、相似提示）與搜尋擴展
def test_c1_tag_aliases_resolve_and_search_expansion(client, api):
    t1 = client.post(
        "/api/tags",
        json={"name": "胸廓活動度", "axis": "concept", "facet": "功能／過程", "definition": "吸氣與吐氣時胸廓的擴張能力"},
    ).json()
    assert t1["axis"] == "concept" and t1["facet"] == "功能／過程"
    # 新增別名
    with_alias = client.post(f"/api/tags/{t1['id']}/aliases", json={"alias": "肋骨擴張"}).json()
    assert "肋骨擴張" in with_alias["aliases"]
    # 重複別名必須拒絕
    dup = client.post(f"/api/tags/{t1['id']}/aliases", json={"alias": "肋骨擴張"})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "NAME_CONFLICT"
    # 解析：完全符合別名 -> 自動指向正式標籤 ID
    res = client.post("/api/tags/resolve", json={"query": "肋骨擴張"}).json()
    assert res["status"] == "exact_alias" and res["tag"]["id"] == t1["id"]
    # 搜尋擴展：卡片只綁正式標籤、內文未出現別名，搜別名仍可找到該卡片
    card = api.card("呼吸觀察", body="純內文", tag_ids=[t1["id"]])
    found = client.get("/api/cards", params={"q": "肋骨擴張"}).json()["items"]
    assert [c["id"] for c in found] == [card["id"]]
    # 一詞多義：同軸但不同維度（facet）允許同名，解析時回傳 ambiguous 供人工選擇
    client.post("/api/tags", json={"name": "呼吸", "axis": "concept", "facet": "生理過程", "definition": "氣體交換與通氣過程"})
    client.post("/api/tags", json={"name": "呼吸", "axis": "concept", "facet": "介入訓練", "definition": "呼吸再教育訓練法"})
    amb = client.post("/api/tags/resolve", json={"query": "呼吸"}).json()
    assert amb["status"] == "ambiguous" and len(amb["candidates"]) == 2


# Checkpoint 1B：驗證標籤合併（卡片改歸屬、舊名稱自動轉為別名、舊別名一併繼承）
def test_c1_tag_merge_preserves_cards_and_aliases(client, api):
    target = client.post("/api/tags", json={"name": "橫膈膜", "axis": "concept", "facet": "解剖結構"}).json()
    source = client.post("/api/tags", json={"name": "膈肌", "axis": "concept", "facet": "解剖結構"}).json()
    client.post(f"/api/tags/{source['id']}/aliases", json={"alias": "Diaphragm"})
    c = api.card("橫膈筆記", tag_ids=[source["id"]])
    merged = client.post(f"/api/tags/{source['id']}/merge", json={"target_id": target["id"]}).json()
    assert set(merged["aliases"]) == {"膈肌", "Diaphragm"}
    detail = client.get(f"/api/cards/{c['id']}").json()
    assert [t["id"] for t in detail["tags"]] == [target["id"]]


# Checkpoint 1C：驗證收件夾（inbox vs curated）與卡片型態（card_type）獨立運作
def test_c1_inbox_and_card_type(client, api):
    c = api.card("新想法")
    assert c["curation_status"] == "inbox" and c["card_type"] == "untyped"
    assert client.get("/api/tags").json()["inbox_count"] == 1
    # 整理完成：即使沒有任何連結或概念標籤，標記為 curated 後即離開收件夾
    patched = client.patch(
        f"/api/cards/{c['id']}",
        json={"card_type": "hypothesis", "curation_status": "curated", "expected_updated_at": c["updated_at"]},
    ).json()
    assert patched["card_type"] == "hypothesis" and patched["curation_status"] == "curated"
    assert client.get("/api/tags").json()["inbox_count"] == 0
    assert client.get("/api/cards", params={"curation_status": "inbox"}).json()["items"] == []
    assert [x["id"] for x in client.get("/api/cards", params={"curation_status": "curated"}).json()["items"]] == [c["id"]]


# Checkpoint 2A：驗證同一對卡片支援多種不同關係類型、修改理由與狀態（confirmed / hypothesis）
def test_c2_directed_named_links_and_patch(client, api):
    a, b = api.card("橫膈膜張力"), api.card("肩頸代償")
    l1 = client.put(
        "/api/links",
        json={
            "source_id": a["id"],
            "target_id": b["id"],
            "relation_type": "influence",
            "status": "hypothesis",
            "reason": "吸氣輔助肌過度代償",
        },
    ).json()
    assert l1["relation_type"] == "influence" and l1["status"] == "hypothesis"
    # 同方向可建立另一種關係類型（UNIQUE(source_id, target_id, relation_type)）
    l2 = client.put(
        "/api/links",
        json={"source_id": a["id"], "target_id": b["id"], "relation_type": "extend", "status": "confirmed"},
    ).json()
    assert l2["existed"] is False
    assert len(client.get(f"/api/cards/{a['id']}").json()["links"]) == 2
    # 點選連線更新狀態與理由
    patched = client.patch(
        f"/api/links/{a['id']}/{b['id']}",
        json={"old_relation_type": "influence", "status": "confirmed", "reason": "經臨床案例確認"},
    ).json()
    assert patched["status"] == "confirmed" and patched["reason"] == "經臨床案例確認"
    # 僅刪除其中一種關係
    client.delete(f"/api/links/{a['id']}/{b['id']}", params={"relation_type": "extend"})
    rem = client.get(f"/api/cards/{a['id']}").json()["links"]
    assert len(rem) == 1 and rem[0]["relation_type"] == "influence"


# Checkpoint 2B：驗證白板視覺分組框（只負責空間視覺群組，刪除分組框不影響卡片與語意連結）
def test_c2_board_visual_groups(client, api):
    bd = api.board("呼吸專題")
    c = api.card("測試卡")
    api.to_board(bd["id"], c["id"], x=50, y=50)
    g = client.post(
        f"/api/boards/{bd['id']}/groups",
        json={"label": "代償觀察群", "x": 20, "y": 20, "w": 400, "h": 300, "color": "blue"},
    ).json()
    assert g["label"] == "代償觀察群" and g["w"] == 400
    patched = client.patch(
        f"/api/boards/{bd['id']}/groups/{g['id']}",
        json={"label": "肩頸代償群", "x": 30, "y": 40, "w": 450, "h": 320},
    ).json()
    assert patched["label"] == "肩頸代償群" and patched["x"] == 30 and patched["w"] == 450
    board_data = client.get(f"/api/boards/{bd['id']}").json()
    assert len(board_data["groups"]) == 1 and board_data["groups"][0]["id"] == g["id"]
    # 刪除分組框：卡片依然在白板上且卡片本體完好
    assert client.delete(f"/api/boards/{bd['id']}/groups/{g['id']}").status_code == 200
    board_after = client.get(f"/api/boards/{bd['id']}").json()
    assert board_after["groups"] == [] and len(board_after["cards"]) == 1


# Checkpoint 3：驗證全域概念圖譜共現計算、門檻過濾、鄰居上限，且不污染正式 links 表
def test_c3_concept_graph_cooccurrence_and_filters(client, api, db):
    t_thorax = client.post("/api/tags", json={"name": "胸廓", "axis": "concept", "facet": "解剖結構"}).json()
    t_inhale = client.post("/api/tags", json={"name": "吸氣", "axis": "concept", "facet": "功能／過程"}).json()
    t_neck = client.post("/api/tags", json={"name": "肩頸代償", "axis": "concept", "facet": "問題／現象"}).json()
    t_train = client.post("/api/tags", json={"name": "呼吸訓練", "axis": "concept", "facet": "方法／介入"}).json()

    # 卡片 A：胸廓、吸氣；卡片 B：胸廓、吸氣、肩頸代償；卡片 C：胸廓、呼吸訓練
    api.card("卡片A", tag_ids=[t_thorax["id"], t_inhale["id"]])
    api.card("卡片B", tag_ids=[t_thorax["id"], t_inhale["id"], t_neck["id"]])
    api.card("卡片C", tag_ids=[t_thorax["id"], t_train["id"]])

    # 門檻為 2 時，只有（胸廓, 吸氣）共現 2 次符合
    g2 = client.get("/api/graph/concepts", params={"min_cooccurrence": 2}).json()
    assert len(g2["nodes"]) == 4
    assert len(g2["edges"]) == 1
    assert g2["edges"][0]["co_count"] == 2
    assert {g2["edges"][0]["source_id"], g2["edges"][0]["target_id"]} == {t_thorax["id"], t_inhale["id"]}

    # 門檻為 1 但限制 max_neighbors=1 時，每個節點最多保留 1 條最強共現邊
    g_lim = client.get("/api/graph/concepts", params={"min_cooccurrence": 1, "max_neighbors": 1}).json()
    thorax_edges = [
        e for e in g_lim["edges"] if t_thorax["id"] in (e["source_id"], e["target_id"])
    ]
    assert len(thorax_edges) == 1 and thorax_edges[0]["co_count"] == 2

    # 共現計算只用於探索，絕不自動寫入正式 links 表
    assert db.execute("SELECT COUNT(*) FROM links").fetchone()[0] == 0
