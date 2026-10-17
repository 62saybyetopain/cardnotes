import { describe, expect, it } from "vitest";
import { isEditableTarget, isRemoveKey } from "./keys";
import { extractMediaIds, insertAtCursor, isAcceptedMime, mediaIdFromSrc, urlTransform } from "./media";
import { buildTree, descendantIds, tagPath } from "./tree";
import type { Tag } from "../types";

const ID = "11111111-1111-4111-8111-111111111111";

describe("insertAtCursor", () => {
  it("在游標處插入，並回傳插入後的游標", () => {
    expect(insertAtCursor("hello world", 5, 5, "X")).toEqual({ text: "helloX world", cursor: 6 });
  });
  it("有選取範圍時取代選取內容", () => {
    expect(insertAtCursor("hello world", 0, 5, "Hi")).toEqual({ text: "Hi world", cursor: 2 });
  });
  it("游標超出範圍時夾在文字邊界，不會壞掉", () => {
    expect(insertAtCursor("abc", 99, 99, "X").text).toBe("abcX");
    expect(insertAtCursor("abc", -5, -5, "X").text).toBe("Xabc");
  });
});

describe("media 引用與網址", () => {
  it("只放行 media:、http(s)、mailto；其他協定（如 javascript:）一律清空", () => {
    expect(urlTransform(`media:${ID}`)).toBe(`/api/media/${ID}`);
    expect(urlTransform("https://example.com/a")).toBe("https://example.com/a");
    expect(urlTransform("javascript:alert(1)")).toBe("");
    expect(urlTransform("data:text/html,<script>")).toBe("");
  });
  it("mediaIdFromSrc 認得 media: 與已轉換的本機網址，不認得外部網址", () => {
    expect(mediaIdFromSrc(`media:${ID}`)).toBe(ID);
    expect(mediaIdFromSrc(`/api/media/${ID}`)).toBe(ID);
    expect(mediaIdFromSrc("https://evil.example/x.png")).toBeNull();
    expect(mediaIdFromSrc(undefined)).toBeNull();
  });
  it("extractMediaIds 去重並保持順序", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect(extractMediaIds(`![](media:${ID}) ![a](media:${other}) ![](media:${ID})`)).toEqual([ID, other]);
  });
  it("只接受規格內的格式", () => {
    for (const ok of ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"]) expect(isAcceptedMime(ok)).toBe(true);
    for (const bad of ["image/svg+xml", "application/pdf", "text/plain", ""]) expect(isAcceptedMime(bad)).toBe(false);
  });
});

describe("標籤樹", () => {
  const mk = (id: string, name: string, parent: string | null, axis: Tag["axis"] = "domain"): Tag => ({ id, name, axis, parent_id: parent });
  const tags = [mk("a", "櫃子", null), mk("b", "抽屜", "a"), mk("c", "小格", "b"), mk("t", "類型", null, "type")];
  it("依軸建樹，並保持父子結構", () => {
    const t = buildTree(tags, "domain");
    expect(t).toHaveLength(1);
    expect(t[0].children[0].children[0].tag.id).toBe("c");
    expect(buildTree(tags, "type")).toHaveLength(1);
  });
  it("descendantIds 含自己與所有後代；tagPath 組出完整路徑", () => {
    expect([...descendantIds(tags, "a")].sort()).toEqual(["a", "b", "c"]);
    expect(tagPath(tags, "c")).toBe("櫃子 / 抽屜 / 小格");
  });
});

describe("鍵盤判斷", () => {
  it("輸入框內的 Delete/Backspace 不能被當成「從白板移除」", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isRemoveKey({ key: "Delete" })).toBe(true);
    expect(isRemoveKey({ key: "Backspace" })).toBe(true);
    expect(isRemoveKey({ key: "a" })).toBe(false);
  });
});
