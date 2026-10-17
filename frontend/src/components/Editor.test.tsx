import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardDetail } from "../types";

const uploadMedia = vi.fn();
const patchCard = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: {
      uploadMedia: (...a: unknown[]) => uploadMedia(...a),
      patchCard: (...a: unknown[]) => patchCard(...a),
      mediaInfo: vi.fn().mockResolvedValue({ id: "x", kind: "image", mime: "image/png", byte_size: 1, width: 1, height: 1 }),
    },
  };
});
import { ApiError } from "../api";
import { Editor } from "./Editor";

const MID = "11111111-1111-4111-8111-111111111111";
const card: CardDetail = {
  id: "c1", title: "T", body: "hello world", updated_at: "v1", created_at: "v0",
  tags: [], links: [], boards: [], warnings: [],
};
const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });
const body = () => screen.getByLabelText("卡片內文") as HTMLTextAreaElement;
const status = () => screen.getByTestId("save-status").textContent;
const setup = () => {
  const report = vi.fn();
  const onSaved = vi.fn();
  render(<Editor card={card} onSaved={onSaved} onReload={vi.fn()} report={report} />);
  return { report, onSaved };
};
const type = (v: string) => fireEvent.change(body(), { target: { value: v } });
const tick = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { uploadMedia.mockReset(); patchCard.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("貼上圖片", () => {
  it("上傳成功後，在貼上當下的游標處插入引用", async () => {
    uploadMedia.mockResolvedValue({ id: MID, kind: "image" });
    setup();
    body().setSelectionRange(5, 5);
    fireEvent.paste(body(), { clipboardData: { files: [file("a.png", "image/png")] } });
    await waitFor(() => expect(body().value).toBe(`hello![](media:${MID})\n world`));
    expect(status()).toBe("未儲存");
  });

  it("上傳失敗：不插入任何東西、不變成未儲存，並回報錯誤（不能靜默）", async () => {
    uploadMedia.mockRejectedValue(new ApiError("UNSUPPORTED_MEDIA", "不支援的檔案格式", 415));
    const { report } = setup();
    fireEvent.paste(body(), { clipboardData: { files: [file("a.png", "image/png")] } });
    await waitFor(() => expect(report).toHaveBeenCalled());
    expect(body().value).toBe("hello world");
    expect(status()).toBe("已儲存");
    expect(String(report.mock.calls[0][1])).toContain("a.png");
  });

  it("不支援的格式：不上傳，並明確提示", () => {
    const { report } = setup();
    fireEvent.paste(body(), { clipboardData: { files: [file("a.pdf", "application/pdf")] } });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
    expect(body().value).toBe("hello world");
  });

  it("一次貼多個檔案：依序插入，彼此不覆蓋", async () => {
    uploadMedia
      .mockResolvedValueOnce({ id: MID, kind: "image" })
      .mockResolvedValueOnce({ id: "22222222-2222-4222-8222-222222222222", kind: "image" });
    setup();
    body().setSelectionRange(0, 0);
    fireEvent.paste(body(), { clipboardData: { files: [file("a.png", "image/png"), file("b.png", "image/png")] } });
    await waitFor(() => expect(body().value.match(/media:/g)).toHaveLength(2));
    expect(body().value.endsWith("hello world")).toBe(true);
  });

  it("上傳進行中暫停自動儲存，完成後才存", async () => {
    vi.useFakeTimers();
    let resolveUpload!: (v: unknown) => void;
    uploadMedia.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    patchCard.mockResolvedValue({ ...card, body: "x", updated_at: "v2" });
    setup();
    type("x");
    fireEvent.paste(body(), { clipboardData: { files: [file("a.png", "image/png")] } });
    await tick(5000);
    expect(patchCard).not.toHaveBeenCalled();
    await act(async () => resolveUpload({ id: MID, kind: "image" })); // 先讓 React 處理完上傳結果，才開始計時
    await tick(1100);
    expect(patchCard).toHaveBeenCalledTimes(1);
    expect(patchCard.mock.calls[0][1].body).toContain(`media:${MID}`);
  });
});

describe("自動儲存", () => {
  it("停止輸入 1 秒後儲存，帶上目前版本；下一次用新版本", async () => {
    vi.useFakeTimers();
    patchCard.mockResolvedValueOnce({ ...card, body: "new", updated_at: "v2" }).mockResolvedValueOnce({ ...card, body: "newer", updated_at: "v3" });
    const { onSaved } = setup();
    type("new");
    expect(status()).toBe("未儲存");
    await tick(999);
    expect(patchCard).not.toHaveBeenCalled();
    await tick(2);
    expect(patchCard).toHaveBeenCalledWith("c1", { title: "T", body: "new" }, "v1");
    expect(status()).toBe("已儲存");
    expect(onSaved).toHaveBeenCalledTimes(1);
    type("newer");
    await tick(1100);
    expect(patchCard.mock.calls[1][2]).toBe("v2");
  });

  it("儲存失敗：保持未儲存、保留本地內容、顯示原因，可重試", async () => {
    vi.useFakeTimers();
    patchCard.mockRejectedValueOnce(new ApiError("INTERNAL_ERROR", "資料庫忙碌", 500));
    setup();
    type("precious text");
    await tick(1100);
    expect(status()).toBe("儲存失敗");
    expect(screen.getByRole("alert").textContent).toContain("資料庫忙碌");
    expect(body().value).toBe("precious text");
    patchCard.mockResolvedValueOnce({ ...card, body: "precious text", updated_at: "v2" });
    fireEvent.click(screen.getByText("重試"));
    await tick(10);
    expect(status()).toBe("已儲存");
  });

  it("版本衝突：顯示衝突橫幅、絕不自動覆蓋、之後的輸入也不會再自動儲存", async () => {
    vi.useFakeTimers();
    patchCard.mockRejectedValue(new ApiError("STALE_VERSION", "已被修改", 409));
    setup();
    type("mine");
    await tick(1100);
    expect(status()).toBe("版本衝突");
    expect(screen.getByRole("alert").textContent).toContain("已在別處被修改");
    type("mine again");
    await tick(5000);
    expect(patchCard).toHaveBeenCalledTimes(1);
    expect(body().value).toBe("mine again");
  });
});
