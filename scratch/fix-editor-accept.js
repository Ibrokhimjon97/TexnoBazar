const fs = require('fs');
const path = 'packages/ui/src/ProductEditor.jsx';
let c = fs.readFileSync(path, 'utf8');
c = c.replace('accept="image/jpeg,image/png,image/webp,image/avif"', 'accept="image/*"');
c = c.replace("!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type)", "!file.type.startsWith('image/')");
c = c.replace('faqat JPG, PNG, WebP yoki AVIF, maksimal 10 MB.', 'faqat rasm fayli, maksimal 10 MB.');
fs.writeFileSync(path, c, 'utf8');
const match = c.match(/accept="[^"]+" multiple hidden/);
console.log('Done, accept:', match ? match[0] : 'not found');
