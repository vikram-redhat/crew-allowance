/**
 * Extract plain text from a PDF ArrayBuffer (browser, pdf.js).
 * Used for IndiGo AIMS-style reports where data is text-based (not scanned images).
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function pdfArrayBufferToText(buffer) {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const doc = await pdfjs.getDocument({ data }).promise;
  const parts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const line = content.items.map(it => ("str" in it ? it.str : "")).join(" ");
    parts.push(line);
  }
  return parts.join("\n");
}
