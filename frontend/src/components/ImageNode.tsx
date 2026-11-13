// @depends-on ./Board.tsx（nodeTypes.boardImage；節點 id 一律 "img:<image_id>"；data.w／h 必須與節點 width／height 同值）
// @depends-on ../types.ts::BoardImage（裁切是相對原圖的 0–1 比例；w／h 是裁切後的顯示大小，長寬比必須等於裁切區域的長寬比）
// @depends-on ../styles.css（.img-node／.img-frame／.img-toolbar／.img-crop-*）
// @depends-on backend media.py（圖檔網址，見 mediaSrc 的 assumption）
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useStore,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export const IMAGE_MAX_SIDE = 480; // 貼上時預設顯示的最長邊（不放大）
const CROP_MIN_PX = 24; // 裁切框最小邊長（畫布座標）
const EPS = 1e-6;

// assumption: GET /api/media/<id> 回傳圖檔（api.ts 只看得到 /media/{id}/info，取檔路由在 media.py）
// if broken: 圖片節點顯示「圖片載入失敗」並呼叫 report；只需改這一個函式
export const mediaSrc = (mediaId: string): string => `/api/media/${mediaId}`;

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageNodeData extends Record<string, unknown> {
  imageId: string;
  mediaId: string;
  w: number;
  h: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  onResizeEnd: (imageId: string, p: { x: number; y: number; width: number; height: number }) => void;
  onCropCommit: (imageId: string, r: CropRect) => Promise<boolean>; // true＝已存入資料庫
  onRemove: (imageId: string) => void;
  report: (e: unknown, prefix?: string) => void;
}
export type ImageFlowNode = FlowNode<ImageNodeData, "boardImage">;

// 在瀏覽器量原圖尺寸（不依賴後端回傳的 width／height）；解不開就丟錯，不放一張 0×0 的圖
export function measureImage(blob: Blob): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve({ w: img.naturalWidth, h: img.naturalHeight });
      else reject(new Error("圖片尺寸為 0"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法解碼剪貼簿中的圖片"));
    };
    img.src = url;
  });
}

