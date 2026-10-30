// 執行：npx tsx --test src/lib/mentions.test.ts   （Node 內建的 node:test，不需要額外的測試框架）
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tag } from "../types";
import { findCardMentions, findTagMentions, stripMarkdownNoise } from "./mentions";

const tag = (id: string, name: string, axis: Tag["axis"] = "concept", aliases: string[] = [], facet: string | null = null): Tag => ({
  id, name, axis, aliases, facet, parent_id: null,
});

const TAGS: Tag[] = [
  tag("t1", "足/踝麻感", "concept", ["踝麻"]),
  tag("t2", "麻感"),
  tag("t3", "SQLite"),
  tag("t4", "踝", "location"),
  tag("t5", "代償"),
  tag("t6", "張力", "concept", [], "屬性／原則"),
  tag("t7", "張力", "concept", [], "問題／現象"),
];

test("中文：名稱與別名都能比對，count 與例句正確", () => {
  const r = findTagMentions("患者主訴踝麻，另有足/踝麻感，踝麻持續", TAGS, new Set());
  const t1 = r.find((m) => m.tag.id === "t1")!;
  assert.equal(t1.count, 3);
  assert.equal(t1.via, "alias");
  assert.equal(t1.snippet.match, "踝麻");
});

test("重疊時長的優先：足/踝麻感 不會再讓 麻感 重複被算一次", () => {
  const r = findTagMentions("足/踝麻感", TAGS, new Set());
  assert.deepEqual(r.map((m) => m.tag.id), ["t1"]);
});

test("已掛上的長標籤會擋住包在裡面的短標籤，但單獨出現的短標籤仍會被建議", () => {
  assert.deepEqual(findTagMentions("足/踝麻感", TAGS, new Set(["t1"])), []);
  assert.deepEqual(findTagMentions("足/踝麻感，另外還有麻感", TAGS, new Set(["t1"])).map((m) => m.tag.id), ["t2"]);
});

test("單獨的「麻感」仍然會被建議", () => {
  const r = findTagMentions("只有麻感，沒有別的", TAGS, new Set());
  assert.deepEqual(r.map((m) => m.tag.id), ["t2"]);
});

test("已掛上的標籤、收納位置標籤都不建議", () => {
  const r = findTagMentions("踝的代償與麻感", TAGS, new Set(["t2"]));
  assert.deepEqual(r.map((m) => m.tag.id), ["t5"]);
});

test("最短長度：單字不比對（預設 2），可調整", () => {
  const one = [tag("x", "踝")];
  assert.equal(findTagMentions("踝", one, new Set()).length, 0);
  assert.equal(findTagMentions("踝", one, new Set(), { minLength: 1 }).length, 1);
});

test("英數字詞要有邊界：sql 不算提到 sqlite，但 SQLite 不分大小寫、保留原文大小寫", () => {
  const tags = [tag("a", "sql"), tag("b", "SQLite")];
  const r = findTagMentions("我們用 SQLITE 做儲存，不是 mysql", tags, new Set());
  assert.deepEqual(r.map((m) => m.tag.id), ["b"]);
  assert.equal(r[0].term, "SQLITE");
});

test("Markdown 雜訊不算：程式碼、圖片引用、連結網址", () => {
  const text = "```\n代償\n```\n`麻感` ![](media:abc-麻感) [說明](https://example.com/代償) 正文沒有提到";
  assert.deepEqual(findTagMentions(text, TAGS, new Set()), []);
  assert.ok(!stripMarkdownNoise(text).includes("example.com"));
  assert.deepEqual(findTagMentions("[代償機制](https://x.y/z)", TAGS, new Set()).map((m) => m.tag.id), ["t5"]);
});

test("同名但不同維度的標籤都會回傳，由使用者挑", () => {
  const r = findTagMentions("這裡的張力", TAGS, new Set());
  assert.deepEqual(r.map((m) => m.tag.id).sort(), ["t6", "t7"]);
});

test("結果依第一次出現的位置排序", () => {
  const r = findTagMentions("先談代償，再談麻感", TAGS, new Set());
  assert.deepEqual(r.map((m) => m.tag.id), ["t5", "t2"]);
});

test("全形英文也能比對", () => {
  const r = findTagMentions("使用ＳＱＬｉｔｅ", TAGS, new Set());
  assert.deepEqual(r.map((m) => m.tag.id), ["t3"]);
});

const CARDS = [
  { id: "c1", title: "跗骨隧道症候群" },
  { id: "c2", title: "前跗管症候群" },
  { id: "c3", title: "踝" },
  { id: "c4", title: "" },
  { id: "self", title: "足踝神經壓迫" },
  { id: "c5", title: "症候群" },
];

test("卡片提及：排除自己、已連結、空標題、單字標題", () => {
  const text = "足踝神經壓迫常見於跗骨隧道症候群與前跗管症候群，踝很痛";
  const r = findCardMentions(text, CARDS, "self", new Set(["c2"]));
  assert.deepEqual(r.map((m) => m.card.id), ["c1"]);
});

test("卡片提及：已連結卡片的標題擋住包在裡面的短標題，但單獨出現時仍會建議", () => {
  const linked = new Set(["c2"]);
  assert.deepEqual(findCardMentions("前跗管症候群", CARDS, "self", linked), []);
  assert.deepEqual(findCardMentions("前跗管症候群，一般的症候群", CARDS, "self", linked).map((m) => m.card.id), ["c5"]);
});

test("卡片提及：自己的標題不佔位（標題裡提到別張卡片仍然算）", () => {
  const cards = [{ id: "self", title: "前跗管症候群的處理" }, { id: "x", title: "前跗管症候群" }];
  assert.deepEqual(findCardMentions("前跗管症候群的處理", cards, "self", new Set()).map((m) => m.card.id), ["x"]);
});

test("卡片提及：長標題優先，被包含的短標題不重複建議", () => {
  const r = findCardMentions("跗骨隧道症候群", CARDS, "self", new Set());
  assert.deepEqual(r.map((m) => m.card.id), ["c1"]);
});

test("卡片提及：同標題的多張卡片都回傳", () => {
  const cards = [{ id: "a", title: "代償" }, { id: "b", title: "代償" }];
  assert.deepEqual(findCardMentions("談代償", cards, "x", new Set()).map((m) => m.card.id), ["a", "b"]);
});

test("沒有任何提及時回傳空陣列，標題內容為空也不會出錯", () => {
  assert.deepEqual(findTagMentions("", TAGS, new Set()), []);
  assert.deepEqual(findCardMentions("", CARDS, "self", new Set()), []);
});
