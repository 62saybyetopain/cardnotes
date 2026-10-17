// @depends-on ./driver.ts
// @depends-on ./dexieDb.ts
// @depends-on ../../types.ts
import { ApiError } from "../../api";
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
import { db, type DbBoardCard, type DbCard } from "./dexieDb";
import type { StorageDriver } from "./driver";

function utcNow(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
}

const CARD_REF_RE = /(?<!!)\[(?:\\.|[^\[\]\\])*\]\(card:([0-9a-fA-F-]{36})\)/g;

function getCardRefs(body: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = CARD_REF_RE.exec(body)) !== null) {
    matches.push(m[1].toLowerCase());
  }
  return Array.from(new Set(matches));
}

function makeSnippet(body: string, q?: string): string {
  if (q) {
    const idx = body.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      return (start > 0 ? "…" : "") + body.slice(start, idx + 120);
    }
  }
  return body.slice(0, 160);
}

export class IndexedDbDriver implements StorageDriver {
  // ---- 標籤樹後代尋找（對齊後端 descendant_ids） ----
  private async getDescendantIds(tagId: string): Promise<Set<string>> {
    const allTags = await db.tags.toArray();
    const result = new Set<string>([tagId]);
    let added = true;
    while (added) {
      added = false;
      for (const t of allTags) {
        if (t.parent_id && result.has(t.parent_id) && !result.has(t.id)) {
          result.add(t.id);
          added = true;
        }
      }
    }
    return result;
  }

  private async buildTagDict(tagId: string): Promise<Tag> {
    const t = await db.tags.get(tagId);
    if (!t) throw new ApiError("NOT_FOUND", "標籤不存在", 404, { tag_id: tagId });
    const aliases = (await db.tag_aliases.where("tag_id").equals(tagId).toArray()).map((a) => a.alias);
    return {
      id: t.id,
      name: t.name,
      axis: t.axis,
      facet: t.facet,
      definition: t.definition || "",
      parent_id: t.parent_id,
      aliases,
    };
  }

  // ---- 卡片 CRUD ----
  async createCard(tag_ids: string[] = []): Promise<CardDetail> {
    const now = utcNow();
    const cid = newId();
    const card: DbCard = {
      id: cid,
      title: "",
      body: "",
      card_type: "untyped",
      curation_status: "inbox",
      created_at: now,
      updated_at: now,
    };

    await db.transaction("rw", [db.cards, db.card_tags, db.tags], async () => {
      for (const tid of tag_ids) {
        const exists = await db.tags.get(tid);
        if (!exists) throw new ApiError("NOT_FOUND", "標籤不存在", 404, { tag_id: tid });
      }
      await db.cards.add(card);
      for (const tid of tag_ids) {
        await db.card_tags.add({ card_id: cid, tag_id: tid });
      }
    });

    return this.getCard(cid);
  }

  async getCard(id: string): Promise<CardDetail> {
    const c = await db.cards.get(id);
    if (!c) throw new ApiError("NOT_FOUND", "卡片不存在", 404, { card_id: id });

    // 取得關聯標籤
    const cts = await db.card_tags.where("card_id").equals(id).toArray();
    const tags: Tag[] = [];
    for (const ct of cts) {
      const td = await this.buildTagDict(ct.tag_id).catch(() => null);
      if (td) tags.push(td);
    }
    tags.sort((a, b) => a.axis.localeCompare(b.axis) || a.name.localeCompare(b.name));

    // 取得雙向關聯語意連結
    const outgoing = await db.links.where("source_id").equals(id).toArray();
    const incoming = await db.links.where("target_id").equals(id).toArray();
    const links: CardDetail["links"] = [];

    for (const l of outgoing) {
      const other = await db.cards.get(l.target_id);
      if (other) {
        links.push({
          id: other.id,
          title: other.title,
          source_id: id,
          target_id: other.id,
          direction: "outgoing",
          relation_type: l.relation_type as RelationType,
          status: l.status as LinkStatus,
          reason: l.reason,
        });
      }
    }
    for (const l of incoming) {
      const other = await db.cards.get(l.source_id);
      if (other) {
        links.push({
          id: other.id,
          title: other.title,
          source_id: other.id,
          target_id: id,
          direction: "incoming",
          relation_type: l.relation_type as RelationType,
          status: l.status as LinkStatus,
          reason: l.reason,
        });
      }
    }

    // 取得所在白板清單
    const bcs = await db.board_cards.where("card_id").equals(id).toArray();
    const boards: { id: string; name: string }[] = [];
    for (const bc of bcs) {
      const b = await db.boards.get(bc.board_id);
      if (b) boards.push({ id: b.id, name: b.name });
    }

    // 檢查遺失卡片引用
    const refs = getCardRefs(c.body);
    const missingCardIds: string[] = [];
    for (const refId of refs) {
      const exists = await db.cards.get(refId);
      if (!exists) missingCardIds.push(refId);
    }

    const warnings: CardDetail["warnings"] = [];
    if (missingCardIds.length > 0) {
      warnings.push({ code: "MISSING_CARD", ids: missingCardIds });
    }

    return {
      ...c,
      tags,
      links,
      boards,
      warnings,
    };
  }

