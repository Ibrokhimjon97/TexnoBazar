async function searchDDG(query) {
  try {
    const tokenRes = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const tokenHtml = await tokenRes.text();
    const vqd = tokenHtml.match(/vqd=['"]?([0-9-]+)['"]?/)?.[1];
    console.log('Query:', query, 'vqd token:', vqd);
    if (!vqd) return null;
    const res = await fetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://duckduckgo.com/'
      }
    });
    const data = await res.json();
    console.log('Results count:', data.results?.length);
    const first = data.results?.[0]?.image;
    console.log('First image:', first);
    return first;
  } catch (e) {
    console.error('DDG Error:', e.message);
    return null;
  }
}

async function main() {
  await searchDDG('Artel TG 70 kir yuvish mashinasi');
  await searchDDG('Avalon 2248 changyutgich');
  await searchDDG('Sonifer 8026 blender');
  await searchDDG('Kolyaska S-866');
}

main();
