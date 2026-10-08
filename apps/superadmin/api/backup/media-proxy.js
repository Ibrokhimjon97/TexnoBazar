import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from '@texnobazar/server/r2';
import { applyCors } from '../_lib/cors.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    let key = '';
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      key = url.searchParams.get('key') || '';
    } else {
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }
      const json = JSON.parse(bodyStr || '{}');
      key = json.key || '';
    }

    if (!key) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'R2 key required' }));
    }

    const cleanKey = String(key).replace(/^\/+/, '');
    const r2 = createR2Client();
    const bucket = process.env.R2_BUCKET;

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: cleanKey,
    });

    const response = await r2.send(command);

    res.setHeader('Content-Type', response.ContentType || 'application/octet-stream');
    if (response.ContentLength) {
      res.setHeader('Content-Length', response.ContentLength);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // Stream the readable stream to res
    const stream = response.Body;
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('media-proxy error:', error.message);
    res.statusCode = error.name === 'NoSuchKey' ? 404 : 500;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ error: error.message || 'Media yuklab olinmadi' }));
  }
}
