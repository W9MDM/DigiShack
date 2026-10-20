// Draw-on-demand for the spectrum canvases, plus a pool of DOM labels moved per draw.
//
// Nothing here runs continuously. A draw is requested by new data, by interaction, by a
// resize or by a slow clock tick, coalesced into one animation frame, and skipped while
// the tab is hidden or the canvas is scrolled out of view — the request is remembered and
// honoured when it becomes visible again. A page left open on a shack PC for hours costs
// a few draws a second while watched and nothing while not.

import { useCallback, useEffect, useRef, type RefObject } from "react";

export function useDrawScheduler(
  targetRef: RefObject<Element | null>,
  draw: () => void,
): () => void {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const raf = useRef<number | null>(null);
  const pending = useRef(false);
  const onScreen = useRef(true);

  const visible = () => onScreen.current && typeof document !== "undefined" && !document.hidden;

  const request = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      if (!visible()) {
        pending.current = true;
        return;
      }
      pending.current = false;
      drawRef.current();
    });
  }, []);

  useEffect(() => {
    const el = targetRef.current;
    const wake = () => {
      if (pending.current && visible()) request();
    };
    let io: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        if (e) onScreen.current = e.isIntersecting;
        wake();
      });
      io.observe(el);
    }
    document.addEventListener("visibilitychange", wake);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", wake);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [targetRef, request]);

  return request;
}

/** Whether the operator has asked the system for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * A fixed set of absolutely positioned spans, repositioned each draw without React.
 * Text is only rewritten when it changes, so a steady axis touches the DOM for transforms only.
 */
export class LabelPool {
  private readonly els: HTMLSpanElement[] = [];
  private readonly texts: string[] = [];
  private used = 0;

  constructor(container: HTMLElement, size: number, className: string) {
    for (let i = 0; i < size; i++) {
      const el = document.createElement("span");
      el.className = className;
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.top = "0";
      el.style.display = "none";
      el.style.willChange = "transform";
      container.appendChild(el);
      this.els.push(el);
      this.texts.push("");
    }
  }

  begin(): void {
    this.used = 0;
  }

  /** Place a label with its anchor point at (x, y) CSS px; `ax`/`ay` are the anchor as a fraction of its size. */
  place(text: string, x: number, y: number, ax = 0, ay = 0.5): void {
    const el = this.els[this.used];
    if (!el) return;
    if (this.texts[this.used] !== text) {
      el.textContent = text;
      this.texts[this.used] = text;
    }
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${-ax * 100}%, ${-ay * 100}%)`;
    el.style.display = "";
    this.used++;
  }

  end(): void {
    for (let i = this.used; i < this.els.length; i++) {
      const el = this.els[i]!;
      if (el.style.display !== "none") el.style.display = "none";
    }
  }

  dispose(): void {
    for (const el of this.els) el.remove();
    this.els.length = 0;
  }
}
