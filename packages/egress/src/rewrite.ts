/** Documents and images by URL extension: the browser has nothing to render for these. */
const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

export type FileKind = "document" | "image";

/** What the URL's path extension says the file is, if anything. */
export function fileKindOf(url: URL): FileKind | undefined {
  if (DOCUMENT_EXT.test(url.pathname)) return "document";
  if (IMAGE_EXT.test(url.pathname)) return "image";
  return undefined;
}

/**
 * Google Docs, Sheets, Slides and Drive links point at JavaScript editors; their export URLs return the file itself.
 * Pure: the result still has to pass the SSRF checks like any other URL. Other URLs come back unchanged.
 */
export function rewriteUrl(url: URL): URL {
  if (url.protocol !== "https:") return url;
  const id = (kind: string) => url.pathname.match(new RegExp(`^/${kind}/(?:u/\\d+/)?d/([\\w-]+)`))?.[1];

  if (url.hostname === "docs.google.com") {
    const doc = id("document") ?? id("presentation");
    if (doc) return new URL(`https://docs.google.com/${url.pathname.split("/")[1]}/d/${doc}/export?format=pdf`);
    const sheet = id("spreadsheets");
    if (sheet) {
      const gid = url.searchParams.get("gid") ?? url.hash.match(/gid=(\d+)/)?.[1];
      return new URL(`https://docs.google.com/spreadsheets/d/${sheet}/export?format=csv${gid ? `&gid=${gid}` : ""}`);
    }
  }
  if (url.hostname === "drive.google.com") {
    const file =
      url.pathname.match(/^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] ?? (url.pathname === "/open" ? url.searchParams.get("id") : null);
    if (file && /^[\w-]+$/.test(file)) return new URL(`https://drive.google.com/uc?export=download&id=${file}`);
  }
  return url;
}
