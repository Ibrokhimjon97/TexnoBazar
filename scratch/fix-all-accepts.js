const fs = require('fs');
// Update InventoryRegisterModal.jsx CreateProductForm file input
const path1 = 'apps/manager/src/InventoryRegisterModal.jsx';
let c1 = fs.readFileSync(path1, 'utf8');
c1 = c1.replace('accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={e=>{const files=[...e.target.files];if(files.length){setImages(prev=>[...prev,...files])}e.target.value=\'\'}}', 'accept="image/*" multiple hidden onChange={e=>{const files=[...e.target.files];if(files.length){setImages(prev=>[...prev,...files])}e.target.value=\'\'}}');
fs.writeFileSync(path1, c1, 'utf8');
console.log('Updated InventoryRegisterModal accept:', c1.includes('accept="image/*"') ? 'YES' : 'NO');

// Update InventoryWorkspace.jsx file input
const path2 = 'apps/manager/src/InventoryWorkspace.jsx';
let c2 = fs.readFileSync(path2, 'utf8');
c2 = c2.replace(/accept="image\/jpeg,image\/png,image\/webp,image\/avif"/g, 'accept="image/*"');
fs.writeFileSync(path2, c2, 'utf8');
const matches = c2.match(/accept="image\/\*"/g);
console.log('Updated InventoryWorkspace accept count:', matches ? matches.length : 0);

// Update ColorVariantEditor.jsx file input
const path3 = 'packages/ui/src/ColorVariantEditor.jsx';
let c3 = fs.readFileSync(path3, 'utf8');
c3 = c3.replace(/accept="image\/jpeg,image\/png,image\/webp,image\/avif"/g, 'accept="image/*"');
fs.writeFileSync(path3, c3, 'utf8');
console.log('Updated ColorVariantEditor accept:', c3.includes('accept="image/*"') ? 'YES' : 'NO');
