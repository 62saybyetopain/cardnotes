// @depends-on ../../types.ts
import Dexie, { type Table } from "dexie";
import type {
  Axis,
  BoardGroup,
  CardType,
  CurationStatus,
} from "../../types";

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

export class CardboardDatabase extends Dexie {
  cards!: Table<DbCard, string>;
  tags!: Table<DbTag, string>;
  tag_aliases!: Table<DbTagAlias, number>;
  card_tags!: Table<DbCardTag, number>;
  links!: Table<DbLink, number>;
  boards!: Table<DbBoard, string>;
  board_cards!: Table<DbBoardCard, number>;
  board_groups!: Table<BoardGroup, string>;
  media!: Table<DbMedia, string>;

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
  }
}

export const db = new CardboardDatabase();