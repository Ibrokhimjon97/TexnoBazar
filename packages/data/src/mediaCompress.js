/**
 * Brauzerda mijoz qurilmasida rasmlarni Canvas orqali siqish yordamchisi.
 * Katta hajmdagi (5-20 MB) rasmlarni sifatni saqlagan holda 150-350 KB gacha siqadi.
 *
 * @param {File|Blob} file
 * @param {object} [options]
 * @param {number} [options.maxWidth=1600]
 * @param {number} [options.maxHeight=1600]
 * @param {number} [options.quality=0.82]
 * @param {number} [options.skipSizeKb=400]
 * @returns {Promise<File|Blob>}
 */
export async function compressImageFile(file, {
  maxWidth = 1600,
  maxHeight = 1600,
  quality = 0.82,
  skipSizeKb = 400,
} = {}) {
  if (!file) return file;

  const rawType = (file.type || '').toLowerCase();
  const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
  const validMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

  // Agar hajm belgilangan me'yordan kichik bo'lsa (masalan 400KB), siqish shart emas
  if (file.size <= skipSizeKb * 1024) {
    if (validMimes.includes(rawType)) {
      return file;
    }
    const normalizedType = rawType === 'image/png' || ext === 'png' ? 'image/png'
      : rawType === 'image/webp' || ext === 'webp' ? 'image/webp'
      : rawType === 'image/avif' || ext === 'avif' ? 'image/avif'
      : 'image/jpeg';
    try {
      return new File([file], file.name || 'image.jpg', {
        type: normalizedType,
        lastModified: file.lastModified || Date.now(),
      });
    } catch {
      return file;
    }
  }

  // Faqat rastrli tasvirlarni siqamiz (SVG va animatsiyalarga tegilmaydi)
  const rasterTypes = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'];
  const isImageByName = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif'].includes(ext);

  if (rawType && !rasterTypes.includes(rawType) && !isImageByName) {
    return file;
  }

  // Brauzer muhiti tekshiruvi
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return file;
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;

      // Proporsional o'lchamni hisoblash
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.max(1, Math.round(width * ratio));
        height = Math.max(1, Math.round(height * ratio));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        resolve(file);
        return;
      }

      // Silliq masshtablash
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      // WebP formati qo'llab-quvvatlansa WebP, aks holda JPEG
      const outputType = 'image/webp';
      canvas.toBlob((blob) => {
        if (!blob || blob.size >= file.size) {
          if (validMimes.includes(rawType)) {
            resolve(file);
            return;
          }
          try {
            resolve(new File([file], file.name || 'image.jpg', {
              type: 'image/jpeg',
              lastModified: file.lastModified || Date.now(),
            }));
          } catch {
            resolve(file);
          }
          return;
        }

        const originalName = file.name || 'image.webp';
        const newName = originalName.replace(/\.[^.]+$/, '') + '.webp';
        const compressedFile = new File([blob], newName, {
          type: outputType,
          lastModified: Date.now(),
        });
        resolve(compressedFile);
      }, outputType, quality);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      const normalizedType = validMimes.includes(rawType) ? rawType : 'image/jpeg';
      try {
        resolve(new File([file], file.name || 'image.jpg', {
          type: normalizedType,
          lastModified: file.lastModified || Date.now(),
        }));
      } catch {
        resolve(file);
      }
    };

    img.src = objectUrl;
  });
}