  async cardTitle(id: string): Promise<{ id: string; title: string }> {
    const c = await db.cards.get(id);
    if (!c) throw new ApiError("NOT_FOUND", "卡片不存在", 404, { card_id: id });
    return { id: c.id, title: c.title };
  }

  async cardTitles(ids: string[]): Promise<{ titles: Record<string, string> }> {
    const map: Record<string, string> = {};
    for (const id of ids) {
      const c = await db.cards.get(id);
      if (c) map[c.id] = c.title;
    }
    return { titles: map };
  }

  async patchCard(
    id: string,
    patch: { title?: string; body?: string; card_type?: CardType; curation_status?: CurationStatus },
    expected_updated_at: string,
  ): Promise<CardDetail> {
    const c = await db.cards.get(id);
    if (!c) throw new ApiError("NOT_FOUND", "卡片不存在", 404, { card_id: id });
    if (c.updated_at !== expected_updated_at) {
      const current = await this.getCard(id);
      throw new ApiError("STALE_VERSION", "這張卡片已在別處被修改，請重新載入後再儲存", 409, { current });
    }

    const updated: DbCard = {
      ...c,
      title: patch.title !== undefined ? patch.title : c.title,
      body: patch.body !== undefined ? patch.body : c.body,
      card_type: patch.card_type !== undefined ? patch.card_type : c.card_type,
      curation_status: patch.curation_status !== undefined ? patch.curation_status : c.curation_status,
      updated_at: utcNow(),
    };

    await db.cards.put(updated);
    return this.getCard(id);
  }

  async cardImpact(id: string): Promise<CardImpact> {
    const c = await db.cards.get(id);
    if (!c) throw new ApiError("NOT_FOUND", "卡片不存在", 404, { card_id: id });
    const bcs = await db.board_cards.where("card_id").equals(id).toArray();
    const boardNames: string[] = [];
    for (const bc of bcs) {
      const b = await db.boards.get(bc.board_id);
      if (b) boardNames.push(b.name);
    }
    const linkCount = await db.links
      .filter((l) => l.source_id === id || l.target_id === id)
      .count();
    return {
      board_count: boardNames.length,
      board_names: boardNames,
      link_count: linkCount,
    };
  }

  async deleteCard(id: string): Promise<{ deleted: boolean }> {
    const impact = await this.cardImpact(id);
    await db.transaction("rw", [db.cards, db.card_tags, db.links, db.board_cards], async () => {
      await db.cards.delete(id);
      await db.card_tags.where("card_id").equals(id).delete();
      await db.links.filter((l) => l.source_id === id || l.target_id === id).delete();
      await db.board_cards.where("card_id").equals(id).delete();
    });
    return { deleted: true, ...impact };
  }

