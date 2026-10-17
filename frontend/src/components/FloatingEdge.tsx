import {
  BaseEdge,
  getBezierPath,
  Position,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from "@xyflow/react";

interface Box {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

interface Anchor {
  x: number;
  y: number;
  position: Position;
}

function boxOf(n: InternalNode): Box | null {
  const w = n.measured.width;
  const h = n.measured.height;
  if (!w || !h) return null; // 尚未量測完成
  const p = n.internals.positionAbsolute;
  return { cx: p.x + w / 2, cy: p.y + h / 2, hw: w / 2, hh: h / 2 };
}

/** 從 from 中心朝 to 中心畫線，取與 from 外框的交點與所在邊 */
function anchorToward(from: Box, to: Box): Anchor {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  if (dx === 0 && dy === 0) return { x: from.cx, y: from.cy, position: Position.Right };
  const tx = dx === 0 ? Infinity : from.hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : from.hh / Math.abs(dy);
  if (tx <= ty) {
    return {
      x: from.cx + Math.sign(dx) * from.hw,
      y: from.cy + dy * tx,
      position: dx > 0 ? Position.Right : Position.Left,
    };
  }
  return {
    x: from.cx + dx * ty,
    y: from.cy + Math.sign(dy) * from.hh,
    position: dy > 0 ? Position.Bottom : Position.Top,
  };
}

export function FloatingEdge({
  id,
  source,
  target,
  markerEnd,
  style,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps) {
  const sNode = useInternalNode(source);
  const tNode = useInternalNode(target);
  if (!sNode || !tNode) return null;
  const sBox = boxOf(sNode);
  const tBox = boxOf(tNode);
  if (!sBox || !tBox) return null;

  const s = anchorToward(sBox, tBox);
  const t = anchorToward(tBox, sBox);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: s.position,
    targetX: t.x,
    targetY: t.y,
    targetPosition: t.position,
  });

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}