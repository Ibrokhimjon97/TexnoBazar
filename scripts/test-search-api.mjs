async function testSearch(q) {
  console.log(`\nSearching for: ${q}`);
  try {
    const res = await fetch(`https://asaxiy.uz/ru/search?query=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const html = await res.text();
    const links = [...html.matchAll(/href=["'](\/ru\/product\/[^"']+)["']/gi)].map(m => m[1]);
    const unique = [...new Set(links)];
    console.log(`Found ${unique.length} links on Asaxiy:`, unique.slice(0, 3));
    if (unique.length > 0) {
      const prodRes = await fetch(`https://asaxiy.uz${unique[0]}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const prodHtml = await prodRes.text();
      const img = prodHtml.match(/<meta\s+property=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i)?.[1];
      console.log('Image found:', img);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function main() {
  await testSearch('Avalon 2248');
  await testSearch('Artel C2600');
  await testSearch('Sonifer 8026');
  await testSearch('Artel TG 70');
}

main();
