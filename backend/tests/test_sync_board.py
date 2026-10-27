"""同步套用時的白板歸屬：新白板建立、方陣排版、不壓到既有卡片、重送冪等、不誤報。"""
import math
import uuid

from app.cards import DEFAULT_CARD_WIDTH, FALLBACK_CARD_HEIGHT

NOW = "2026-10-22T00:00:00Z"


def ipad_card(title="c"):
    return {"id": str(uuid.uuid4()), "title": title, "body": "", "created_at": NOW, "updated_at": NOW}


def placement(board_id, card_id):
    # iPad 端座標故意全給 (0, 0)：若實作沿用它們，所有卡片會疊在同一點
    return {"board_id": board_id, "card_id": card_id, "x": 0, "y": 0, "w": None, "h": None}


def payload(cards, boards, board_cards, add_ids=None):
    ids = [c["id"] for c in cards] if add_ids is None else add_ids
    return {
        "card_ids_to_add": ids,
        "board_cards_to_add": board_cards,
        "package": {
            "exported_at": NOW,
            "source_device": "ipad",
            "cards": cards,
            "boards": boards,
            "board_cards": board_cards,
        },
    }


def apply(client, body):
    r = client.post("/api/sync/apply", json=body)
    assert r.status_code == 200, r.text
    return r.json()["applied"]


def board_rows(db, board_id):
    return db.execute("SELECT * FROM board_cards WHERE board_id = ?", (board_id,)).fetchall()


def rect(r):
    return (r["x"], r["y"], r["x"] + (r["w"] or DEFAULT_CARD_WIDTH), r["y"] + (r["h"] or FALLBACK_CARD_HEIGHT))


def assert_no_overlap(rows):
    rects = [rect(r) for r in rows]
    for i, a in enumerate(rects):
        for b in rects[i + 1 :]:
            assert not (a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]), f"卡片重疊：{a} 與 {b}"


def test_new_ipad_board_is_created_with_cards_in_square_grid(client, db):
    """為什麼重要：iPad 的卡片冊匯入後要完整出現，而且卡片不能疊在一起而看不到。"""
    cards = [ipad_card(f"c{i}") for i in range(5)]
    bid = str(uuid.uuid4())
    body = payload(cards, [{"id": bid, "name": "iPad 卡片冊"}], [placement(bid, c["id"]) for c in cards])

    applied = apply(client, body)

    assert applied["boards_created"] == 1
    assert applied["board_cards_added"] == 5
    board = db.execute("SELECT * FROM boards WHERE id = ?", (bid,)).fetchone()
    assert board["name"] == "iPad 卡片冊"
    assert board["created_at"] and board["updated_at"]
    rows = board_rows(db, bid)
    assert len(rows) == 5
    assert len({r["x"] for r in rows}) == math.ceil(math.sqrt(5))  # 5 張 → 3 欄，接近正方形
    assert_no_overlap(rows)


def test_new_cards_go_below_existing_cards_without_covering_them(client, db, api):
    """為什麼重要：既有白板是使用者排好的成果，匯入不能蓋住或移動它。"""
    board = api.board("pc 白板")
    old = api.card("舊卡")
    api.to_board(board["id"], old["id"], x=500, y=300)
    cards = [ipad_card(f"c{i}") for i in range(4)]
    body = payload(cards, [], [placement(board["id"], c["id"]) for c in cards])

    applied = apply(client, body)

    assert applied["boards_created"] == 0
    rows = board_rows(db, board["id"])
    assert len(rows) == 5
    old_row = next(r for r in rows if r["card_id"] == old["id"])
    assert (old_row["x"], old_row["y"]) == (500, 300)
    assert_no_overlap(rows)
    new_rows = [r for r in rows if r["card_id"] != old["id"]]
    assert min(r["y"] for r in new_rows) >= rect(old_row)[3]


def test_resending_same_package_does_not_duplicate_or_relayout(client, db):
    """為什麼重要：同步可能因網路或誤按而重送，結果必須和只送一次相同。"""
    cards = [ipad_card(f"c{i}") for i in range(3)]
    bid = str(uuid.uuid4())
    body = payload(cards, [{"id": bid, "name": "b"}], [placement(bid, c["id"]) for c in cards])
    apply(client, body)
    before = {r["card_id"]: (r["x"], r["y"]) for r in board_rows(db, bid)}

    second = apply(client, body)

    assert second["boards_created"] == 0
    assert second["board_cards_added"] == 0
    assert {r["card_id"]: (r["x"], r["y"]) for r in board_rows(db, bid)} == before
    assert db.execute("SELECT COUNT(*) FROM boards WHERE id = ?", (bid,)).fetchone()[0] == 1


def test_board_missing_from_package_is_reported_not_silently_dropped(client, db):
    """為什麼重要：封包連白板資料都沒有時無從建立，必須讓使用者看到數字，而不是默默少一塊。"""
    cards = [ipad_card()]
    bid = str(uuid.uuid4())

    applied = apply(client, payload(cards, [], [placement(bid, cards[0]["id"])]))

    assert applied["board_cards_skipped"] == 1
    assert applied["board_cards_added"] == 0
    assert applied["boards_created"] == 0
    assert db.execute("SELECT 1 FROM cards WHERE id = ?", (cards[0]["id"],)).fetchone()  # 卡片本身照常匯入


def test_unchecked_card_neither_creates_board_nor_counts_as_skipped(client, db):
    """為什麼重要：使用者取消勾選是選擇，不能讓白板因此被建立，也不能被誤報成異常。"""
    cards = [ipad_card()]
    bid = str(uuid.uuid4())
    body = payload(cards, [{"id": bid, "name": "x"}], [placement(bid, cards[0]["id"])], add_ids=[])

    applied = apply(client, body)

    assert applied["boards_created"] == 0
    assert applied["board_cards_skipped"] == 0
    assert db.execute("SELECT 1 FROM boards WHERE id = ?", (bid,)).fetchone() is None