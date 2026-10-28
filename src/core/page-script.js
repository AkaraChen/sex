// Page-side extraction, shared by both engines.
//
// This file is imported as text and must stay a single self-contained
// function expression: in browser mode it is injected into the page (next to
// Defuddle's browser bundle) and called with `document`; in Node mode it is
// compiled with `new Function` and called with a linkedom document. It must
// not reference anything outside its parameters.
// biome-ignore lint/correctness/noUnusedVariables: invoked by the host after injection
async function sexExtract(doc, opts, runDefuddle) {
  const base = (() => {
    const href = doc.querySelector("base[href]")?.getAttribute("href");
    try {
      return new URL(href || opts.url, opts.url).href;
    } catch {
      return opts.url;
    }
  })();
  const abs = (value) => {
    if (!value) return null;
    try {
      const u = new URL(value.trim(), base);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  };
  const safeQueryAll = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  // ---- metadata (from the untouched document)
  const META_MAP = {
    description: "description",
    keywords: "keywords",
    robots: "robots",
    "og:title": "ogTitle",
    "og:description": "ogDescription",
    "og:url": "ogUrl",
    "og:image": "ogImage",
    "og:audio": "ogAudio",
    "og:determiner": "ogDeterminer",
    "og:locale": "ogLocale",
    "og:locale:alternate": "ogLocaleAlternate",
    "og:site_name": "ogSiteName",
    "og:video": "ogVideo",
    "dcterms.created": "dcTermsCreated",
    "dc.date.created": "dcDateCreated",
    "dc.date": "dcDate",
    "dcterms.type": "dcTermsType",
    "dc.type": "dcType",
    "dcterms.audience": "dcTermsAudience",
    "dcterms.subject": "dcTermsSubject",
    "dc.subject": "dcSubject",
    "dc.description": "dcDescription",
    "dcterms.keywords": "dcTermsKeywords",
    "article:modified_time": "modifiedTime",
    "article:published_time": "publishedTime",
    "article:tag": "articleTag",
    "article:section": "articleSection",
  };
  const metadata = {};
  const add = (key, value) => {
    if (key in metadata) {
      const prev = metadata[key];
      if (Array.isArray(prev)) {
        if (!prev.includes(value)) prev.push(value);
      } else if (prev !== value) metadata[key] = [prev, value];
    } else metadata[key] = value;
  };
  for (const meta of safeQueryAll(doc, "meta")) {
    const name = meta.getAttribute("name") || meta.getAttribute("property") || meta.getAttribute("itemprop");
    const content = meta.getAttribute("content");
    if (!name || content == null) continue;
    const mapped = META_MAP[name.toLowerCase()];
    // Both names are kept: the Firecrawl camelCase name and the original one (`og:title`).
    if (mapped) add(mapped, content);
    if (mapped !== name) add(name, content);
  }
  if (Array.isArray(metadata.ogLocaleAlternate) === false && metadata.ogLocaleAlternate)
    metadata.ogLocaleAlternate = [metadata.ogLocaleAlternate];
  const title = doc.querySelector("title")?.textContent?.trim();
  const firstOf = (v) => (Array.isArray(v) ? v[0] : v);
  const fallbackTitle = firstOf(metadata["og:title"]) || firstOf(metadata["twitter:title"]);
  if (title) metadata.title = title;
  else if (!metadata.title && fallbackTitle) metadata.title = fallbackTitle;
  const lang = doc.documentElement?.getAttribute("lang");
  if (lang) metadata.language = lang;
  const icon = doc.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  const favicon = abs(icon?.getAttribute("href"));
  if (favicon) metadata.favicon = favicon;

  // ---- links / images / attributes (from the untouched document)
  // Whole-page links without their #fragment, deduplicated; pure #fragment links are dropped and mailto: is kept.
  const linkUrl = (value) => {
    const v = (value || "").trim();
    if (!v || v.startsWith("#")) return null;
    if (/^mailto:/i.test(v)) return v;
    const url = abs(v);
    return url ? url.replace(/#.*$/, "") : null;
  };
  const links = opts.wantLinks
    ? Array.from(
        new Set(
          safeQueryAll(doc, "a[href]")
            .map((a) => linkUrl(a.getAttribute("href")))
            .filter(Boolean),
        ),
      )
    : undefined;
  const linkTitles = {};
  if (opts.wantLinkTitles) {
    for (const a of safeQueryAll(doc, "a[href]")) {
      const href = linkUrl(a.getAttribute("href"));
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (href && text && !linkTitles[href]) linkTitles[href] = text.slice(0, 200);
    }
  }
  // Lazy-loading pages keep a data: placeholder in `src` and the real URL in a data attribute.
  const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original"];
  const imageUrl = (img) => {
    for (const attr of ["src", ...LAZY_ATTRS]) {
      const url = abs(img.getAttribute(attr));
      if (url) return url;
    }
    return null;
  };
  // Every candidate of a srcset ("a.jpg 1x, b.jpg 2x"), made absolute.
  const srcsetUrls = (el) =>
    (el.getAttribute("srcset") || "")
      .split(/\s*,\s+/)
      .map((c) => abs(c.trim().split(/\s+/)[0].replace(/,$/, "")))
      .filter(Boolean);
  const metaImages = ["ogImage", "og:image:secure_url", "twitter:image"].flatMap((k) =>
    [].concat(metadata[k] || []).map((v) => abs(String(v))),
  );
  const images = opts.wantImages
    ? Array.from(
        new Set(
          safeQueryAll(doc, "img")
            .flatMap((img) => [imageUrl(img), ...srcsetUrls(img)])
            .concat(safeQueryAll(doc, "picture source[srcset]").flatMap(srcsetUrls))
            .concat(safeQueryAll(doc, "video[poster]").map((v) => abs(v.getAttribute("poster"))))
            .concat(metaImages)
            .filter(Boolean),
        ),
      )
    : undefined;
  const attributes = (opts.attributes || []).map(({ selector, attribute }) => ({
    selector,
    attribute,
    values: safeQueryAll(doc, selector)
      .map((el) => el.getAttribute(attribute) ?? el.getAttribute(`data-${attribute}`))
      .filter((v) => v != null),
  }));

  // ---- pre-processing before Defuddle
  if (opts.removeBase64Images) {
    for (const img of safeQueryAll(doc, 'img[src^="data:"]')) {
      // Keep lazy-loaded images: swap the inline placeholder for the real URL instead of dropping the image.
      const real = LAZY_ATTRS.map((attr) => img.getAttribute(attr)).find((v) => abs(v));
      if (real) img.setAttribute("src", real);
      else img.remove();
    }
  }
  for (const selector of opts.excludeTags || []) {
    for (const el of safeQueryAll(doc, selector)) el.remove();
  }
  const scoped = (opts.includeTags || []).length > 0;
  if (scoped && doc.body) {
    const kept = [];
    for (const selector of opts.includeTags) {
      for (const el of safeQueryAll(doc, selector)) {
        if (!kept.some((k) => k.contains(el))) kept.push(el);
      }
    }
    const clones = kept.map((el) => el.cloneNode(true));
    while (doc.body.firstChild) doc.body.removeChild(doc.body.firstChild);
    for (const c of clones) doc.body.appendChild(c);
  }

  const full = scoped || opts.onlyMainContent === false;
  const result = await runDefuddle(doc, {
    url: opts.url,
    separateMarkdown: true,
    useAsync: false,
    ...(full
      ? {
          contentSelector: "body",
          removeExactSelectors: false,
          removePartialSelectors: false,
          removeLowScoring: false,
          removeSmallImages: false,
        }
      : {}),
  });

  return {
    metadata,
    links,
    linkTitles: opts.wantLinkTitles ? linkTitles : undefined,
    images,
    attributes,
    html: result.content || "",
    markdown: result.contentMarkdown || "",
    defuddle: {
      title: result.title || "",
      description: result.description || "",
      author: result.author || "",
      published: result.published || "",
      site: result.site || "",
      image: result.image || "",
      language: result.language || "",
      wordCount: result.wordCount || 0,
    },
  };
}
