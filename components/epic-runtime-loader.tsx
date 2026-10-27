"use client";

import { useEffect } from "react";

const MARKER = "data-epic-runtime";

/** Appends the runtime's script once, after hydration; a failed load is removed and the app carries on. */
export function EpicRuntimeLoader({ src, release }: { src: string; release: string }) {
  useEffect(() => {
    if (document.querySelector(`script[${MARKER}]`)) return;
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.setAttribute(MARKER, "");
    script.dataset.relay = "/api/epic";
    script.dataset.release = release;
    script.addEventListener("error", () => script.remove(), { once: true });
    document.head.appendChild(script);
  }, [src, release]);

  return null;
}
