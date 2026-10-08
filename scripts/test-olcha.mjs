async function testOlcha() {
  try {
    const res = await fetch('https://uzum.uz/uz/product/kir-yuvish-mashinasi-yarim-avtomatik-artel-art-tg70-761366', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const ogImg = html.match(/<meta\s+property=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i)?.[1];
    console.log('Uzum og:image:', ogImg);
    const matches = [...html.matchAll(/https:\/\/images\.uzum\.uz\/[^\s"']+\.(?:jpg|png|webp)/gi)];
    console.log('Uzum images found:', matches.map(m => m[0]).slice(0, 3));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testOlcha();
