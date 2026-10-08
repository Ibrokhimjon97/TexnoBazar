async function searchImage(query) {
  try {
    const tokenRes = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const tokenHtml = await tokenRes.text();
    const vqd = tokenHtml.match(/vqd=['"]?([0-9-]+)['"]?/)?.[1];
    if (!vqd) return null;
    const res = await fetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://duckduckgo.com/' }
    });
    const data = await res.json();
    return data.results?.[0]?.image || null;
  } catch {
    return null;
  }
}

async function main() {
  const queries = [
    'Kolyaska S866 bolalar aravachasi',
    'Domassi 32-Q32i televizor',
    'Domassi 55-Q55i televizor',
    'Chopper LG888 3.8L maydalagich',
    'LF 356G Loretto morozilnik muzlatgich'
  ];

  for (const q of queries) {
    const img = await searchImage(q);
    console.log(`[${q}] -> ${img}`);
  }
}

main();
