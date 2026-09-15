export function selectorMenuPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  // Match the menu's CSS maximum size (viewport minus 24px). Centre on the
  // interaction point, but keep the whole measured panel inside the viewport.
  const margin = 12;
  return {
    left: Math.max(margin, Math.min(anchor.x - size.width / 2, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(anchor.y - size.height / 2, viewport.height - size.height - margin))
  };
}
