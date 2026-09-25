import { XMLParser } from "fast-xml-parser";

// Google News RSS — no key, no account, per the case's B1 spec.
export async function fetchNews(query) {
  if (!query) return null;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=en-IN&gl=IN&ceid=IN:en`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SkinstinctContentEngine/1.0)" },
  });
  if (!res.ok) return null;

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch {
    return null;
  }

  const items = parsed?.rss?.channel?.item;
  const first = Array.isArray(items) ? items[0] : items;
  if (!first) return null;

  const title = String(first.title || "").trim();
  // Google News titles are usually "Headline - Source"
  const sourceFromTitle = title.includes(" - ") ? title.split(" - ").pop() : "";
  const source = String(first.source?.["#text"] || first.source || sourceFromTitle || "").trim();
  const headline = sourceFromTitle ? title.slice(0, title.lastIndexOf(" - ")) : title;

  return {
    title: headline,
    source,
    date: first.pubDate ? new Date(first.pubDate).toISOString().slice(0, 10) : "",
    link: String(first.link || "").trim(),
    summary: String(first.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 240),
  };
}
