import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';

async function main() {
  const url = 'https://api.uzum.uz/api/v2/product/1801637';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'x-iis-trafficsource': 'direct'
    }
  });
  console.log('Status:', res.status);
  const json = await res.json();
  console.log('Payload keys:', Object.keys(json.payload || {}));
  console.log('Title:', json.payload?.title);
  console.log('Description:', json.payload?.description?.slice(0, 100));
  console.log('Photos:', json.payload?.photos?.map(p => p.high || p.photo?.high || p));
  console.log('Characteristics:', json.payload?.characteristics?.slice(0, 3));
}

main().catch(console.error);
