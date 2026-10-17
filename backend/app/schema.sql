-- 卡片／白板軟體 資料結構（SQLite）
-- 每個資料庫連線都必須執行這兩行，否則外鍵約束不會生效
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================
-- 卡片：內文為 Markdown。圖片與影片以 ![](media:<media.id>) 行內引用；
-- 內文是「這張卡片用了哪些媒體」的唯一真相，不另設使用清單表（避免兩處不同步）。
-- 卡片之間的連結不放在內文，只存在 links 表
-- card_type：卡片型態（untyped/concept/mechanism/hypothesis/method/case/source/question）
-- curation_status：整理狀態（inbox＝待整理收件夾、curated＝已整理）
-- source_system/source_id：記錄這張卡片是從外部資料庫的哪一筆複製來的，
-- 用來避免同一筆被重複複製、並能回頭查原始出處；兩者同時有值或同時為空。
-- 不需要追溯來源的話，這兩欄與 uq_cards_source 可整組刪掉
-- ============================================================
CREATE TABLE cards (
    id              TEXT PRIMARY KEY,                 -- UUID 字串
    title           TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    card_type       TEXT NOT NULL DEFAULT 'untyped'
                    CHECK (card_type IN ('untyped', 'concept', 'mechanism', 'hypothesis', 'method', 'case', 'source', 'question')),
    curation_status TEXT NOT NULL DEFAULT 'inbox'
                    CHECK (curation_status IN ('inbox', 'curated')),
    source_system   TEXT,
    source_id       TEXT,
    created_at      TEXT NOT NULL,                    -- ISO 8601 UTC
    updated_at      TEXT NOT NULL,
    CHECK ((source_system IS NULL) = (source_id IS NULL))
);
CREATE UNIQUE INDEX uq_cards_source
    ON cards (source_system, source_id) WHERE source_system IS NOT NULL;
CREATE INDEX idx_cards_curation ON cards (curation_status);
CREATE INDEX idx_cards_type ON cards (card_type);

-- ============================================================
-- 媒體：檔案放磁碟（以 sha256 命名去重），資料庫只存描述
-- 同一檔案可被多張卡片使用。孤兒＝id 沒有出現在任何卡片內文的媒體。
-- 只由「手動清理」功能刪除，不自動刪；清理時先列出清單讓人確認，
-- 並略過建立不到 24 小時的檔案（貼上圖片後、卡片尚未存檔時也會暫時像孤兒）
-- 內文引用了不存在的 media id 時，介面要顯示「圖片遺失」，不能顯示成空白
-- ============================================================
CREATE TABLE media (
    id          TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    mime        TEXT NOT NULL,
    rel_path    TEXT NOT NULL,                      -- 相對於媒體資料夾
    byte_size   INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    duration_ms INTEGER,                            -- 僅影片
    created_at  TEXT NOT NULL
);

-- ============================================================
-- 卡片連結（有向具名關係）：表達 source_id -> target_id 的明確語意關係
-- relation_type：support（支持）、refute（反駁）、influence（可能影響）、
--                instance_of（是……的實例）、applied_to（應用於）、extend（延伸／補充）
-- status：confirmed（已確認）、hypothesis（待驗證假說）；系統推薦在接受前不寫入此表
-- reason：連接理由（選填，說明為何兩張卡片存在此關係）
-- 以 (source_id, target_id, relation_type) 為複合主鍵，允許同對卡片具備不同類型關係
-- ============================================================
CREATE TABLE links (
    source_id     TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    target_id     TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'extend'
                  CHECK (relation_type IN ('support', 'refute', 'influence', 'instance_of', 'applied_to', 'extend')),
    status        TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed', 'hypothesis')),
    reason        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id, relation_type),
    CHECK (source_id <> target_id)
);
CREATE INDEX idx_links_target ON links (target_id);

