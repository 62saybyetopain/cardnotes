import { describe, expect, it } from "vitest";
import { boxesConflict, placeCardsAvoidingCollisions, type LayoutBox } from "./layout";
import { computeMagnetSnap, MAGNET_GAP } from "./magnet";

const THRESHOLD = 8; // 螢幕像素，zoom = 1 時等於畫布單位
const box = (id: string, x: number, y: number, w = 280, h = 150): LayoutBox => ({ id, x, y, w, h });

// 放開時 Board.onNodeDragStop 做的事：把磁吸後的位置交給 placeCardsAvoidingCollisions
const afterDrop = (moving: LayoutBox, snapped: { x: number; y: number }, fixed: LayoutBox[]) =>
  placeCardsAvoidingCollisions([{ ...moving, x: snapped.x, y: snapped.y }], fixed).get(moving.id)!;

describe("磁吸結果與放開後的位置一致", () => {
  it("間距不足 20 時不畫紅線：否則放開會被推開，紅線等於白畫", () => {
    const A = box("A", 100, 100);
    const M = box("M", 385, 103); // 在 A 右側，間距只有 5，上緣差 3

    // 舊行為：只吸上緣並畫紅線，但位置離 A 只有 5 → 放開時被當成衝突
    const legacy = computeMagnetSnap(M, [A], THRESHOLD);
    expect(legacy.guides.length).toBeGreaterThan(0);
    expect(boxesConflict({ ...M, x: legacy.x, y: legacy.y }, A)).toBe(true);

    const r = computeMagnetSnap(M, [A], THRESHOLD, MAGNET_GAP, true);
    expect(r.guides).toEqual([]);
    expect({ x: r.x, y: r.y }).toEqual({ x: M.x, y: M.y });
  });

  it("紅線指到 A、但磁吸後離另一張卡 C 太近時，改選不衝突的位置，放開後不再移動", () => {
    const A = box("A", 100, 100);
    const C = box("C", 290, 260);
    const M = box("M", 402, 95);

    // 舊行為：吸到 (400,100)，與 A 的間距剛好 20，但離 C 只有 10
    const legacy = computeMagnetSnap(M, [A, C], THRESHOLD);
    expect(boxesConflict({ ...M, x: legacy.x, y: legacy.y }, C)).toBe(true);
    expect(afterDrop(M, legacy, [A, C])).not.toEqual({ x: legacy.x, y: legacy.y });

    const r = computeMagnetSnap(M, [A, C], THRESHOLD, MAGNET_GAP, true);
    expect(r.guides.length).toBeGreaterThan(0); // 仍然有吸附與紅線
    expect(afterDrop(M, r, [A, C])).toEqual({ x: r.x, y: r.y });
  });

  it("本來就不衝突時，行為與舊版完全相同", () => {
    const A = box("A", 100, 100);
    const M = box("M", 392, 103); // 右側間距 12 → 吸到 20；上緣差 3 → 對齊

    expect(computeMagnetSnap(M, [A], THRESHOLD, MAGNET_GAP, true)).toEqual(computeMagnetSnap(M, [A], THRESHOLD));
  });
});
