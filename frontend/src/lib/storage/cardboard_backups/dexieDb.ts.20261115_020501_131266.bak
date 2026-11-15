// @depends-on ../../types.ts
// @depends-on ../relations.ts (upgradeLinkRelation)
import Dexie, { type Table } from "dexie";
import type {
  Axis,
  BoardGroup,
  BoardNote,
  CardType,
  CurationStatus,
} from "../../types";
import { upgradeLinkRelation } from "../relations";

export interface DbCard {
  id: string;
  title: string;
  body: string;
  card_type: CardType;
  curation_status: CurationStatus;
  created_at: string;
  updated_at: string;
  sources?: string[]; // 非索引欄位，Dexie 不需要升版；舊資料沒有此欄
}

export interface DbTag {
  id: string;
  name: string;
  axis: Axis;
  facet: string | null;
  definition: string;
  parent_id: string | null;
}

export interface DbTagAlias {
  id?: number;
  tag_id: string;
  alias: string;
}

export interface DbCardTag {
  id?: number;
  card_id: string;
  tag_id: string;
}

export interface DbBoard {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
}

export interface DbBoardCard {
  id?: number;
  board_id: string;
  card_id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  z: number;
}

export interface DbLink {
  id?: number;
  source_id: string;
  target_id: string;
  relation_type: string;
  status: string;
  reason: string;
}

export interface DbMedia {
  id: string;
  kind: "image" | "video";
  mime: string;
  byte_size: number;
  data_blob: Blob;
  created_at: string;
}

export interface DbSyncMeta {
  key: string;
  value: unknown;
}

export class CardboardDatabase extends Dexie {
  cards!: Table<DbCard, string>;
  tags!: Table<DbTag, string>;
  tag_aliases!: Table<DbTagAlias, number>;
  card_tags!: Table<DbCardTag, number>;
  links!: Table<DbLink, number>;
  boards!: Table<DbBoard, string>;
  board_cards!: Table<DbBoardCard, number>;
  board_groups!: Table<BoardGroup, string>;
  board_notes!: Table<BoardNote, string>;
  media!: Table<DbMedia, string>;
  sync_meta!: Table<DbSyncMeta, string>;

  constructor() {
    super("cardboard_db");
    this.version(1).stores({
      cards: "id, updated_at, card_type, curation_status",
      tags: "id, axis, parent_id, name",
      tag_aliases: "++id, tag_id, alias",
      card_tags: "++id, card_id, tag_id, [card_id+tag_id]",
      links: "++id, source_id, target_id, relation_type, [source_id+target_id+relation_type]",
      boards: "id, name",
      board_cards: "++id, board_id, card_id, [board_id+card_id]",
      board_groups: "id, board_id",
      media: "id, kind, created_at",
    });
    // v2：links.relation_type 改用知識庫分類表的值（extend→延伸、support→支持…；舊的 influence 降為待驗證假說）。
    // 索引不變，只轉資料；已是新值的連結原樣保留；不認得的值丟錯讓升級失敗，不靜默改成別的類型。
    this.version(2)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table("links")
          .toCollection()
          .modify((l: DbLink) => {
            const up = upgradeLinkRelation(l.relation_type, l.status);
            l.relation_type = up.relation_type;
            l.status = up.status ?? "confirmed";
          });
      });
    // v3：新增白板便利貼資料表（只加表，不動既有資料）
    this.version(3).stores({
      board_notes: "id, board_id",
    });
    // v4：cards 加 [title+id] 複合索引，讓 listAllCardTitles 只讀索引鍵、不載入內文。
    // 只加索引不轉資料，不需要 upgrade；stores 必須完整重寫 cards 既有的索引字串。
    // @depends-on indexedDbDriver.ts::listAllCardTitles（orderBy("[title+id]")，索引改名或移除時一起改）
    this.version(4).stores({
      cards: "id, updated_at, card_type, curation_status, [title+id]",
    });
    // v5：新增 sync_meta 存放同步基準線，確保與卡片資料同存於 IndexedDB，不會因 Safari 單獨清理 localStorage 而遺失
    this.version(5).stores({
      sync_meta: "key",
    });
  }
}

export const db = new CardboardDatabase();