  async listCards(p: {
    q?: string;
    tag_id?: string;
    unclassified?: boolean;
    curation_status?: CurationStatus;
    card_type?: CardType;
    limit?: number;
  }): Promise<{ items: CardSummary[] }> {
    let collection = db.cards.toCollection();

    // 狀態過濾
    if (p.curation_status) {
      collection = db.cards.where("curation_status").equals(p.curation_status);
    }
    let all = await collection.sortBy("updated_at");
    all.reverse();

    if (p.card_type) {
      all = all.filter((c) => c.card_type === p.card_type);
    }

    // 標籤篩選（含子標籤遞迴）
    if (p.tag_id) {
      const descendants = await this.getDescendantIds(p.tag_id);
      const matchingCts = await db.card_tags.filter((ct) => descendants.has(ct.tag_id)).toArray();
      const cardIdSet = new Set(matchingCts.map((ct) => ct.card_id));
      all = all.filter((c) => cardIdSet.has(c.id));
    }

    // 未分類（無 location / domain 標籤）
    if (p.unclassified) {
      const locationTags = await db.tags.filter((t) => t.axis === "location" || (t.axis as string) === "domain").toArray();
      const locTagIdSet = new Set(locationTags.map((t) => t.id));
      const classifiedCts = await db.card_tags.filter((ct) => locTagIdSet.has(ct.tag_id)).toArray();
      const classifiedCardIdSet = new Set(classifiedCts.map((ct) => ct.card_id));
      all = all.filter((c) => !classifiedCardIdSet.has(c.id));
    }

    // 關鍵字檢索（比對標題、內文、標籤名稱或別名）
    const q = p.q?.trim().toLowerCase();
    if (q) {
      const matchingTags = await db.tags.filter((t) => t.name.toLowerCase().includes(q)).toArray();
      const matchingAliases = await db.tag_aliases.filter((a) => a.alias.toLowerCase().includes(q)).toArray();
      const matchTagIdSet = new Set([
        ...matchingTags.map((t) => t.id),
        ...matchingAliases.map((a) => a.tag_id),
      ]);
      const cardIdsWithMatchingTag = new Set(
        (await db.card_tags.filter((ct) => matchTagIdSet.has(ct.tag_id)).toArray()).map((ct) => ct.card_id),
      );

      all = all.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.body.toLowerCase().includes(q) ||
          cardIdsWithMatchingTag.has(c.id),
      );
    }

    const limit = Math.min(200, Math.max(1, p.limit ?? 50));
    const sliced = all.slice(0, limit);

    const items: CardSummary[] = [];
    for (const c of sliced) {
      const cts = await db.card_tags.where("card_id").equals(c.id).toArray();
      const tagItems: NonNullable<CardSummary["tags"]> = [];
      for (const ct of cts) {
        const t = await db.tags.get(ct.tag_id);
        if (t) tagItems.push({ id: t.id, name: t.name, axis: t.axis, facet: t.facet });
      }
      items.push({
        id: c.id,
        title: c.title,
        snippet: makeSnippet(c.body, q),
        card_type: c.card_type,
        curation_status: c.curation_status,
        tags: tagItems,
        updated_at: c.updated_at,
      });
    }

