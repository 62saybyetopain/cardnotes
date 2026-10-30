import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown } from "./Markdown";

export interface CardNodeData extends Record<string, unknown> {
  title: string;
  body: string;
  updatedAt?: string;
  sized: boolean;
  onResizeEnd: (cardId: string, p: { x: number; y: number; width: number; height: number }) => void;
  onResetSize: (cardId: string) => void;
  onFitHeight: (cardId: string, fullH: number) => void;
  onOpenCard?: (cardId: string) => void;
  report?: (e: unknown, prefix?: string) => void;
}
export type CardFlowNode = Node<CardNodeData, "card">;

// 內容全文所需的卡片高度＝標題／內距等固定部分＋內文自然高度。
// 暫時解除內文的 flex／max-height 再讀 scrollHeight，同步量完立刻還原（不會閃一幀）。
function measureFullHeight(node: HTMLElement, body: HTMLElement): number {
  const chrome = node.offsetHeight - body.clientHeight;
  const prevFlex = body.style.flex;
  const prevMax = body.style.maxHeight;
  body.style.flex = "none";
  body.style.maxHeight = "none";
  const natural = body.scrollHeight;
  body.style.flex = prevFlex;
  body.style.maxHeight = prevMax;
  // 原因：offsetHeight／scrollHeight 都是四捨五入的整數，而標題、內文行高是小數，合計最多差約 1px，
  // 差 1px 就會冒出滑桿；多留 2px 吃掉誤差。底邊雙擊的「是否已是全文高度」判斷用的是同一個值，切換結果不變。
  return Math.max(80, Math.ceil(chrome + natural) + 2);
}

export function CardNode({ id, data, selected }: NodeProps<CardFlowNode>) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 雙擊縮放把手：四角＝回預設大小；底邊＝量出全文高度交給 Board 切換（目前狀態由 Board 判斷）。
  // 任何把手的雙擊都攔截冒泡，避免被當成「雙擊卡片」而開啟編輯。
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const ctl = (e.target as HTMLElement).closest(".react-flow__resize-control");
    if (!ctl) return;
    e.stopPropagation();
    if (ctl.classList.contains("handle")) {
      data.onResetSize(id);
    } else if (ctl.classList.contains("bottom") && nodeRef.current && bodyRef.current) {
      data.onFitHeight(id, measureFullHeight(nodeRef.current, bodyRef.current));
    }
  };

  return (
    <ErrorBoundary fallback={<div className="card-node card-error">此卡片顯示失敗（{id.slice(0, 8)}）</div>}>
      <div
        ref={nodeRef}
        onDoubleClick={onDoubleClick}
        className={`card-node${selected ? " selected" : ""}${data.sized ? " sized" : ""}`}
      >
        <NodeResizer
          minWidth={180}
          minHeight={80}
          isVisible={true}
          onResizeEnd={(_e, p) => data.onResizeEnd(id, p)}
        />
        <Handle type="target" position={Position.Left} />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 6,
            marginBottom: "0.5rem",
          }}
        >
          <div
            className="card-title"
            style={{
              fontSize: "1.15rem",
              fontWeight: 700,
              lineHeight: 1.35,
              wordBreak: "break-word",
              flex: 1,
            }}
          >
            {data.title || "（無標題）"}
          </div>
        </div>
        <div className="card-body" ref={bodyRef}>
          <Markdown source={data.body} onOpenCard={data.onOpenCard} />
        </div>

        <Handle type="source" position={Position.Right} />
      </div>
    </ErrorBoundary>
  );
}
