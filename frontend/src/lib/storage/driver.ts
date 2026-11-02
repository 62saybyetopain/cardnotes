// @depends-on ../../types.ts
import type {
  BoardCard,
  BoardData,
  BoardGroup,
  BoardLink,
  BoardLiterature,
  BoardNote,
  BoardSummary,
  CardDetail,
  CardImpact,
  CardLiteratureRef,
  CardRelation,
  CardRelationPut,
  CardSummary,
  CardType,
  CleanupResult,
  ConceptGraphResponse,
  CurationStatus,
  DeletePreview,
  LinkStatus,
  Literature,
  LiteratureCollection,
  LiteratureDeleteImpact,
  LiteratureSummary,
  MediaInfo,
  RelationPattern,
  RelationPatternCreate,
  RelationPatternPatch,
  RelationsReport,
  RelationType,
  SyncApplyRequest,
  SyncApplyResult,
  SyncDiffReport,
  SyncPackage,
  Tag,
  TagResolveResponse,
  TagsResponse,
} from "../../types";

export interface StorageDriver {
  // 卡片操作
  createCard(tag_ids?: string[]): Promise<CardDetail>;
  getCard(id: string): Promise<CardDetail>;
  cardTitle(id: string): Promise<{ id: string; title: string }>;
  cardTitles(ids: string[]): Promise<{ titles: Record<string, string> }>;
  listAllCardTitles(): Promise<{ items: { id: string; title: string }[] }>;
  patchCard(
    id: string,
    patch: {
      title?: string;
      body?: string;
      card_type?: CardType;
      curation_status?: CurationStatus;
      sources?: string[];
      file_path?: string | null;
    },
    expected_updated_at: string,
  ): Promise<CardDetail>;
  cardImpact(id: string): Promise<CardImpact>;
  deleteCard(id: string): Promise<{ deleted: boolean }>;
  listCards(p: {
    q?: string;
    tag_id?: string;
    unclassified?: boolean;
    curation_status?: CurationStatus;
    card_type?: CardType;
    limit?: number;
  }): Promise<{ items: CardSummary[] }>;

  // 語意連結操作
  putLink(
    source_id: string,
    target_id: string,
    opts?: { relation_type?: RelationType; status?: LinkStatus; reason?: string },
  ): Promise<BoardLink & { existed: boolean }>;
  patchLink(
    source_id: string,
    target_id: string,
    patch: { old_relation_type?: RelationType; relation_type?: RelationType; status?: LinkStatus; reason?: string },
  ): Promise<BoardLink>;
  deleteLink(source_id: string, target_id: string, relation_type?: RelationType): Promise<{ deleted: boolean }>;

  // 標籤操作
  listTags(): Promise<TagsResponse>;
  createTag(
    name: string,
    axis: Tag["axis"],
    parent_id: string | null,
    extra?: { facet?: string | null; definition?: string },
  ): Promise<Tag>;
  patchTag(
    id: string,
    patch: { name?: string; facet?: string | null; definition?: string; parent_id?: string | null },
  ): Promise<Tag>;
  addTagAlias(tag_id: string, alias: string): Promise<Tag>;
  removeTagAlias(tag_id: string, alias: string): Promise<Tag>;
  resolveTag(query: string, axis?: Tag["axis"]): Promise<TagResolveResponse>;
  mergeTag(source_id: string, target_id: string): Promise<Tag>;
  deletePreview(id: string): Promise<DeletePreview>;
  deleteTag(id: string): Promise<{ deleted: boolean }>;
  assignTag(card_id: string, tag_id: string): Promise<{ existed: boolean }>;
  unassignTag(card_id: string, tag_id: string): Promise<{ removed: boolean }>;

  // 白板操作
  listBoards(): Promise<{ boards: BoardSummary[] }>;
  createBoard(name: string): Promise<BoardSummary>;
  renameBoard(id: string, name: string): Promise<{ id: string; name: string }>;
  deleteBoard(id: string): Promise<{ deleted: boolean }>;
  getBoard(id: string): Promise<BoardData>;
  addToBoard(board_id: string, card_id: string, x: number, y: number): Promise<Omit<BoardCard, "title" | "body" | "updated_at">>;
  patchBoardCards(board_id: string, items: { card_id: string; x: number; y: number; w?: number; h?: number }[]): Promise<{ updated: number }>;
  removeFromBoard(board_id: string, card_id: string): Promise<{ removed: boolean }>;
  createBoardGroup(board_id: string, body: { label?: string; x: number; y: number; w?: number; h?: number; color?: string }): Promise<BoardGroup>;
  patchBoardGroup(board_id: string, group_id: string, patch: { label?: string; x?: number; y?: number; w?: number; h?: number; color?: string }): Promise<BoardGroup>;
  deleteBoardGroup(board_id: string, group_id: string): Promise<{ deleted: boolean }>;
  createBoardNote(board_id: string, body: { text?: string; x: number; y: number; w?: number; h?: number; color?: string }): Promise<BoardNote>;
  patchBoardNote(board_id: string, note_id: string, patch: { text?: string; x?: number; y?: number; w?: number; h?: number; color?: string }): Promise<BoardNote>;
  deleteBoardNote(board_id: string, note_id: string): Promise<{ deleted: boolean }>;
  // 白板文獻節點（僅電腦端）：Dexie 端寫入丟 UNSUPPORTED_ON_DEXIE
  addLiteratureToBoard(board_id: string, body: { literature_id: string; x: number; y: number; w?: number; h?: number }): Promise<BoardLiterature>;
  patchBoardLiterature(board_id: string, literature_id: string, patch: { x?: number; y?: number; w?: number; h?: number }): Promise<BoardLiterature>;
  removeLiteratureFromBoard(board_id: string, literature_id: string): Promise<{ removed: boolean }>;

