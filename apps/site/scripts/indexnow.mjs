// Tells Bing, Yandex, Seznam and Naver (IndexNow) about every URL in the live sitemap, so new and changed pages are
// crawled within hours instead of weeks. Bing's index also feeds ChatGPT search and Copilot.
//   node scripts/indexnow.mjs            (after a deploy; the key file is public/8891afd8696c39e3c921dfe5c7a2b4ab.txt)
const KEY = "8891afd8696c39e3c921dfe5c7a2b4ab";
const host = "revenuedot.app";
const xml = await (await fetch(`https://${host}/sitemap.xml`)).text();
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key: KEY, keyLocation: `https://${host}/${KEY}.txt`, urlList }),
});
console.log(`IndexNow: ${urlList.length} URLs, HTTP ${res.status}`, await res.text());
