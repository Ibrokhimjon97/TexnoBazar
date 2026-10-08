async function main() {
  const url = 'https://uzum.uz/ru/product/domassi-smart-tv-2235832';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,uz;q=0.8,en;q=0.7'
    }
  });

  console.log('Status:', res.status);
  const html = await res.text();
  console.log('HTML Length:', html.length);

  const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
  console.log('og:image:', ogImg);

  const imagesUzum = [...html.matchAll(/https:\/\/images\.uzum\.uz\/([a-z0-9]+)\//gi)].map(m => m[1]);
  console.log('Images uzum keys:', [...new Set(imagesUzum)]);

  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (nextMatch) {
    console.log('__NEXT_DATA__ length:', nextMatch[1].length);
    try {
      const data = JSON.parse(nextMatch[1]);
      const str = JSON.stringify(data);
      const photoMatches = [...str.matchAll(/https:\/\/images\.uzum\.uz\/[a-z0-9]+\/[a-z0-9_.-]+/gi)].map(m => m[0]);
      console.log('Found photo URLs in Next.js data:', [...new Set(photoMatches)].slice(0, 5));
    } catch (e) {
      console.error('Parse err:', e.message);
    }
  }
}

main().catch(console.error);
