// @depends-on ../../types.ts
import type {
  BoardCard,
  BoardData,
  BoardGroup,
  BoardLink,
  BoardSummary,
  CardDetail,
  CardImpact,
  CardSummary,
  CardType,
  CleanupResult,
  ConceptGraphResponse,
  CurationStatus,
  DeletePreview,
  LinkStatus,
  MediaInfo,
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
  patchCard(
    id: string,
    patch: { title?: string; body?: string; card_type?: CardType; curation_status?: CurationStatus },
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

  // 同步與維護
  syncExport(): Promise<SyncPackage>;
  syncDiff(pkg: SyncPackage): Promise<SyncDiffReport>;
  syncApply(payload: SyncApplyRequest): Promise<SyncApplyResult>;
  importPackageOverwrite?(pkg: SyncPackage): Promise<{ imported: number }>;

  // 媒體與全域圖譜（本地端提供相容實作）
  uploadMedia?(file: File): Promise<MediaInfo>;
  mediaInfo?(id: string): Promise<MediaInfo>;
  cleanupMedia?(dry_run?: boolean): Promise<CleanupResult>;
  getConceptGraph?(p: { min_cooccurrence?: number; min_jaccard?: number; max_neighbors?: number; include_locations?: boolean }): Promise<ConceptGraphResponse>;
}