  // 同步、檔案與選取操作
  syncExport(): Promise<SyncPackage>;
  syncDiff(pkg: SyncPackage): Promise<SyncDiffReport>;
  syncApply(payload: SyncApplyRequest): Promise<SyncApplyResult>;
  importPackageOverwrite?(pkg: SyncPackage): Promise<{ imported: number }>;
  findLocalOnlyCards?(pkg: SyncPackage): Promise<{ id: string; title: string }[]>;
  pickSystemFile?(body: {
    mode?: "open" | "save";
    title?: string;
    initial_path?: string | null;
    default_name?: string;
    card_id?: string;
  }): Promise<{ cancelled: boolean; path: string | null }>;
  syncSaveToFile?(target_path: string): Promise<{ saved: boolean; path: string; exported_at: string }>;
  syncOverwrite?(pkg: SyncPackage): Promise<{ restored: boolean; cards_count: number }>;
  writeCardFile?(id: string, payload: { expected_updated_at: string; force?: boolean }): Promise<import("../../types").FileSyncResult>;
  readCardFile?(id: string): Promise<{ card: CardDetail; mtime: number; message: string }>;
  listCardFileBackups?(id: string): Promise<{ backups: { filename: string; time: string }[] }>;
  restoreCardFileBackup?(id: string, backup_filename?: string): Promise<{ card: CardDetail; mtime: number; message: string }>;

  // 媒體與全域圖譜
  uploadMedia?(file: File): Promise<MediaInfo>;
  mediaInfo?(id: string): Promise<MediaInfo>;
  cleanupMedia?(dry_run?: boolean): Promise<CleanupResult>;
  getConceptGraph?(p: { min_cooccurrence?: number; min_jaccard?: number; max_neighbors?: number; include_locations?: boolean }): Promise<ConceptGraphResponse>;

  // 關係句型與評估
  listRelationPatterns(): Promise<{ patterns: RelationPattern[] }>;
  createRelationPattern(body: RelationPatternCreate): Promise<RelationPattern>;
  patchRelationPattern(id: string, patch: RelationPatternPatch): Promise<RelationPattern>;
  deleteRelationPattern(id: string): Promise<{ deleted: boolean }>;
  getCardRelation(card_id: string): Promise<{ relation: CardRelation | null }>;
  putCardRelation(card_id: string, body: CardRelationPut): Promise<{ relation: CardRelation }>;
  deleteCardRelation(card_id: string): Promise<{ removed: boolean }>;
  getRelationsReport(): Promise<RelationsReport>;

  // 文獻庫（僅電腦端）：Dexie 端讀取回空、寫入丟 UNSUPPORTED_ON_DEXIE
  listLiterature(p: { q?: string; collection_id?: string; uncited?: boolean; limit?: number }): Promise<{ items: LiteratureSummary[] }>;
  createLiterature(body: { title?: string; body?: string; author?: string; url?: string; captured_on?: string; collection_id?: string }): Promise<Literature>;
  getLiterature(id: string): Promise<Literature>;
  patchLiterature(id: string, patch: { title?: string; body?: string; author?: string; url?: string; captured_on?: string }, expected_updated_at: string): Promise<Literature>;
  literatureDeletePreview(id: string): Promise<LiteratureDeleteImpact>;
  deleteLiterature(id: string): Promise<{ deleted: boolean }>;
  listLiteratureCollections(): Promise<{ collections: LiteratureCollection[] }>;
  createLiteratureCollection(name: string): Promise<LiteratureCollection>;
  renameLiteratureCollection(id: string, name: string): Promise<LiteratureCollection>;
  deleteLiteratureCollection(id: string): Promise<{ deleted: boolean }>;
  addLiteratureToCollection(collection_id: string, literature_id: string): Promise<{ existed: boolean }>;
  removeLiteratureFromCollection(collection_id: string, literature_id: string): Promise<{ removed: boolean }>;
  listCardLiterature(card_id: string): Promise<{ citations: CardLiteratureRef[] }>;
  putCardLiterature(card_id: string, body: { literature_id: string; locator?: string }): Promise<{ id: string; card_id: string; literature_id: string; locator: string; existed: boolean }>;
  patchLiteratureCitation(id: string, locator: string): Promise<{ id: string; locator: string }>;
  deleteLiteratureCitation(id: string): Promise<{ removed: boolean }>;
}

