import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import JSZip from 'jszip';

// Force IPv4 first to avoid IPv6 handshake blackholing
dns.setDefaultResultOrder('ipv4first');

const rootDir = process.cwd();

function getNetlifyToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN;
  const configPath = path.join(process.env.APPDATA, 'netlify', 'Config', 'config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const userId = config.userId || Object.keys(config.users || {})[0];
    const token = config.users?.[userId]?.auth?.token;
    if (token) return token;
  }
  throw new Error('Netlify auth token not found');
}

async function zipDir(dirPath) {
  const zip = new JSZip();
  function addFiles(currentDir, relativePath = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        addFiles(fullPath, entryRelPath);
      } else {
        zip.file(entryRelPath, fs.readFileSync(fullPath));
      }
    }
  }
  addFiles(dirPath);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function deployApp(appName) {
  const appDir = path.join(rootDir, 'apps', appName);
  const statePath = path.join(appDir, '.netlify', 'state.json');
  if (!fs.existsSync(statePath)) {
    console.error(`State file not found for ${appName}`);
    return;
  }
  const { siteId } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const distDir = path.join(appDir, 'dist');
  if (!fs.existsSync(distDir)) {
    console.error(`Dist directory not found for ${appName} at ${distDir}`);
    return;
  }

  const token = getNetlifyToken();
  console.log(`[${appName}] Zipping ${distDir}...`);
  const zipBuffer = await zipDir(distDir);
  console.log(`[${appName}] Zip size: ${(zipBuffer.length / 1024).toFixed(1)} KB. Uploading to Netlify site ${siteId}...`);

  const response = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zipBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[${appName}] Deploy failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  console.log(`[${appName}] ✅ Deployed successfully!`);
  console.log(`   Deploy ID: ${data.id}`);
  console.log(`   Deploy URL: ${data.deploy_ssl_url || data.ssl_url || data.url}`);
  console.log(`   State: ${data.state}`);
  return data;
}

const targetApps = process.argv.slice(2);
const appsToDeploy = targetApps.length > 0 ? targetApps : ['manager', 'seller'];

for (const app of appsToDeploy) {
  try {
    await deployApp(app);
  } catch (err) {
    console.error(`Failed to deploy ${app}:`, err.message);
  }
}
