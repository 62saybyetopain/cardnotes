// 提及偵測：掃描卡片的標題與內文，找出「提到了、但還沒建立」的概念標籤與其他卡片
// （對應 Obsidian 的「未連結的提及」）。純函式：不連網、不寫入，只回傳建議；
// 要不要接受由使用者決定，與「系統推薦在接受前不寫入」的原則一致。
// @depends-on ../types.ts (Tag)
import type { Tag } from "../types";

export interface MentionOptions {
  /** 比對用字串的最短長度（正規化後）。預設 2：單一個字（例如「踝」）太容易誤中。 */
  minLength?: number;
  /** 例句前後各取幾個字。預設 12。 */
  snippetRadius?: number;
}

export interface MentionSnippet {
  before: string;
  match: string;
  after: string;
}

export interface TagMention {
  tag: Tag;
  /** 在文字裡實際比對到的字串（保留原本的大小寫） */
  term: string;
  via: "name" | "alias";
  count: number;
  snippet: MentionSnippet;
}

export interface CardMention {
  card: { id: string; title: string };
  count: number;
  snippet: MentionSnippet;
}

const DEFAULT_MIN_LENGTH = 2;
const DEFAULT_RADIUS = 12;

function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/** 去掉不該被比對的 Markdown 雜訊：程式碼、圖片／影片引用、連結網址。以空白取代，不改變其餘文字。 */
export function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/https?:\/\/\S+/g, " ");
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

/** 英數字開頭／結尾的詞要求前後不是英數字（sql 不算提到 sqlite）；中文不受影響。 */
function boundaryOk(text: string, start: number, end: number, term: string): boolean {
  if (isAsciiAlnum(term[0]) && isAsciiAlnum(text[start - 1])) return false;
  if (isAsciiAlnum(term[term.length - 1]) && isAsciiAlnum(text[end])) return false;
  return true;
}

const PUNCT_ONLY = /^[\p{P}\p{S}\s]+$/u;

interface Entry<T> {
  owner: T;
  via: "name" | "alias";
  raw: string;
  /** false＝只佔位、不回傳：已掛上的標籤、已連結的卡片。它們的字串被提到時，擋住包在裡面的短詞（例如「前跗管症候群」擋住「症候群」）。 */
  active: boolean;
}

interface Hit {
  key: string;
  start: number;
  end: number;
}

/** 在 text 裡找出所有 key 的出現位置；重疊時長的優先（「足/踝麻感」不會再被「麻感」重複算一次）。 */
function scan<T>(text: string, entries: Map<string, Entry<T>[]>): Hit[] {
  const hits: Hit[] = [];
  for (const key of entries.keys()) {
    let from = 0;
    while (from <= text.length - key.length) {
      const i = text.indexOf(key, from);
      if (i < 0) break;
      if (boundaryOk(text, i, i + key.length, key)) {
        hits.push({ key, start: i, end: i + key.length });
        from = i + key.length;
      } else {
        from = i + 1;
      }
    }
  }
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: Hit[] = [];
  for (const h of hits) {
    if (accepted.every((x) => h.end <= x.start || h.start >= x.end)) accepted.push(h);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** 比對用的文字（全形轉半形、轉小寫）與顯示用的文字。兩者長度相同時顯示原文（保留大小寫），否則退回比對用的文字。 */
function prepare(text: string): { norm: string; shown: string } {
  const stripped = stripMarkdownNoise(text);
  const norm = normalize(stripped);
  return { norm, shown: norm.length === stripped.length ? stripped : norm };
}

function snippetOf(text: string, h: Hit, radius: number): MentionSnippet {
  return {
    before: text.slice(Math.max(0, h.start - radius), h.start),
    match: text.slice(h.start, h.end),
    after: text.slice(h.end, h.end + radius),
  };
}

function addEntry<T>(map: Map<string, Entry<T>[]>, key: string, entry: Entry<T>, minLength: number): void {
  if (key.length < minLength || PUNCT_ONLY.test(key)) return;
  const list = map.get(key);
  if (!list) map.set(key, [entry]);
  else if (!list.some((e) => e.owner === entry.owner)) list.push(entry);
}

/**
 * 內文提到、但這張卡片還沒掛上的概念標籤。
 * 只看概念標籤（concept／free）：收納位置反映歸檔，不是「提到」；已掛上的標籤不再建議，但仍會佔位。
 * 標籤名稱與別名都會比對；同一個標籤只回傳一筆，count 是出現次數。
 */
export function findTagMentions(
  text: string,
  tags: readonly Tag[],
  assignedTagIds: ReadonlySet<string>,
  opts: MentionOptions = {},
): TagMention[] {
  const minLength = opts.minLength ?? DEFAULT_MIN_LENGTH;
  const radius = opts.snippetRadius ?? DEFAULT_RADIUS;
  const { norm, shown } = prepare(text);
  const entries = new Map<string, Entry<Tag>[]>();
  for (const tag of tags) {
    if (tag.axis !== "concept" && tag.axis !== "free") continue;
    const active = !assignedTagIds.has(tag.id);
    addEntry(entries, normalize(tag.name), { owner: tag, via: "name", raw: tag.name, active }, minLength);
    for (const alias of tag.aliases ?? []) {
      addEntry(entries, normalize(alias), { owner: tag, via: "alias", raw: alias, active }, minLength);
    }
  }
  const byTag = new Map<string, TagMention>();
  for (const h of scan(norm, entries)) {
    for (const e of entries.get(h.key) ?? []) {
      if (!e.active) continue;
      const cur = byTag.get(e.owner.id);
      if (cur) cur.count += 1;
      else byTag.set(e.owner.id, { tag: e.owner, term: shown.slice(h.start, h.end), via: e.via, count: 1, snippet: snippetOf(shown, h, radius) });
    }
  }
  return [...byTag.values()];
}

/**
 * 內文提到其他卡片標題、但還沒建立連結的卡片。
 * 排除自己與已經有連結的卡片（不分類型、不分方向，由呼叫端算好 linkedCardIds）；已連結的卡片標題仍會佔位。
 */
export function findCardMentions(
  text: string,
  cards: readonly { id: string; title: string }[],
  selfId: string,
  linkedCardIds: ReadonlySet<string>,
  opts: MentionOptions = {},
): CardMention[] {
  const minLength = opts.minLength ?? DEFAULT_MIN_LENGTH;
  const radius = opts.snippetRadius ?? DEFAULT_RADIUS;
  const { norm, shown } = prepare(text);
  const entries = new Map<string, Entry<{ id: string; title: string }>[]>();
  for (const c of cards) {
    if (c.id === selfId) continue; // 自己不佔位：標題裡提到別張卡片的名字仍然算
    const title = c.title.trim();
    if (!title) continue;
    addEntry(entries, normalize(title), { owner: c, via: "name", raw: title, active: !linkedCardIds.has(c.id) }, minLength);
  }
  const byCard = new Map<string, CardMention>();
  for (const h of scan(norm, entries)) {
    for (const e of entries.get(h.key) ?? []) {
      if (!e.active) continue;
      const cur = byCard.get(e.owner.id);
      if (cur) cur.count += 1;
      else byCard.set(e.owner.id, { card: e.owner, count: 1, snippet: snippetOf(shown, h, radius) });
    }
  }
  return [...byCard.values()];
}
