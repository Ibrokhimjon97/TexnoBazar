import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const androidSdk = 'C:\\Users\\Ibrohim\\AppData\\Local\\Android\\Sdk';
const env = {
  ...process.env,
  ANDROID_HOME: androidSdk,
  ANDROID_SDK_ROOT: androidSdk
};

function copyRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function buildApkFor(appName, outputName) {
  console.log(`\n========================================`);
  console.log(`🔨 Building APK for ${appName}...`);
  console.log(`========================================`);

  const appDir = path.join(rootDir, 'apps', appName);
  const distDir = path.join(appDir, 'dist');
  const androidDir = path.join(appDir, 'android');
  const assetsPublicDir = path.join(androidDir, 'app', 'src', 'main', 'assets', 'public');

  if (!fs.existsSync(distDir)) {
    console.log(`[${appName}] Building web bundle first...`);
    execSync(`npm run build -w @texnobazar/${appName}`, { cwd: rootDir, stdio: 'inherit' });
  }

  // Copy dist to android assets public
  console.log(`[${appName}] Syncing web dist to android assets...`);
  copyRecursive(distDir, assetsPublicDir);

  // Run assembleDebug
  console.log(`[${appName}] Running Gradle assembleDebug...`);
  const gradlewCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  execSync(`${gradlewCmd} assembleDebug`, {
    cwd: androidDir,
    stdio: 'inherit',
    env
  });

  const apkSource = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const apksDir = path.join(rootDir, 'apks');
  if (!fs.existsSync(apksDir)) {
    fs.mkdirSync(apksDir, { recursive: true });
  }
  const apkTarget = path.join(apksDir, outputName);
  fs.copyFileSync(apkSource, apkTarget);

  const stats = fs.statSync(apkTarget);
  console.log(`✅ [${appName}] Successfully generated ${apkTarget} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
}

const appsToBuild = [
  { appName: 'seller', outputName: 'texnobazar-seller.apk' },
  { appName: 'courier', outputName: 'texnobazar-courier.apk' }
];

for (const { appName, outputName } of appsToBuild) {
  buildApkFor(appName, outputName);
}

console.log('\n🎉 All requested APKs have been built and saved to /apks directory!');
