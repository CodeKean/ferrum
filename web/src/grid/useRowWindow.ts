// Row virtualization with SCROLL-SPACE COMPRESSION.
//
// Why this is hand-rolled rather than a virtualizer library:
//
// Browsers cap the height of a single element. In Chrome the ceiling is about 22,369,622px.
// A million rows at 32px needs 32,000,000px of scroll space, so the spacer is silently
// clamped and the last ~300,000 rows become unreachable — scrolling to the very bottom lands on row
// 699,017. No amount of overscan tuning fixes that; the addressable space simply is not there.
//
// The fix is to decouple scroll pixels from content pixels. The spacer is capped below the browser
// limit, and scrollTop is scaled onto the true row range:
//
//     scale     = naturalHeight / spacerHeight        (1 when the sheet fits, > 1 when compressed)
//     firstRow  = floor(scrollTop * scale / rowH)
//     rowOffset = (i - firstRow) * rowH + scrollTop
//
// Rows stay pixel-exact within the viewport; only the mapping from scrollbar position to row index
// is compressed. The tradeoff is that wheel scrolling moves content `scale`x faster than the
// gesture — at a million rows that is 1.43x, which is mild. It is also the only way to reach row
// 1,000,000 at all, so it is the right trade.

import { useCallback, useEffect, useRef, useState } from "react";

/** Kept safely under the observed browser ceiling rather than at it, since the exact cap varies by
 *  browser and platform and a clamped spacer fails silently. */
const MAX_SPACER_PX = 20_000_000;

export interface RowWindowResult {
  /** Index of the first row to render. */
  firstRow: number;
  /** Rows to render, in order, starting at firstRow. */
  indices: number[];
  /** Height of the scroll spacer element. */
  spacerHeight: number;
  /** Translate each rendered row by this, plus (i - firstRow) * rowH. */
  baseOffset: number;
  /** > 1 when scroll space is compressed. Surfaced so the UI can explain the behaviour. */
  scale: number;
}

export function useRowWindow(
  scrollRef: React.RefObject<HTMLElement | null>,
  total: number,
  rowH: number,
  overscan = 8,
): RowWindowResult {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const ticking = useRef(false);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || ticking.current) return;
    ticking.current = true;
    // Coalesce to one update per frame: a fast wheel spin fires scroll events far more often than
    // the display refreshes, and each one would otherwise be a full re-render.
    requestAnimationFrame(() => {
      ticking.current = false;
      setScrollTop(el.scrollTop);
    });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scrollRef, onScroll]);

  const naturalHeight = total * rowH;
  const spacerHeight = Math.min(naturalHeight, MAX_SPACER_PX);
  const scale = spacerHeight > 0 ? naturalHeight / spacerHeight : 1;

  const visibleCount = Math.ceil(viewportH / rowH) + overscan * 2;
  const rawFirst = Math.floor((scrollTop * scale) / rowH) - overscan;
  const firstRow = Math.max(0, Math.min(rawFirst, Math.max(0, total - visibleCount)));

  const indices: number[] = [];
  for (let i = firstRow; i < Math.min(total, firstRow + visibleCount); i++) indices.push(i);

  return { firstRow, indices, spacerHeight, baseOffset: scrollTop, scale };
}