-- ============================================================
-- 標籤（收納位置與概念標籤）：
-- axis：location（相容舊名 domain）＝收納位置（櫃子／抽屜／小格，樹狀，單一父節點）、
--       type＝類型軸（選填）、concept（相容舊名 free）＝概念標籤（扁平，無父節點，可附 facet 分面維度與 definition 定義）
-- 子節點的 axis 必須與父節點相同；移動節點時不可跨軸、不可移到自己的後代底下
--   → 這兩項由應用程式在交易內檢查，不在此處約束
-- parent_id 與 card_tags.tag_id 用 RESTRICT：直接 DELETE tags 會失敗，
-- 逼所有刪除都走下面的「刪除標籤程序」，避免默默留下錯誤狀態
-- ============================================================
CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    axis       TEXT NOT NULL CHECK (axis IN ('location', 'domain', 'type', 'concept', 'free')),
    facet      TEXT,
    definition TEXT NOT NULL DEFAULT '',
    parent_id  TEXT REFERENCES tags (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK (axis NOT IN ('free', 'concept') OR parent_id IS NULL)
);
-- SQLite 的 UNIQUE 把多個 NULL 視為不同，所以最上層與非最上層要分開約束
CREATE UNIQUE INDEX uq_tags_sibling
    ON tags (parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX uq_tags_root
    ON tags (axis, COALESCE(facet, ''), name) WHERE parent_id IS NULL;
CREATE INDEX idx_tags_parent ON tags (parent_id);

-- 標籤別名表：用於輸入自動解析、搜尋擴展與同義標籤合併後保留舊名稱
CREATE TABLE tag_aliases (
    alias      TEXT PRIMARY KEY COLLATE NOCASE,
    tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_tag_aliases_tag ON tag_aliases (tag_id);

-- 卡片只存放在最細的那一格；查上層時用遞迴查詢帶出所有後代，不重複儲存
CREATE TABLE card_tags (
    card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE RESTRICT,
    PRIMARY KEY (card_id, tag_id)
);
CREATE INDEX idx_card_tags_tag ON card_tags (tag_id);

-- ============================================================
-- 白板：只存「位置」，卡片本體不複製
-- 同一張卡片在同一塊白板只能出現一次
-- 從白板移除＝只刪 board_cards 那一列；刪卡片＝由外鍵連鎖刪除所有白板上的位置
-- ============================================================
CREATE TABLE boards (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE board_cards (
    board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    card_id  TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    x        REAL NOT NULL,
    y        REAL NOT NULL,
    w        REAL,
    h        REAL,
    z        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, card_id)
);
CREATE INDEX idx_board_cards_card ON board_cards (card_id);

-- 白板視覺分組框：僅負責白板上的空間視覺分組（表達「相關但未定義明確語意關係」），不冒充正式語意連結
CREATE TABLE board_groups (
    id         TEXT PRIMARY KEY,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT '',
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    w          REAL NOT NULL CHECK (w > 0),
    h          REAL NOT NULL CHECK (h > 0),
    color      TEXT NOT NULL DEFAULT 'slate',
    created_at TEXT NOT NULL
);
CREATE INDEX idx_board_groups_board ON board_groups (board_id);

-- ============================================================
-- 刪除標籤程序（應用程式，必須在同一個交易內完成）
--   1. 若有同名衝突（子節點上移後會與新父節點底下既有節點同名）→ 中止並要求先改名
--   2. 子節點：UPDATE tags SET parent_id = <被刪節點的 parent_id> WHERE parent_id = <被刪節點>
--   3. 若被刪節點有父節點：
--        INSERT OR IGNORE INTO card_tags 把它的卡片改歸屬到父節點
--      若沒有父節點（最上層櫃子，或 concept/free 標籤）：不補歸屬
--   4. DELETE FROM card_tags WHERE tag_id = <被刪節點>
--   5. DELETE FROM tags WHERE id = <被刪節點>
--
-- 「未分類（未歸檔）」不是儲存的節點，而是查詢結果：
--   沒有任何 axis IN ('location', 'domain') 標籤歸屬的卡片
-- ============================================================