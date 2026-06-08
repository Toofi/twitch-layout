// Lance ce script UNE SEULE FOIS pour obtenir un refresh_token Twitch.
// Usage : node get-twitch-refresh-token.js
//
// Prérequis : dans dev.twitch.tv/console → ton app → OAuth Redirect URLs
//             ajoute http://localhost:18888/callback

const http   = require('http');
const https  = require('https');
const url    = require('url');
const { exec } = require('child_process');

const CLIENT_ID     = '2u00o86legvbgoo6lwpmorczuatjib';
const CLIENT_SECRET = '2ugkp32z3q1hb2jepdwk247ycxoz5l';
const REDIRECT_URI  = 'http://localhost:18888/callback';
const SCOPE         = 'moderator:read:followers channel:read:subscriptions bits:read channel:read:hype_train user:read:chat';

const authUrl =
  `https://id.twitch.tv/oauth2/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}`;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/callback')) { res.end(); return; }

  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400); res.end('Pas de code dans la réponse.');
    return;
  }

  // Échange le code contre access_token + refresh_token
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI,
  }).toString();

  const data = await new Promise((resolve, reject) => {
    const reqOut = https.request({
      hostname: 'id.twitch.tv',
      path:     '/oauth2/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, r => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => resolve(JSON.parse(raw)));
    });
    reqOut.on('error', reject);
    reqOut.write(body);
    reqOut.end();
  });

  if (!data.refresh_token) {
    res.writeHead(500);
    res.end('Erreur : ' + JSON.stringify(data));
    console.error('Erreur Twitch :', data);
    server.close();
    return;
  }

  console.log('\n✅ Tokens obtenus !');
  console.log('─────────────────────────────────────────────');
  console.log('access_token  :', data.access_token);
  console.log('refresh_token :', data.refresh_token);
  console.log('─────────────────────────────────────────────');
  console.log('\nColle le refresh_token dans tes layouts quand je te le demande.\n');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<h2>✅ Succès !</h2><p>Ferme cet onglet et reviens dans le terminal.</p>`);
  server.close();
});

server.listen(18888, () => {
  console.log('Serveur local démarré sur le port 18888.');
  console.log('Ouverture du navigateur pour l\'autorisation Twitch...\n');
  // Ouvre le navigateur
  const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` : `open "${authUrl}"`;
  exec(cmd);
});