// 右鍵貼上用：需要使用者授權；沒有圖片回 null，不支援或被拒就丟錯
export async function readClipboardImage(): Promise<File | null> {
  if (!navigator.clipboard?.read) throw new Error("此瀏覽器不支援讀取剪貼簿圖片，請改用 Ctrl+V");
  const items = await navigator.clipboard.read();
  for (const it of items) {
    const type = it.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    const blob = await it.getType(type);
    const ext = (type.split("/")[1] ?? "png").split("+")[0];
    return new File([blob], `paste-${Date.now()}.${ext}`, { type });
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Dir = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: readonly Exclude<Dir, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function applyDrag(s: CropRect, dir: Dir, dx: number, dy: number, minW: number, minH: number): CropRect {
  if (dir === "move") {
    return { x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h), w: s.w, h: s.h };
  }
  let { x, y, w, h } = s;
  if (dir.includes("w")) {
    const nx = clamp(s.x + dx, 0, s.x + s.w - minW);
    w = s.x + s.w - nx;
    x = nx;
  }
  if (dir.includes("e")) w = clamp(s.w + dx, minW, 1 - s.x);
  if (dir.includes("n")) {
    const ny = clamp(s.y + dy, 0, s.y + s.h - minH);
    h = s.y + s.h - ny;
    y = ny;
  }
  if (dir.includes("s")) h = clamp(s.h + dy, minH, 1 - s.y);
  return { x, y, w, h };
}

export function ImageNode({ data, selected }: NodeProps<ImageFlowNode>) {
  const zoom = useStore((s) => s.transform[2]);
  const [cropping, setCropping] = useState(false);
  const [draft, setDraft] = useState<CropRect>({ x: data.cropX, y: data.cropY, w: data.cropW, h: data.cropH });
  const [broken, setBroken] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);
  const reportedRef = useRef(false);
  const src = mediaSrc(data.mediaId);

  const isCropped = data.cropX > EPS || data.cropY > EPS || data.cropW < 1 - EPS || data.cropH < 1 - EPS;
  // 以百分比繪製：縮放拖曳中節點尺寸即時改變，圖片跟著縮放，不依賴尚未存檔的 data.w／h
  const imgStyle = {
    width: `${100 / data.cropW}%`,
    height: `${100 / data.cropH}%`,
    left: `${-(data.cropX / data.cropW) * 100}%`,
    top: `${-(data.cropY / data.cropH) * 100}%`,
  };
  // 裁切模式下整張原圖的畫布尺寸（此時縮放把手已隱藏，data.w／h 就是目前框的大小）
  const fullW = data.w / data.cropW;
  const fullH = data.h / data.cropH;

  useEffect(() => {
    if (!selected) setCropping(false); // 取消選取＝放棄未確認的裁切
  }, [selected]);

  const startCrop = () => {
    setDraft({ x: data.cropX, y: data.cropY, w: data.cropW, h: data.cropH });
    setCropping(true);
  };

  const commit = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      if (await data.onCropCommit(data.imageId, draftRef.current)) setCropping(false);
    } finally {
      savingRef.current = false;
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!cropping) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCropping(false);
      else if (e.key === "Enter") {
        e.preventDefault();
        void commitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cropping]);

  const startDrag = (dir: Dir) => (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = draftRef.current;
    const minW = Math.min(CROP_MIN_PX / fullW, start.w);
    const minH = Math.min(CROP_MIN_PX / fullH, start.h);
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / zoom / fullW;
      const dy = (ev.clientY - sy) / zoom / fullH;
      setDraft(applyDrag(start, dir, dx, dy, minW, minH));
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const onImgError = () => {
    setBroken(true);
    if (!reportedRef.current) {
      reportedRef.current = true;
      data.report(new Error(`無法載入圖檔（media:${data.mediaId.slice(0, 8)}，網址 ${src}）`), "圖片載入失敗");
    }
  };

  const d = draft;
  return (
    <div className={`img-node${selected ? " selected" : ""}`}>
      <NodeResizer
        minWidth={40}
        minHeight={40}
        keepAspectRatio
        isVisible={!!selected && !cropping}
        onResizeEnd={(_e, p) => data.onResizeEnd(data.imageId, p)}
      />
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {!cropping && (
        <div className="img-frame">
          {broken ? (
            <div className="img-broken">圖片載入失敗</div>
          ) : (
            <img src={src} alt="" draggable={false} style={imgStyle} onError={onImgError} />
          )}
        </div>
      )}

      {cropping && (
        <div
          className="img-crop-layer nodrag nopan nowheel"
          style={{
            left: imgStyle.left,
            top: imgStyle.top,
            width: imgStyle.width,
            height: imgStyle.height,
          }}
        >
          <img className="img-crop-dim" src={src} alt="" draggable={false} />
          <div
            className="img-crop-rect"
            style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%`, width: `${d.w * 100}%`, height: `${d.h * 100}%` }}
            onPointerDown={startDrag("move")}
          >
            <div className="img-crop-clip">
              <img
                src={src}
                alt=""
                draggable={false}
                style={{
                  width: `${100 / d.w}%`,
                  height: `${100 / d.h}%`,
                  left: `${-(d.x / d.w) * 100}%`,
                  top: `${-(d.y / d.h) * 100}%`,
                }}
              />
            </div>
            {HANDLES.map((h) => (
              <span key={h} className={`img-crop-h ${h}`} onPointerDown={startDrag(h)} />
            ))}
          </div>
        </div>
      )}

      {!cropping && (
        <NodeToolbar position={Position.Top} offset={10}>
          <div className="img-toolbar nodrag nopan">
            <button type="button" onClick={startCrop} title="裁切圖片（可隨時還原）">
              裁切
            </button>
            {isCropped && (
              <button
                type="button"
                onClick={() => void data.onCropCommit(data.imageId, { x: 0, y: 0, w: 1, h: 1 })}
                title="還原成完整原圖（位置不變）"
              >
                還原裁切
              </button>
            )}
            <button type="button" className="del" onClick={() => data.onRemove(data.imageId)} title="從白板刪除這張圖片">
              刪除
            </button>
          </div>
        </NodeToolbar>
      )}
      {cropping && (
        <NodeToolbar isVisible position={Position.Top} offset={10}>
          <div className="img-toolbar nodrag nopan">
            <button type="button" className="primary" onClick={() => void commitRef.current()} title="套用裁切（Enter）">
              套用
            </button>
            <button type="button" onClick={() => setCropping(false)} title="取消（Esc）">
              取消
            </button>
          </div>
        </NodeToolbar>
      )}
    </div>
  );
}