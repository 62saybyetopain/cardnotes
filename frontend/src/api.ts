import type {
  BoardCard,
  BoardData,
  BoardGroup,
  BoardLink,
  BoardSummary,
  CardDetail,
  CardImpact,
  CardRelation,
  CardRelationPut,
  CardSummary,
  CardType,
  CleanupResult,
  ConceptGraphResponse,
  CurationStatus,
  DeletePreview,
  LinkStatus,
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
} from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, any>;
  constructor(code: string, message: string, status: number, details: Record<string, any> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// 所有 API 呼叫都經過這裡：非 2xx 一律丟出 ApiError，不允許靜默失敗
async function request<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", "無法連線到伺服器", 0);
  }
  if (!res.ok) {
    let payload: any = null;
    try {
      payload = await res.json();
    } catch {
      /* 非 JSON 錯誤回應 */
    }
    const e = payload?.error;
    throw new ApiError(e?.code ?? "UNKNOWN_ERROR", e?.message ?? `請求失敗（${res.status}）`, res.status, e?.details ?? {});
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const httpApi = {
  // cards
  createCard: (tag_ids: string[] = []) => request<CardDetail>("POST", "/cards", { title: "", body: "", tag_ids }),
  getCard: (id: string) => request<CardDetail>("GET", `/cards/${id}`),
  cardTitle: (id: string) => request<{ id: string; title: string }>("GET", `/cards/${id}/title`),
  cardTitles: (ids: string[]) =>
    request<{ titles: Record<string, string> }>("GET", `/cards/titles${qs({ ids: ids.join(",") })}`),
  listAllCardTitles: () => request<{ items: { id: string; title: string }[] }>("GET", "/cards/titles/all"),
  patchCard: (
    id: string,
    patch: { title?: string; body?: string; card_type?: CardType; curation_status?: CurationStatus; sources?: string[]; file_path?: string | null },
    expected_updated_at: string,
  ) => request<CardDetail>("PATCH", `/cards/${id}`, { ...patch, expected_updated_at }),
  writeCardFile: (id: string, payload: { expected_updated_at: string; force?: boolean }) =>
    request<import("./types").FileSyncResult>("POST", `/cards/${id}/file/write`, payload),
  readCardFile: (id: string) =>
    request<{ card: CardDetail; mtime: number; message: string }>("POST", `/cards/${id}/file/read`),
  restoreCardFileBackup: (id: string) =>
    request<{ card: CardDetail; mtime: number; message: string }>("POST", `/cards/${id}/file/restore`),
  cardImpact: (id: string) => request<CardImpact>("GET", `/cards/${id}/impact`),
  deleteCard: (id: string) => request<{ deleted: boolean }>("DELETE", `/cards/${id}`),
  listCards: (p: {
    q?: string;
    tag_id?: string;
    unclassified?: boolean;
    curation_status?: CurationStatus;
    card_type?: CardType;
    limit?: number;
  }) => request<{ items: CardSummary[] }>("GET", `/cards${qs(p)}`),
  // links
  putLink: (
    source_id: string,
    target_id: string,
    opts?: { relation_type?: RelationType; status?: LinkStatus; reason?: string },
  ) =>
    request<BoardLink & { existed: boolean }>("PUT", "/links", {
      source_id,
      target_id,
      relation_type: opts?.relation_type ?? "延伸",
      status: opts?.status ?? "confirmed",
      reason: opts?.reason ?? "",
    }),
  patchLink: (
    source_id: string,
    target_id: string,
    patch: { old_relation_type?: RelationType; relation_type?: RelationType; status?: LinkStatus; reason?: string },
  ) => request<BoardLink>("PATCH", `/links/${source_id}/${target_id}`, patch),
  deleteLink: (source_id: string, target_id: string, relation_type?: RelationType) =>
    request<{ deleted: boolean }>("DELETE", `/links/${source_id}/${target_id}${qs({ relation_type })}`),
  // tags
  listTags: () => request<TagsResponse>("GET", "/tags"),
  createTag: (
    name: string,
    axis: Tag["axis"],
    parent_id: string | null,
    extra?: { facet?: string | null; definition?: string },
  ) => request<Tag>("POST", "/tags", { name, axis, parent_id, ...extra }),
  patchTag: (
    id: string,
    patch: { name?: string; facet?: string | null; definition?: string; parent_id?: string | null },
  ) => request<Tag>("PATCH", `/tags/${id}`, patch),
  addTagAlias: (tag_id: string, alias: string) =>
    request<Tag>("POST", `/tags/${tag_id}/aliases`, { alias }),
  removeTagAlias: (tag_id: string, alias: string) =>
    request<Tag>("DELETE", `/tags/${tag_id}/aliases/${encodeURIComponent(alias)}`),
  resolveTag: (query: string, axis?: Tag["axis"]) =>
    request<TagResolveResponse>("POST", "/tags/resolve", { query, axis }),
  mergeTag: (source_id: string, target_id: string) =>
    request<Tag>("POST", `/tags/${source_id}/merge`, { target_id }),
  deletePreview: (id: string) => request<DeletePreview>("GET", `/tags/${id}/delete-preview`),
  deleteTag: (id: string) => request<{ deleted: boolean }>("DELETE", `/tags/${id}`),
  assignTag: (card_id: string, tag_id: string) => request<{ existed: boolean }>("PUT", `/cards/${card_id}/tags/${tag_id}`),
  unassignTag: (card_id: string, tag_id: string) => request<{ removed: boolean }>("DELETE", `/cards/${card_id}/tags/${tag_id}`),
  getConceptGraph: (p: {
    min_cooccurrence?: number;
    min_jaccard?: number;
    max_neighbors?: number;
    include_locations?: boolean;
  }) => request<ConceptGraphResponse>("GET", `/graph/concepts${qs(p)}`),
  // boards
  listBoards: () => request<{ boards: BoardSummary[] }>("GET", "/boards"),
  createBoard: (name: string) => request<BoardSummary>("POST", "/boards", { name }),
  renameBoard: (id: string, name: string) => request<{ id: string; name: string }>("PATCH", `/boards/${id}`, { name }),
  deleteBoard: (id: string) => request<{ deleted: boolean }>("DELETE", `/boards/${id}`),
  getBoard: (id: string) => request<BoardData>("GET", `/boards/${id}`),
  addToBoard: (board_id: string, card_id: string, x: number, y: number) =>
    request<Omit<BoardCard, "title" | "body" | "updated_at">>("POST", `/boards/${board_id}/cards`, { card_id, x, y }),
  patchBoardCards: (board_id: string, items: { card_id: string; x: number; y: number; w?: number; h?: number }[]) =>
    request<{ updated: number }>("PATCH", `/boards/${board_id}/cards`, { items }),
  removeFromBoard: (board_id: string, card_id: string) =>
    request<{ removed: boolean }>("DELETE", `/boards/${board_id}/cards/${card_id}`),
  createBoardGroup: (
    board_id: string,
    body: { label?: string; x: number; y: number; w?: number; h?: number; color?: string },
  ) => request<BoardGroup>("POST", `/boards/${board_id}/groups`, body),
  patchBoardGroup: (
    board_id: string,
    group_id: string,
    patch: { label?: string; x?: number; y?: number; w?: number; h?: number; color?: string },
  ) => request<BoardGroup>("PATCH", `/boards/${board_id}/groups/${group_id}`, patch),
  deleteBoardGroup: (board_id: string, group_id: string) =>
    request<{ deleted: boolean }>("DELETE", `/boards/${board_id}/groups/${group_id}`),
  // media
  uploadMedia: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<MediaInfo>("POST", "/media", undefined, form);
  },
  mediaInfo: (id: string) => request<MediaInfo>("GET", `/media/${id}/info`),
  cleanupMedia: (dry_run = true) => request<CleanupResult>("POST", `/media/cleanup?dry_run=${dry_run}`),
  // sync
  syncExport: () => request<SyncPackage>("GET", "/sync/export"),
  syncDiff: (pkg: SyncPackage) => request<SyncDiffReport>("POST", "/sync/diff", pkg),
  syncApply: (payload: SyncApplyRequest) => request<SyncApplyResult>("POST", "/sync/apply", payload),
  syncOverwrite: (pkg: SyncPackage) => request<{ restored: boolean; cards_count: number }>("POST", "/sync/overwrite", pkg),
  syncSaveToFile: (target_path: string) => request<{ saved: boolean; path: string; exported_at: string }>("POST", "/sync/save-file", { target_path }),
  pickSystemFile: (body: {
    mode?: "open" | "save";
    title?: string;
    initial_path?: string | null;
    default_name?: string;
  }) => request<{ cancelled: boolean; path: string | null }>("POST", "/system/pick-file", body),
  // relations
  listRelationPatterns: () => request<{ patterns: RelationPattern[] }>("GET", "/relation-patterns"),
  createRelationPattern: (body: RelationPatternCreate) =>
    request<RelationPattern>("POST", "/relation-patterns", body),
  patchRelationPattern: (id: string, patch: RelationPatternPatch) =>
    request<RelationPattern>("PATCH", `/relation-patterns/${id}`, patch),
  deleteRelationPattern: (id: string) =>
    request<{ deleted: boolean }>("DELETE", `/relation-patterns/${id}`),
  getCardRelation: (card_id: string) =>
    request<{ relation: CardRelation | null }>("GET", `/cards/${card_id}/relation`),
  putCardRelation: (card_id: string, body: CardRelationPut) =>
    request<{ relation: CardRelation }>("PUT", `/cards/${card_id}/relation`, body),
  deleteCardRelation: (card_id: string) =>
    request<{ removed: boolean }>("DELETE", `/cards/${card_id}/relation`),
  getRelationsReport: () => request<RelationsReport>("GET", "/relations/report"),
};

import { getStorageDriver } from "./lib/storage";

// 只有這些桌面專屬方法允許在 driver 沒實作時退回 httpApi（打後端）。
// 原因：其餘方法若退回，Dexie 模式會悄悄讀寫伺服器資料而不是 IndexedDB，資料語義錯了卻沒有任何錯誤。
// 純靜態前端環境下，driver 必須自行提供明確存根以拋出錯誤，絕不允許靜默退回必定失敗的網路請求
const DESKTOP_ONLY_FALLBACK: ReadonlySet<string> = new Set([]);

export const api: typeof httpApi = new Proxy(httpApi, {
  get(target, prop, receiver) {
    const driver = getStorageDriver();
    let val = Reflect.get(driver, prop);
    if (val === undefined || val === null) {
      val = Reflect.get(target, prop, receiver);
      if (val !== undefined && !(typeof prop === "string" && DESKTOP_ONLY_FALLBACK.has(prop))) {
        const method = String(prop);
        return () =>
          Promise.reject(new ApiError("DRIVER_METHOD_MISSING", `目前的儲存驅動沒有實作 ${method}`, 501, { method }));
      }
    }
    return typeof val === "function" ? val.bind(driver) : val;
  },
});
