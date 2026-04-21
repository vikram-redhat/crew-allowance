/**
 * Extract plain text from a PDF ArrayBuffer (browser, pdf.js).
 * Used for IndiGo AIMS-style reports where data is text-based (not scanned images).
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// ── one-page flattened text (legacy API) ─────────────────────────────────────
export async function pdfArrayBufferToText(buffer) {
  const { pages } = await pdfArrayBufferToItems(buffer);
  return pages.map(p => p.items.map(it => it.str).join(" ")).join("\n");
}

// ── structured item-level extraction ─────────────────────────────────────────
// Returns per-page items with coordinates. Used by pcsrParser's grid-first path
// so sector dates can be derived from x-position under the calendar header row
// instead of the (unreliable) Other Crew section on pages 2+.
export async function pdfArrayBufferToItems(buffer) {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({
        str: "str" in it ? it.str : "",
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
        w: it.width ?? 0,
        h: it.height ?? 0,
      }))
      .filter(it => it.str !== "");
    pages.push({ items });
  }
  return { pages };
}
