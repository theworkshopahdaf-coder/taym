const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const MAX = 45, BAN_MS = 10 * 60 * 1000;
const L = s => s.split(',');
const WORDS = {
  easy: L('friend,because,school,garden,animal,orange,family,window,purple,monkey,planet,pencil,rabbit,yellow,bridge,castle'),
  medium: L('necessary,rhythm,calendar,separate,island,jealous,library,mountain,exercise,knowledge,beautiful,restaurant,vacuum,tomorrow,environment,adventure'),
  hard: L('conscience,embarrass,maintenance,pneumonia,silhouette,questionnaire,accommodate,camouflage,entrepreneur,onomatopoeia,sacrilegious,bureaucracy,mischievous,surveillance,rhinoceros,chrysanthemum')
};
// Add more words to this list to block them. Names are normalised (leetspeak, symbols) before checking.
const BAD = L('fuck,shit,bitch,asshole,dick,cunt,nigg,slut,whore,porn,nazi,rape,fag,pussy,penis,vagina,hitler');
const norm = s => s.toLowerCase().replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[^a-z]/g, '');
const isBad = n => { const x = norm(n); return BAD.some(w => x.includes(w)); };
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

const bans = new Map(), rooms = new Map();
const banLeft = (ws, tok) => Math.max(bans.get(ws.ip) || 0, bans.get('t' + tok) || 0) - Date.now();
const ban = (ws, tok) => { const t = Date.now() + BAN_MS; bans.set(ws.ip, t); bans.set('t' + tok, t); };
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function view(r, ws) {
  const v = {
    t: 'state', code: r.code, bg: r.bg, voice: r.voice, phase: r.phase, round: r.round, you: ws.id, max: MAX,
    host: { id: r.host.id, name: r.host.name, avatar: r.host.avatar },
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, done: p.ans !== null })),
    reveal: r.reveal
  };
  if (ws === r.host.ws) { // only the owner ever receives the choices
    v.words = r.phase === 'choosing' ? r.words : null;
    v.word = r.phase === 'spelling' ? r.word : null;
  }
  return v;
}
const bc = r => { send(r.host.ws, view(r, r.host.ws)); r.players.forEach(p => send(p.ws, view(r, p.ws))); };
const say = r => { const m = { t: 'say', word: r.word, voice: r.voice }; send(r.host.ws, m); r.players.forEach(p => send(p.ws, m)); };
const pick3 = r => Object.values(WORDS).map(list => {
  let c = list.filter(w => !r.used.has(w));
  if (!c.length) { list.forEach(w => r.used.delete(w)); c = list; }
  const w = c[Math.random() * c.length | 0]; r.used.add(w); return w;
});

function finish(r) {
  const w = r.word.toLowerCase();
  const list = [...r.players.values()].map(p => {
    const a = (p.ans || '').toLowerCase(), d = lev(a, w);
    const pts = !a ? 0 : d === 0 ? 5 : d <= (w.length > 6 ? 2 : 1) ? 3 : 0; // exact 5, close 3, else 0
    p.score += pts;
    return { id: p.id, name: p.name, avatar: p.avatar, ans: p.ans || '—', pts };
  }).sort((a, b) => b.pts - a.pts);
  r.reveal = { word: r.word, list }; r.phase = 'reveal'; bc(r);
}

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => { res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); });
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    let r = ws.room;
    if (!r && (m.t === 'create' || m.t === 'join')) {
      const left = banLeft(ws, m.tok);
      if (left > 0) return send(ws, { t: 'banned', ms: left });
      const name = String(m.name || '').trim().slice(0, 14), avatar = String(m.avatar || '🐻').slice(0, 8);
      if (!name) return send(ws, { t: 'err', msg: 'Pick a name first.' });
      if (isBad(name)) { ban(ws, m.tok); return send(ws, { t: 'banned', ms: BAN_MS, why: 'That name is not allowed.' }); }
      if (m.t === 'create') {
        let code; do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join(''); } while (rooms.has(code));
        r = { code, bg: ['camping', 'cave', 'forest', 'cabin'].includes(m.bg) ? m.bg : 'forest', voice: m.voice === 'male' ? 'male' : 'female',
          host: { id: ws.id, ws, name, avatar }, players: new Map(), phase: 'lobby', round: 0, words: [], word: '', used: new Set(), reveal: null };
        rooms.set(code, r); ws.room = r; ws.host = true;
      } else {
        r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'err', msg: 'No server with that code.' });
        if (r.players.size + 1 >= MAX) return send(ws, { t: 'err', msg: 'This server is full (45 people).' });
        r.players.set(ws.id, { id: ws.id, ws, name, avatar, score: 0, ans: null }); ws.room = r;
      }
      return bc(r);
    }
    if (!r) return;
    if (ws.host) {
      if (m.t === 'start' && ['lobby', 'reveal'].includes(r.phase) && r.players.size) {
        r.round++; r.phase = 'choosing'; r.words = pick3(r); r.reveal = null; r.players.forEach(p => p.ans = null); bc(r);
      } else if (m.t === 'pick' && r.phase === 'choosing' && r.words[m.i]) {
        r.word = r.words[m.i]; r.phase = 'spelling'; bc(r); say(r);
      } else if (m.t === 'repeat' && r.phase === 'spelling') say(r);
      else if (m.t === 'end' && r.phase === 'spelling') finish(r);
    } else if (m.t === 'answer' && r.phase === 'spelling') {
      const p = r.players.get(ws.id);
      if (p && p.ans === null) { // one chance only
        p.ans = String(m.text || '').trim().slice(0, 30);
        if ([...r.players.values()].every(x => x.ans !== null)) finish(r); else bc(r);
      }
    }
  });
  ws.on('close', () => {
    const r = ws.room; if (!r) return;
    if (ws.host) { r.players.forEach(p => send(p.ws, { t: 'closed' })); rooms.delete(r.code); return; }
    r.players.delete(ws.id);
    if (r.phase === 'spelling' && r.players.size && [...r.players.values()].every(x => x.ans !== null)) finish(r); else bc(r);
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Spelling Bee running on port ' + (process.env.PORT || 3000)));
