import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBoard = vi.fn();
const removeFromBoard = vi.fn();
const deleteCard = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: {
      getBoard: (...a: unknown[]) => getBoard(...a),
      removeFromBoard: (...a: unknown[]) => removeFromBoard(...a),
      deleteCard: (...a: unknown[]) => deleteCard(...a),
      mediaInfo: vi.fn().mockRejectedValue(new Error("none")),
    },
  };
});
import { Board } from "./Board";

const boardData = {
  id: "b1", name: "板",
  cards: [
    { card_id: "c1", x: 0, y: 0, w: 280, h: null, z: 0, title: "卡一", body: "內文一", updated_at: "u" },
    { card_id: "c2", x: 400, y: 0, w: 280, h: null, z: 0, title: "卡二", body: "內文二", updated_at: "u" },
  ],
  links: [{ card_a: "c1", card_b: "c2" }],
};
const props = () => ({
  boardId: "b1", selectedCardId: "c1", onSelectCard: vi.fn(), onLinksChanged: vi.fn(),
  onCountChanged: vi.fn(), report: vi.fn(), info: vi.fn(),
});

beforeEach(() => { getBoard.mockReset(); removeFromBoard.mockReset(); deleteCard.mockReset(); });

describe("白板", () => {
  it("載入後顯示所有卡片", async () => {
    getBoard.mockResolvedValue(boardData);
    render(<div style={{ width: 800, height: 600 }}><Board {...props()} /></div>);
    expect(await screen.findByText("卡一")).toBeInTheDocument();
    expect(screen.getByText("卡二")).toBeInTheDocument();
  });

  it("選取卡片後按 Delete：只呼叫「從白板移除」，絕不呼叫刪除卡片", async () => {
    getBoard.mockResolvedValue(boardData);
    removeFromBoard.mockResolvedValue({ removed: true });
    const p = props();
    render(<div style={{ width: 800, height: 600 }}><Board {...p} /></div>);
    await screen.findByText("卡一");
    await waitFor(() => expect(document.querySelector(".card-node.selected")).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(removeFromBoard).toHaveBeenCalledWith("b1", "c1"));
    expect(deleteCard).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("卡一")).not.toBeInTheDocument());
    expect(screen.getByText("卡二")).toBeInTheDocument();
    expect(p.onCountChanged).toHaveBeenCalled();
  });

  it("焦點在輸入框時按 Delete／Backspace：什麼都不能發生", async () => {
    getBoard.mockResolvedValue(boardData);
    render(
      <div style={{ width: 800, height: 600 }}>
        <textarea aria-label="x" />
        <Board {...props()} />
      </div>,
    );
    await screen.findByText("卡一");
    await waitFor(() => expect(document.querySelector(".card-node.selected")).not.toBeNull());
    fireEvent.keyDown(screen.getByLabelText("x"), { key: "Backspace" });
    fireEvent.keyDown(screen.getByLabelText("x"), { key: "Delete" });
    expect(removeFromBoard).not.toHaveBeenCalled();
    expect(deleteCard).not.toHaveBeenCalled();
  });

  it("從白板移除失敗：卡片留在白板上，並回報錯誤", async () => {
    getBoard.mockResolvedValue(boardData);
    removeFromBoard.mockRejectedValue(new Error("伺服器掛了"));
    const p = props();
    render(<div style={{ width: 800, height: 600 }}><Board {...p} /></div>);
    await screen.findByText("卡一");
    await waitFor(() => expect(document.querySelector(".card-node.selected")).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(p.report).toHaveBeenCalled());
    expect(screen.getByText("卡一")).toBeInTheDocument();
  });

  it("沒有選白板時顯示提示；載入失敗時回報錯誤而不是空白", async () => {
    const p = { ...props(), boardId: null };
    const { unmount } = render(<div style={{ width: 800, height: 600 }}><Board {...p} /></div>);
    expect(screen.getByText(/請先在左側建立或選擇一塊白板/)).toBeInTheDocument();
    unmount();
    getBoard.mockRejectedValue(new Error("壞了"));
    const q = props();
    render(<div style={{ width: 800, height: 600 }}><Board {...q} /></div>);
    await waitFor(() => expect(q.report).toHaveBeenCalled());
  });
});
