import ExcelJS from 'exceljs';

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('tovarlar.xlsx');
  const ws = wb.worksheets[0];

  const testCodes = ['10860', '10854', '10853', '102000', '10849', '10745'];

  for (let r = 5; r <= ws.rowCount; r++) {
    const val = ws.getRow(r).values;
    const code = String(val[3] || '').trim();
    if (testCodes.includes(code)) {
      const urlRaw = val[7];
      const url = typeof urlRaw === 'object' ? (urlRaw.text || urlRaw.hyperlink) : urlRaw;
      console.log(`\nTesting Code: ${code}, Name: ${val[4]}`);
      console.log(`Row URL: ${url}`);
      if (url && url.startsWith('http')) {
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          });
          console.log(`HTTP status: ${res.status}`);
          const text = await res.text();
          console.log(`Body length: ${text.length}`);
          const ogImg = text.match(/<meta\s+property=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i)?.[1];
          console.log(`og:image: ${ogImg}`);
          // Check for JSON-LD images
          const jsonLdMatches = [...text.matchAll(/<script\s+type=["']application\/ld\+json["']>([^<]+)<\/script>/gi)];
          console.log(`JSON-LD scripts: ${jsonLdMatches.length}`);
          for (const m of jsonLdMatches) {
            try {
              const data = JSON.parse(m[1]);
              if (data.image) console.log('Found image in JSON-LD:', data.image);
            } catch {}
          }
          // Check for any images
          const allImgTags = [...text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
          console.log(`Total <img> tags: ${allImgTags.length}`);
          console.log(`Sample img tags:`, allImgTags.slice(0, 5));
        } catch (e) {
          console.log(`Fetch failed: ${e.message}`);
        }
      }
    }
  }
}

main().catch(console.error);