    return { items };
  }

  // ---- 語意連結 ----
  async putLink(
    source_id: string,
    target_id: string,
    opts?: { relation_type?: RelationType; status?: LinkStatus; reason?: string },
  ): Promise<BoardLink & { existed: boolean }> {
    const relation_type = opts?.relation_type ?? "extend";
    const status = opts?.status ?? "confirmed";
    const reason = opts?.reason ?? "";

    const existing = await db.links
      .filter((l) => l.source_id === source_id && l.target_id === target_id && l.relation_type === relation_type)
      .first();

    if (existing) {
      return {
        source_id,
        target_id,
        card_a: source_id,
        card_b: target_id,
        relation_type,
        status: existing.status as LinkStatus,
        reason: existing.reason,
        existed: true,
      };
    }

    await db.links.add({ source_id, target_id, relation_type, status, reason });
    return {
      source_id,
      target_id,
      card_a: source_id,
      card_b: target_id,
      relation_type,
      status,
      reason,
      existed: false,
    };
  }

  async patchLink(
    source_id: string,
    target_id: string,
    patch: { old_relation_type?: RelationType; relation_type?: RelationType; status?: LinkStatus; reason?: string },
  ): Promise<BoardLink> {
    const oldRel = patch.old_relation_type ?? "extend";
    const match = await db.links
      .filter((l) => l.source_id === source_id && l.target_id === target_id && l.relation_type === oldRel)
      .first();

    if (!match || match.id === undefined) {
      throw new ApiError("NOT_FOUND", "找不到此連結", 404);
    }

    const nextRel = patch.relation_type ?? oldRel;
    const nextStatus = patch.status ?? match.status;
    const nextReason = patch.reason !== undefined ? patch.reason : match.reason;

    await db.links.update(match.id, {
      relation_type: nextRel,
      status: nextStatus,
      reason: nextReason,
    });

    return {
      source_id,
      target_id,
      card_a: source_id,
      card_b: target_id,
      relation_type: nextRel as RelationType,
      status: nextStatus as LinkStatus,
      reason: nextReason,
    };
  }

  async deleteLink(source_id: string, target_id: string, relation_type?: RelationType): Promise<{ deleted: boolean }> {
    await db.links
      .filter(
        (l) =>
          l.source_id === source_id &&
          l.target_id === target_id &&
          (!relation_type || l.relation_type === relation_type),
      )
      .delete();
    return { deleted: true };
  }

  // ---- 標籤 CRUD ----
  async listTags(): Promise<TagsResponse> {
    const rawTags = await db.tags.toArray();
    const tags: Tag[] = [];
    for (const t of rawTags) {
      tags.push(await this.buildTagDict(t.id));
    }
    tags.sort((a, b) => a.axis.localeCompare(b.axis) || a.name.localeCompare(b.name));

    // 計算未歸檔卡片數
    const locTags = tags.filter((t) => t.axis === "location" || (t.axis as string) === "domain");
    const locTagIdSet = new Set(locTags.map((t) => t.id));
    const classifiedCts = await db.card_tags.filter((ct) => locTagIdSet.has(ct.tag_id)).toArray();
    const classifiedCardIdSet = new Set(classifiedCts.map((ct) => ct.card_id));
    const totalCards = await db.cards.count();
    const unclassified_count = totalCards - classifiedCardIdSet.size;
    const inbox_count = await db.cards.where("curation_status").equals("inbox").count();

    return { tags, unclassified_count, inbox_count };
  }

  async createTag(
    name: string,
    axis: Tag["axis"],
    parent_id: string | null,
    extra?: { facet?: string | null; definition?: string },
  ): Promise<Tag> {
    const tid = newId();
    const cleanName = name.trim();
    const conflict = await db.tags
      .filter((t) => t.axis === axis && t.parent_id === parent_id && t.name.toLowerCase() === cleanName.toLowerCase())
      .first();
    if (conflict) {
      throw new ApiError("NAME_CONFLICT", `同一層已有名為「${cleanName}」的標籤`, 409, { names: [cleanName] });
    }

    await db.tags.add({
      id: tid,
      name: cleanName,
      axis,
      facet: extra?.facet ?? null,
      definition: extra?.definition?.trim() ?? "",
      parent_id,
    });
    return this.buildTagDict(tid);
  }

  async patchTag(
    id: string,
    patch: { name?: string; facet?: string | null; definition?: string; parent_id?: string | null },
  ): Promise<Tag> {
    const t = await db.tags.get(id);
    if (!t) throw new ApiError("NOT_FOUND", "標籤不存在", 404, { tag_id: id });

    const newName = patch.name !== undefined ? patch.name.trim() : t.name;
    const newParent = patch.parent_id !== undefined ? patch.parent_id : t.parent_id;

    if (newParent !== t.parent_id && newParent !== null) {
      const descendants = await this.getDescendantIds(id);
      if (descendants.has(newParent)) {
        throw new ApiError("CYCLE_DETECTED", "不能把標籤移到它自己或它的後代底下", 409);
      }
    }

    await db.tags.update(id, {
      name: newName,
      facet: patch.facet !== undefined ? patch.facet : t.facet,
      definition: patch.definition !== undefined ? patch.definition.trim() : t.definition,
      parent_id: newParent,
    });

    return this.buildTagDict(id);
  }

  async addTagAlias(tag_id: string, alias: string): Promise<Tag> {
    const t = await db.tags.get(tag_id);
    if (!t) throw new ApiError("NOT_FOUND", "標籤不存在", 404, { tag_id });
    const clean = alias.trim();
    if (clean.toLowerCase() === t.name.toLowerCase()) {
      throw new ApiError("NAME_CONFLICT", "別名不能與標籤本身的正式名稱相同", 409, { names: [clean] });
    }
    const exists = await db.tag_aliases.filter((a) => a.alias.toLowerCase() === clean.toLowerCase()).first();
    if (exists) {
      throw new ApiError("NAME_CONFLICT", `別名「${clean}」已被使用`, 409, { names: [clean] });
    }
    await db.tag_aliases.add({ tag_id, alias: clean });
    return this.buildTagDict(tag_id);
  }

  async removeTagAlias(tag_id: string, alias: string): Promise<Tag> {
    await db.tag_aliases
      .filter((a) => a.tag_id === tag_id && a.alias.toLowerCase() === alias.trim().toLowerCase())
      .delete();
    return this.buildTagDict(tag_id);
  }

  async resolveTag(query: string, axis?: Tag["axis"]): Promise<TagResolveResponse> {
    const q = query.trim().toLowerCase();
    const allTags = await db.tags.toArray();
    const filteredTags = axis ? allTags.filter((t) => t.axis === axis) : allTags;

    const exactMatch = filteredTags.filter((t) => t.name.toLowerCase() === q);
    if (exactMatch.length === 1) {
      return { status: "exact_tag", tag: await this.buildTagDict(exactMatch[0].id), candidates: [] };
    }
    if (exactMatch.length > 1) {
      const candidates: Tag[] = [];
      for (const t of exactMatch) candidates.push(await this.buildTagDict(t.id));
      return { status: "ambiguous", tag: null, candidates };
    }

    const aliasMatches = await db.tag_aliases.filter((a) => a.alias.toLowerCase() === q).toArray();
    if (aliasMatches.length === 1) {
      return {
        status: "exact_alias",
        matched_alias: aliasMatches[0].alias,
        tag: await this.buildTagDict(aliasMatches[0].tag_id),
        candidates: [],
      };
    }

    const simTags = filteredTags.filter((t) => t.name.toLowerCase().includes(q));
    if (simTags.length > 0) {
      const candidates: Tag[] = [];
      for (const t of simTags.slice(0, 10)) candidates.push(await this.buildTagDict(t.id));
      return { status: "similar", tag: null, candidates };
    }

    return { status: "not_found", tag: null, candidates: [] };
  }

  async mergeTag(source_id: string, target_id: string): Promise<Tag> {
    if (source_id === target_id) throw new ApiError("VALIDATION_ERROR", "不能將標籤合併到自己", 422);
    const source = await db.tags.get(source_id);
    const target = await db.tags.get(target_id);
    if (!source || !target) throw new ApiError("NOT_FOUND", "標籤不存在", 404);

    await db.transaction("rw", [db.tags, db.card_tags, db.tag_aliases], async () => {
      // 轉移子標籤
      await db.tags.where("parent_id").equals(source_id).modify({ parent_id: target_id });
      // 轉移卡片歸屬
      const sourceCts = await db.card_tags.where("tag_id").equals(source_id).toArray();
      for (const ct of sourceCts) {
        const hasTarget = await db.card_tags.where({ card_id: ct.card_id, tag_id: target_id }).first();
        if (!hasTarget) {
          await db.card_tags.add({ card_id: ct.card_id, tag_id: target_id });
        }
      }
      await db.card_tags.where("tag_id").equals(source_id).delete();
      // 別名保留
      await db.tag_aliases.where("tag_id").equals(source_id).modify({ tag_id: target_id });
      if (source.name.toLowerCase() !== target.name.toLowerCase()) {
        await db.tag_aliases.add({ tag_id: target_id, alias: source.name });
      }
      await db.tags.delete(source_id);
    });

    return this.buildTagDict(target_id);
  }

  async deletePreview(id: string): Promise<DeletePreview> {
    const t = await db.tags.get(id);
    if (!t) throw new ApiError("NOT_FOUND", "標籤不存在", 404, { tag_id: id });
    const children = await db.tags.where("parent_id").equals(id).toArray();
    const card_count = await db.card_tags.where("tag_id").equals(id).count();
    let new_parent: { id: string; name: string } | null = null;
    if (t.parent_id) {
      const p = await db.tags.get(t.parent_id);
      if (p) new_parent = { id: p.id, name: p.name };
    }
    return {
      child_count: children.length,
      card_count,
      new_parent,
      conflicts: [],
    };
  }

  async deleteTag(id: string): Promise<{ deleted: boolean }> {
    const t = await db.tags.get(id);
    if (!t) throw new ApiError("NOT_FOUND", "標籤不存在", 404, { tag_id: id });

    await db.transaction("rw", [db.tags, db.card_tags, db.tag_aliases], async () => {
      // 子節點上移
      await db.tags.where("parent_id").equals(id).modify({ parent_id: t.parent_id });
      // 若有父節點，卡片改歸屬到父節點
      if (t.parent_id) {
        const cts = await db.card_tags.where("tag_id").equals(id).toArray();
        for (const ct of cts) {
          const hasParent = await db.card_tags.where({ card_id: ct.card_id, tag_id: t.parent_id }).first();
          if (!hasParent) await db.card_tags.add({ card_id: ct.card_id, tag_id: t.parent_id });
        }
      }
      await db.card_tags.where("tag_id").equals(id).delete();
      await db.tag_aliases.where("tag_id").equals(id).delete();
      await db.tags.delete(id);
    });
    return { deleted: true };
  }

  async assignTag(card_id: string, tag_id: string): Promise<{ existed: boolean }> {
    const exists = await db.card_tags.where({ card_id, tag_id }).first();
    if (exists) return { existed: true };
    await db.card_tags.add({ card_id, tag_id });
    return { existed: false };
  }

  async unassignTag(card_id: string, tag_id: string): Promise<{ removed: boolean }> {
    const cnt = await db.card_tags.where({ card_id, tag_id }).delete();
    if (cnt === 0) throw new ApiError("NOT_FOUND", "這張卡片沒有這個標籤", 404);
    return { removed: true };
  }

  // ---- 白板（降級為卡片冊與成員名單） ----
  async listBoards(): Promise<{ boards: BoardSummary[] }> {
    const rawBoards = await db.boards.toArray();
    const boards: BoardSummary[] = [];
    for (const b of rawBoards) {
      const card_count = await db.board_cards.where("board_id").equals(b.id).count();
      boards.push({ id: b.id, name: b.name, card_count });
    }
    return { boards };
  }

  async createBoard(name: string): Promise<BoardSummary> {
    const id = newId();
    await db.boards.add({ id, name: name.trim(), created_at: utcNow(), updated_at: utcNow() });
    return { id, name: name.trim(), card_count: 0 };
  }

  async renameBoard(id: string, name: string): Promise<{ id: string; name: string }> {
    const b = await db.boards.get(id);
    if (!b) throw new ApiError("NOT_FOUND", "白板不存在", 404, { board_id: id });
    await db.boards.update(id, { name: name.trim(), updated_at: utcNow() });
    return { id, name: name.trim() };
  }

  async deleteBoard(id: string): Promise<{ deleted: boolean }> {
    await db.transaction("rw", [db.boards, db.board_cards, db.board_groups], async () => {
      await db.boards.delete(id);
      await db.board_cards.where("board_id").equals(id).delete();
      await db.board_groups.where("board_id").equals(id).delete();
    });
    return { deleted: true };
  }

  async getBoard(id: string): Promise<BoardData> {
    const b = await db.boards.get(id);
    if (!b) throw new ApiError("NOT_FOUND", "白板不存在", 404, { board_id: id });
    const bcs = await db.board_cards.where("board_id").equals(id).toArray();
    const cards: BoardCard[] = [];
    const cardIdSet = new Set<string>();

    for (const bc of bcs) {
      const c = await db.cards.get(bc.card_id);
      if (c) {
        cardIdSet.add(c.id);
        cards.push({
          card_id: c.id,
          x: bc.x,
          y: bc.y,
          w: bc.w,
          h: bc.h,
          z: bc.z,
          title: c.title,
          body: c.body,
          updated_at: c.updated_at,
        });
      }
    }

    const rawLinks = await db.links.toArray();
    const links: BoardLink[] = rawLinks
      .filter((l) => cardIdSet.has(l.source_id) && cardIdSet.has(l.target_id))
      .map((l) => ({
        source_id: l.source_id,
        target_id: l.target_id,
        card_a: l.source_id,
        card_b: l.target_id,
        relation_type: l.relation_type as RelationType,
        status: l.status as LinkStatus,
        reason: l.reason,
      }));

    const groups = await db.board_groups.where("board_id").equals(id).toArray();
    return {
      id: b.id,
      name: b.name,
      cards,
      links,
      groups,
    };
  }

  async addToBoard(board_id: string, card_id: string, x = 100, y = 100): Promise<Omit<BoardCard, "title" | "body" | "updated_at">> {
    const b = await db.boards.get(board_id);
    if (!b) throw new ApiError("NOT_FOUND", "白板不存在", 404, { board_id });
    const c = await db.cards.get(card_id);
    if (!c) throw new ApiError("NOT_FOUND", "卡片不存在", 404, { card_id });

    const exists = await db.board_cards.where({ board_id, card_id }).first();
    if (exists) {
      throw new ApiError("CARD_ALREADY_ON_BOARD", "這張卡片已經在這塊白板上", 409, { card_id });
    }

    const row: DbBoardCard = { board_id, card_id, x, y, w: 280, h: null, z: 0 };
    await db.board_cards.add(row);
    return { card_id, x, y, w: 280, h: null, z: 0 };
  }

  async patchBoardCards(board_id: string, items: { card_id: string; x: number; y: number; w?: number; h?: number }[]): Promise<{ updated: number }> {
    for (const item of items) {
      const match = await db.board_cards.where({ board_id, card_id: item.card_id }).first();
      if (match && match.id !== undefined) {
        await db.board_cards.update(match.id, {
          x: item.x,
          y: item.y,
          w: item.w !== undefined ? item.w : match.w,
          h: item.h !== undefined ? item.h : match.h,
        });
      }
    }
    return { updated: items.length };
  }

  async removeFromBoard(board_id: string, card_id: string): Promise<{ removed: boolean }> {
    await db.board_cards.where({ board_id, card_id }).delete();
    return { removed: true };
  }

  async createBoardGroup(board_id: string, body: { label?: string; x: number; y: number; w?: number; h?: number; color?: string }): Promise<BoardGroup> {
    const gid = newId();
    const g: BoardGroup = {
      id: gid,
      board_id,
      label: body.label?.trim() || "視覺分組",
      x: body.x,
      y: body.y,
      w: body.w ?? 360,
      h: body.h ?? 240,
      color: body.color || "slate",
      created_at: utcNow(),
    };
    await db.board_groups.add(g);
    return g;
  }

  async patchBoardGroup(_board_id: string, group_id: string, patch: { label?: string; x?: number; y?: number; w?: number; h?: number; color?: string }): Promise<BoardGroup> {
    await db.board_groups.update(group_id, patch);
    const updated = await db.board_groups.get(group_id);
    if (!updated) throw new ApiError("NOT_FOUND", "分組框不存在", 404);
    return updated;
  }

  async deleteBoardGroup(_board_id: string, group_id: string): Promise<{ deleted: boolean }> {
    await db.board_groups.delete(group_id);
    return { deleted: true };
  }

  // ---- 同步：匯出 JSON 封包 ----
  async syncExport(): Promise<SyncPackage> {
    const rawCards = await db.cards.toArray();
    const cards: CardDetail[] = [];
    for (const c of rawCards) {
      cards.push(await this.getCard(c.id));
    }

    const rawTags = await db.tags.toArray();
    const tags: Tag[] = [];
    for (const t of rawTags) {
      tags.push(await this.buildTagDict(t.id));
    }

    const rawCts = await db.card_tags.toArray();
    const card_tags = rawCts.map((ct) => ({ card_id: ct.card_id, tag_id: ct.tag_id }));

    const rawLinks = await db.links.toArray();
    const links: BoardLink[] = rawLinks.map((l) => ({
      source_id: l.source_id,
      target_id: l.target_id,
      card_a: l.source_id,
      card_b: l.target_id,
      relation_type: l.relation_type as RelationType,
      status: l.status as LinkStatus,
      reason: l.reason,
    }));

    const rawBoards = await db.boards.toArray();
    const boards = rawBoards.map((b) => ({ id: b.id, name: b.name }));

    const rawBcs = await db.board_cards.toArray();
    const board_cards = rawBcs.map((bc) => ({
      board_id: bc.board_id,
      card_id: bc.card_id,
      x: bc.x,
      y: bc.y,
      w: bc.w ?? undefined,
      h: bc.h ?? undefined,
    }));

    return {
      version: 1,
      exported_at: utcNow(),
      source_device: "ipad",
      cards,
      tags,
      card_tags,
      links,
      boards,
      board_cards,
    };
  }

  // ---- 同步：直接覆蓋匯入（移動端專用：電腦備份覆蓋 iPad） ----
  async importPackageOverwrite(pkg: SyncPackage): Promise<{ imported: number }> {
    if (!pkg || !Array.isArray(pkg.cards)) {
      throw new ApiError("VALIDATION_ERROR", "無效的備份封包格式", 422);
    }

    await db.transaction(
      "rw",
      [db.cards, db.tags, db.tag_aliases, db.card_tags, db.links, db.boards, db.board_cards, db.board_groups],
      async () => {
        // 清空本地全部資料表
        await db.cards.clear();
        await db.tags.clear();
        await db.tag_aliases.clear();
        await db.card_tags.clear();
        await db.links.clear();
        await db.boards.clear();
        await db.board_cards.clear();
        await db.board_groups.clear();

        // 寫入標籤與別名
        for (const t of pkg.tags ?? []) {
          await db.tags.add({
            id: t.id,
            name: t.name,
            axis: t.axis,
            facet: t.facet ?? null,
            definition: t.definition ?? "",
            parent_id: t.parent_id,
          });
          for (const a of t.aliases ?? []) {
            await db.tag_aliases.add({ tag_id: t.id, alias: a });
          }
        }

        // 寫入卡片
        for (const c of pkg.cards ?? []) {
          await db.cards.add({
            id: c.id,
            title: c.title,
            body: c.body,
            card_type: c.card_type ?? "untyped",
            curation_status: c.curation_status ?? "inbox",
            created_at: c.created_at || utcNow(),
            updated_at: c.updated_at || utcNow(),
          });
        }

        // 寫入卡片標籤對應
        for (const ct of pkg.card_tags ?? []) {
          await db.card_tags.add({ card_id: ct.card_id, tag_id: ct.tag_id });
        }

        // 寫入語意連結
        for (const l of pkg.links ?? []) {
          await db.links.add({
            source_id: l.source_id,
            target_id: l.target_id,
            relation_type: l.relation_type,
            status: l.status,
            reason: l.reason ?? "",
          });
        }

        // 寫入白板與卡片關係
        for (const b of pkg.boards ?? []) {
          await db.boards.add({ id: b.id, name: b.name, created_at: utcNow(), updated_at: utcNow() });
        }
        for (const bc of pkg.board_cards ?? []) {
          await db.board_cards.add({
            board_id: bc.board_id,
            card_id: bc.card_id,
            x: bc.x ?? 100,
            y: bc.y ?? 100,
            w: bc.w ?? 280,
            h: bc.h ?? null,
            z: 0,
          });
        }
      },
    );

    return { imported: (pkg.cards ?? []).length };
  }

  // 移動端比對與套用直接相容
  async syncDiff(pkg: SyncPackage): Promise<SyncDiffReport> {
    return {
      source_device: pkg.source_device,
      exported_at: pkg.exported_at,
      cards_new: [],
      cards_updated: [],
      cards_unchanged_count: pkg.cards.length,
      tags_new: [],
      tags_updated: [],
      card_tags_new: [],
      links_new: [],
      board_cards_new: [],
    };
  }

  async syncApply(payload: SyncApplyRequest): Promise<SyncApplyResult> {
    await this.importPackageOverwrite(payload.package);
    return {
      applied: {
        cards_added: payload.package.cards.length,
        cards_updated: 0,
        tags_added: payload.package.tags.length,
        tags_updated: 0,
        card_tags_added: payload.package.card_tags.length,
        links_added: payload.package.links.length,
        board_cards_added: payload.package.board_cards.length,
      },
    };
  }

  // 媒體存根
  async uploadMedia(file: File): Promise<MediaInfo> {
    const mid = newId();
    const isVid = file.type.startsWith("video/");
    await db.media.add({
      id: mid,
      kind: isVid ? "video" : "image",
      mime: file.type,
      byte_size: file.size,
      data_blob: file,
      created_at: utcNow(),
    });
    return {
      id: mid,
      kind: isVid ? "video" : "image",
      mime: file.type,
      byte_size: file.size,
      width: null,
      height: null,
    };
  }

  async mediaInfo(id: string): Promise<MediaInfo> {
    const m = await db.media.get(id);
    if (!m) throw new ApiError("NOT_FOUND", "媒體檔案不存在", 404);
    return {
      id: m.id,
      kind: m.kind,
      mime: m.mime,
      byte_size: m.byte_size,
      width: null,
      height: null,
    };
  }

  async cleanupMedia(): Promise<CleanupResult> {
    return { dry_run: true, orphans: [], stray_files: [] };
  }

  async getConceptGraph(): Promise<ConceptGraphResponse> {
    return { nodes: [], edges: [], hidden_edges: [] };
  }
}