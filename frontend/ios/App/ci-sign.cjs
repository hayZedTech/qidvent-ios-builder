const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const KEY_ID = (process.env.ASC_KEY_ID || '6B7GBH3L68').trim();
const ISSUER_ID = (process.env.ASC_ISSUER_ID || '47098a6f-5c01-48d7-b576-1525716fdcda').trim();
const TEAM_ID = (process.env.APPLE_TEAM_ID || 'CA6ZDBBPX4').trim();
const BUNDLE_ID = 'com.qidvent.inventory';

const KEY_PARTS = [
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR1RBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJIa3dkd0lCQVFRZzF0VFVyL0xOZnVaOXh3WHMKNldSdGVEUXFVQ21Wd3A1OG1OWmtvVGhzTjB5Z0NnWUlLb1pJemowREFRZWhSQU5DQUFScFJFT1BLYmp1dU85MApMMThNWkc4MFFSZkE0WWRRaUE2TkhkT1pYZHlIelNyYm9pdWlHYjB6Ymk5ZUYwVEE1QVFrYzdRaGY3RWhmT2o3Cm1Sb0IvOVM5Ci0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0='
];
const DEFAULT_KEY = Buffer.from(KEY_PARTS.join(''), 'base64').toString('utf8');

const rawKey = (process.env.ASC_PRIVATE_KEY || DEFAULT_KEY).trim();

function ensurePrivateKeyFile() {
  const keysDir = path.join(os.homedir(), '.appstoreconnect', 'private_keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const keyPath = path.join(keysDir, `AuthKey_${KEY_ID}.p8`);
  fs.writeFileSync(keyPath, rawKey + '\n', { mode: 0o600 });
  return keyPath;
}

function makeJwt(privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER_ID,
    iat: now - 60,
    exp: now + 1100,
    aud: 'appstoreconnect-v1'
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `${signingInput}.${sig}`;
}

function ascRequest(method, reqPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.appstoreconnect.apple.com',
      path: reqPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let resp = '';
      res.on('data', (chunk) => { resp += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(resp ? JSON.parse(resp) : {});
        } else {
          reject(new Error(`ASC API ${method} ${reqPath} failed (${res.statusCode}): ${resp}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setupSigning() {
  const keyPath = ensurePrivateKeyFile();
  const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
  const token = makeJwt(privateKeyPem);

  const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();
  const distKeyPath = path.join(tmpDir, 'dist.key');
  const distCsrPath = path.join(tmpDir, 'dist.csr');
  const distDerPath = path.join(tmpDir, 'dist.cer');
  const distPemPath = path.join(tmpDir, 'dist.pem');
  const distP12Path = path.join(tmpDir, 'dist.p12');
  const stateFilePath = path.join(tmpDir, 'asc-ci-state.json');

  execSync(`openssl genrsa -out "${distKeyPath}" 2048`);
  execSync(`openssl req -new -key "${distKeyPath}" -out "${distCsrPath}" -subj "/CN=Qidvent CI Distribution/O=Qidvent/C=US"`);

  const csrPem = fs.readFileSync(distCsrPath, 'utf8');
  const csrContent = csrPem
    .replace(/-----BEGIN CERTIFICATE REQUEST-----/g, '')
    .replace(/-----END CERTIFICATE REQUEST-----/g, '')
    .replace(/\s+/g, '');

  const certResp = await ascRequest('POST', '/v1/certificates', {
    data: {
      type: 'certificates',
      attributes: {
        certificateType: 'IOS_DISTRIBUTION',
        csrContent
      }
    }
  }, token);

  const certId = certResp.data.id;
  const certContentB64 = certResp.data.attributes.certificateContent;
  fs.writeFileSync(distDerPath, Buffer.from(certContentB64, 'base64'));
  console.log(`Created ephemeral IOS_DISTRIBUTION certificate: ${certId}`);

  execSync(`openssl x509 -inform DER -in "${distDerPath}" -out "${distPemPath}"`);
  execSync(`openssl pkcs12 -export -legacy -out "${distP12Path}" -inkey "${distKeyPath}" -in "${distPemPath}" -passout pass:qidventci`);

  const bundleResp = await ascRequest('GET', `/v1/bundleIds?filter[identifier]=${BUNDLE_ID}`, null, token);
  const bundleResource = (bundleResp.data || []).find((b) => b.attributes.identifier === BUNDLE_ID) || bundleResp.data[0];
  if (!bundleResource) {
    throw new Error(`Bundle ID ${BUNDLE_ID} not found in App Store Connect.`);
  }

  const profileName = `Qidvent CI AppStore ${Date.now()}`;
  const profileResp = await ascRequest('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: {
        name: profileName,
        profileType: 'IOS_APP_STORE'
      },
      relationships: {
        bundleId: {
          data: { type: 'bundleIds', id: bundleResource.id }
        },
        certificates: {
          data: [{ type: 'certificates', id: certId }]
        }
      }
    }
  }, token);

  const profileId = profileResp.data.id;
  const profileUuid = profileResp.data.attributes.uuid;
  const profileContentB64 = profileResp.data.attributes.profileContent;

  const profilesDir = path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const profileFile = path.join(profilesDir, `${profileUuid}.mobileprovision`);
  fs.writeFileSync(profileFile, Buffer.from(profileContentB64, 'base64'));
  console.log(`Installed provisioning profile: ${profileName} (${profileUuid})`);

  // Configure App.xcodeproj/project.pbxproj for manual distribution signing on App target
  const pbxprojPath = path.join(__dirname, 'App.xcodeproj', 'project.pbxproj');
  let pbx = fs.readFileSync(pbxprojPath, 'utf8');
  pbx = pbx.replace(/CODE_SIGN_STYLE = Automatic;/g, [
    'CODE_SIGN_STYLE = Manual;',
    `\t\t\t\tCODE_SIGN_IDENTITY = "iPhone Distribution";`,
    `\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Distribution";`,
    `\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "${profileName}";`
  ].join('\n'));
  fs.writeFileSync(pbxprojPath, pbx);

  // Configure ExportOptions.plist with exact provisioning profile
  const exportPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>app-store-connect</string>
\t<key>teamID</key>
\t<string>${TEAM_ID}</string>
\t<key>signingStyle</key>
\t<string>manual</string>
\t<key>signingCertificate</key>
\t<string>iPhone Distribution</string>
\t<key>provisioningProfiles</key>
\t<dict>
\t\t<key>${BUNDLE_ID}</key>
\t\t<string>${profileName}</string>
\t</dict>
\t<key>uploadSymbols</key>
\t<true/>
\t<key>destination</key>
\t<string>export</string>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(__dirname, 'ExportOptions.plist'), exportPlist);

  fs.writeFileSync(stateFilePath, JSON.stringify({
    certId,
    profileId,
    profileUuid,
    profileName,
    keyPath,
    distP12Path
  }, null, 2));

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, [
      `ASC_KEY_PATH=${keyPath}`,
      `ASC_KEY_ID_VAL=${KEY_ID}`,
      `ASC_ISSUER_ID_VAL=${ISSUER_ID}`,
      `ASC_PROFILE_UUID=${profileUuid}`,
      `ASC_PROFILE_NAME=${profileName}`,
      `ASC_P12_PATH=${distP12Path}`,
      ''
    ].join('\n'));
  }
}

async function cleanupSigning() {
  const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();
  const stateFilePath = path.join(tmpDir, 'asc-ci-state.json');
  if (!fs.existsSync(stateFilePath)) {
    console.log('No ephemeral ASC signing state to clean up.');
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  const privateKeyPem = fs.readFileSync(state.keyPath, 'utf8');
  const token = makeJwt(privateKeyPem);

  if (state.profileId) {
    try {
      await ascRequest('DELETE', `/v1/profiles/${state.profileId}`, null, token);
      console.log(`Deleted ephemeral provisioning profile: ${state.profileId}`);
    } catch (err) {
      console.warn(`Warning cleaning up profile ${state.profileId}:`, err.message);
    }
  }

  if (state.certId) {
    try {
      await ascRequest('DELETE', `/v1/certificates/${state.certId}`, null, token);
      console.log(`Revoked ephemeral IOS_DISTRIBUTION certificate: ${state.certId}`);
    } catch (err) {
      console.warn(`Warning cleaning up certificate ${state.certId}:`, err.message);
    }
  }
}

const action = process.argv[2] || 'setup';
if (action === 'setup') {
  setupSigning().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (action === 'cleanup') {
  cleanupSigning().catch((err) => {
    console.error(err);
    process.exit(0);
  });
}
