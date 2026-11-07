// Procedure videos ("✨ Create video with AI" on a procedure). The app writes the voiceover with the AI
// (videoRequest: intro, one line per step, outro, voice) on procedures/<id>; this job then:
//   1. records each line with Google Text-to-Speech (a natural Chirp 3 HD voice, female or male, English or French),
//   2. builds a 720×900 video with ffmpeg: a title card, then each step's photo with a slow zoom, its number,
//      text, note and ✦ tag, and the spoken line as a subtitle; an end card,
//   3. saves it to Storage (procedures/<id>/ai-video-….mp4) and to the procedure (aiVideo),
// reporting each stage in videoJob so the app can show the progress. Nothing is ever deleted.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');

const W = 720, H = 900, FPS = 30;
const FONTS = {
  bold: () => require.resolve('@expo-google-fonts/inter/800ExtraBold/Inter_800ExtraBold.ttf'),
  semi: () => require.resolve('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
  med: () => require.resolve('@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
};
const VOICES = {   // [preferred natural voice, fallback]
  'en-f': ['en-US-Chirp3-HD-Aoede', 'en-US-Neural2-F'], 'en-m': ['en-US-Chirp3-HD-Charon', 'en-US-Neural2-D'],
  'fr-f': ['fr-CA-Chirp3-HD-Aoede', 'fr-CA-Neural2-A'], 'fr-m': ['fr-CA-Chirp3-HD-Charon', 'fr-CA-Neural2-B'],
};

// a step's photos and videos, in order (older steps only have .photo)
function stepMedia(s) {
  if (s && Array.isArray(s.media) && s.media.length) return s.media.filter(m => m && m.url);
  return s && s.photo ? [{ k: 'img', url: s.photo, path: s.photoPath || '' }] : [];
}
// same fingerprint the app uses to tell when a video no longer matches the steps
function procStepsSig(steps) {
  const str = (steps || []).map(s => (s.t || '') + '|' + (s.n || '') + '|' + stepMedia(s).map(m => m.url).join(',') + '|' + (s.g ? 1 : 0)).join('\n');
  let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// break text into lines of at most `max` characters (drawtext doesn't wrap)
function wrap(text, max, maxLines = 4) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= max) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}
function run(ffmpeg, args, cwd) {
  return new Promise((res, rej) => execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, maxBuffer: 1 << 24 },
    (err, out, errOut) => err ? rej(new Error('ffmpeg: ' + (errOut || err.message).slice(-600))) : res()));
}
const wavSecs = buf => Math.max(0, (buf.length - 44) / (24000 * 2));
// a drawtext filter that reads its text from a file (no escaping problems), placed in the work folder
function dt(dir, name, lines, o) {
  fs.writeFileSync(path.join(dir, name), lines.join('\n'));
  return `drawtext=fontfile=${o.font}:textfile=${name}:expansion=none:fontsize=${o.size}:fontcolor=${o.color || 'white'}:line_spacing=${o.ls || 8}:x=${o.x}:y=${o.y}` +
    (o.box ? `:box=1:boxcolor=black@0.62:boxborderw=12` : '') + (o.shadow ? ':shadowcolor=black@0.6:shadowx=0:shadowy=2' : '');
}

// Builds the video in `dir` from: title, intro {audio}, steps [{img, text, note, g, line, audio}], outro {line, audio}.
// Every file name is relative to `dir`. Returns {file, secs}.
async function buildVideo(dir, ffmpeg, v) {
  for (const [k, f] of Object.entries(FONTS)) fs.copyFileSync(f(), path.join(dir, k + '.ttf'));
  // a dark fade under the captions, made once
  await run(ffmpeg, ['-f', 'lavfi', '-i', `color=black:s=${W}x460,format=rgba,geq=r=0:g=0:b=0:a='min(255\\,255*(Y/360))*0.9'`, '-frames:v', '1', 'fade.png'], dir);
  const segs = [];
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '96k', '-ar', '24000', '-ac', '1'];
  const audioIn = (a, d) => a ? ['-i', a] : ['-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=24000:cl=mono'];
  const cardBg = d => ['-f', 'lavfi', '-i', `color=c=0x0B1120:s=${W}x${H}:d=${d}:r=${FPS}`];
  const sub = (name, text) => text ? ',' + dt(dir, name, wrap(text, 40, 4), { font: 'med.ttf', size: 26, x: '(w-text_w)/2', y: 46, box: true, ls: 10 }) : '';

  // title card
  { const d = Math.max(3, (v.intro.secs || 0) + 0.9), t = wrap(v.title, 20, 3);
    const vf = [dt(dir, 't_k.txt', ['PROCEDURE'], { font: 'semi.ttf', size: 20, color: '0x7FA8F0', x: '(w-text_w)/2', y: 340 }),
      dt(dir, 't_t.txt', t, { font: 'bold.ttf', size: 54, x: '(w-text_w)/2', y: 384, ls: 12 }),
      dt(dir, 't_b.txt', ['SKYCARE  ·  GROOMIES'], { font: 'semi.ttf', size: 18, color: '0x8A96AB', x: '(w-text_w)/2', y: H - 90 })].join(',') + sub('t_s.txt', v.intro.line);
    await run(ffmpeg, [...cardBg(d), ...audioIn(v.intro.audio, d), '-vf', vf, '-af', 'apad', '-t', String(d), ...enc, 'seg0.mp4'], dir);
    segs.push(['seg0.mp4', d]); }

  // one segment per step: photo with a slow zoom, the dark fade, number, text, note, and the spoken line on top
  for (let i = 0; i < v.steps.length; i++) {
    const s = v.steps[i], items = s.items, n = items.length;
    const d = Math.max(3, (s.secs || 0) + 0.8, n * 2.4), each = d / n;
    const txt = wrap(s.text, 30, 3), note = s.note ? wrap(s.note, 44, 2) : [];
    const textH = txt.length * 44 + (note.length ? 10 + note.length * 32 : 0) + (s.g ? 36 : 0);
    const yNum = H - 60 - textH - 96, yTxt = yNum + 100;
    const ins = [], parts = [];
    items.forEach((m, j) => {
      const f = Math.round(each * FPS);
      if (m.k === 'vid') { ins.push('-stream_loop', '-1', '-t', String(each + 0.5), '-i', m.file);
        parts.push(`[${j}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},trim=duration=${each.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[m${j}]`); }
      else { ins.push('-i', m.file);
        parts.push(`[${j}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.09*on/${f}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${f}:s=${W}x${H}:fps=${FPS},setsar=1[m${j}]`); }
    });
    let vf = parts.join(';') + ';' + items.map((_, j) => `[m${j}]`).join('') + `concat=n=${n}:v=1:a=0[ph];` +
      `[ph][${n}:v]overlay=0:${H - 460}[bg];[bg]` +
      dt(dir, `s${i}_n.txt`, [String(i + 1)], { font: 'bold.ttf', size: 92, color: s.g ? '0xE8C86A' : '0x4A9EFF', x: 40, y: yNum, shadow: true }) + ',' +
      dt(dir, `s${i}_t.txt`, txt, { font: 'bold.ttf', size: 36, x: 40, y: yTxt, ls: 8, shadow: true });
    if (note.length) vf += ',' + dt(dir, `s${i}_o.txt`, note, { font: 'med.ttf', size: 25, color: '0xC7D2E3', x: 40, y: yTxt + txt.length * 44 + 10, ls: 7 });
    if (s.g) vf += ',' + dt(dir, `s${i}_g.txt`, ['2ND GROOMER'], { font: 'semi.ttf', size: 20, color: '0xE8C86A', x: 40, y: H - 60 - 26 });
    vf += sub(`s${i}_s.txt`, s.line) + '[v]';
    await run(ffmpeg, [...ins, '-i', 'fade.png', ...audioIn(s.audio, d), '-filter_complex', vf, '-map', '[v]', '-map', `${n + 1}:a`, '-af', 'apad', '-t', String(d), ...enc, `seg${i + 1}.mp4`], dir);
    segs.push([`seg${i + 1}.mp4`, d]);
  }

  // end card
  { const d = Math.max(2.6, (v.outro.secs || 0) + 1.0), n = v.steps.length + 1;
    const vf = [dt(dir, 'e_t.txt', ['GROOMIES'], { font: 'bold.ttf', size: 46, x: '(w-text_w)/2', y: 390 }),
      dt(dir, 'e_b.txt', [v.title.toUpperCase().slice(0, 40)], { font: 'semi.ttf', size: 20, color: '0x7FA8F0', x: '(w-text_w)/2', y: 456 }),
      dt(dir, 'e_s.txt', ['SKYCARE'], { font: 'semi.ttf', size: 18, color: '0x8A96AB', x: '(w-text_w)/2', y: H - 90 })].join(',') + sub('e_x.txt', v.outro.line);
    await run(ffmpeg, [...cardBg(d), ...audioIn(v.outro.audio, d), '-vf', vf, '-af', 'apad', '-t', String(d), ...enc, `seg${n}.mp4`], dir);
    segs.push([`seg${n}.mp4`, d]); }

  fs.writeFileSync(path.join(dir, 'list.txt'), segs.map(([f]) => `file '${f}'`).join('\n'));
  await run(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', 'video.mp4'], dir);
  return { file: path.join(dir, 'video.mp4'), secs: segs.reduce((a, [, d]) => a + d, 0) };
}

// ── the Cloud Function ────────────────────────────────────────────────────────
function makeProcVideoFunction() {
  const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  return onDocumentUpdated({ document: 'procedures/{id}', region: 'us-central1', memory: '2GiB', cpu: 2, timeoutSeconds: 540, maxInstances: 2 }, async event => {
    const before = event.data.before.data() || {}, after = event.data.after.data() || {};
    const req = after.videoRequest;
    if (!req || !req.at || (before.videoRequest && before.videoRequest.at === req.at)) return;   // only a new request
    const db = admin.firestore(), ref = event.data.after.ref, id = event.params.id;
    // claim it once (the same change can be delivered twice)
    const claimed = await db.runTransaction(async tx => {
      const d = (await tx.get(ref)).data() || {};
      if (!d.videoRequest || d.videoRequest.at !== req.at || (d.videoJob || {}).claimedAt === req.at) return false;
      tx.update(ref, { 'videoJob.status': 'voice', 'videoJob.msg': '', 'videoJob.claimedAt': req.at });
      return true;
    });
    if (!claimed) return;
    const stage = (status, msg = '') => ref.update({ 'videoJob.status': status, 'videoJob.msg': msg });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
    try {
      const fresh = (await ref.get()).data() || {};
      const steps = (fresh.steps || []).filter(s => s && stepMedia(s).length);
      if (!steps.length || steps.length !== (fresh.steps || []).length) throw Object.assign(new Error('missing photos'), { friendly: 'Every step needs a photo or video before a video can be made.' });
      const bucket = admin.storage().bucket();
      // 1. voice
      const tts = new (require('@google-cloud/text-to-speech').TextToSpeechClient)();
      const voice = req.voice || {}, [best, fallback] = VOICES[`${voice.l === 'fr' ? 'fr' : 'en'}-${voice.g === 'm' ? 'm' : 'f'}`];
      const lang = best.slice(0, 5);
      let name = best;
      const say = async (text, file) => {
        if (!text) return { audio: null, secs: 0 };
        let r;
        try { [r] = await tts.synthesizeSpeech({ input: { text }, voice: { languageCode: lang, name }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 } }); }
        catch (e) {
          if (name !== best || /PERMISSION_DENIED|SERVICE_DISABLED|has not been used/.test(String(e.message))) throw e;
          name = fallback;   // the natural voice isn't offered for this language: use the standard one
          [r] = await tts.synthesizeSpeech({ input: { text }, voice: { languageCode: lang, name }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 } });
        }
        fs.writeFileSync(path.join(dir, file), r.audioContent);
        return { audio: file, secs: wavSecs(r.audioContent) };
      };
      const lines = req.lines || [];
      const intro = { line: req.intro || '', ...(await say(req.intro, 'intro.wav')) };
      const v = { title: fresh.title || 'Procedure', intro, steps: [], outro: { line: req.outro || '', ...(await say(req.outro, 'outro.wav')) } };
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i], line = String(lines[i] || s.t || '').trim();
        const a = await say(line, `l${i}.wav`);
        // the step's photos and videos
        const items = [];
        for (const [j, m] of stepMedia(s).slice(0, 6).entries()) {
          const file = `p${i}_${j}.${m.k === 'vid' ? 'mp4' : 'jpg'}`;
          if (m.path) await bucket.file(m.path).download({ destination: path.join(dir, file) });
          else { const r = await fetch(m.url); if (!r.ok) throw new Error('media ' + r.status); fs.writeFileSync(path.join(dir, file), Buffer.from(await r.arrayBuffer())); }
          items.push({ k: m.k === 'vid' ? 'vid' : 'img', file });
        }
        v.steps.push({ items, text: s.t, note: s.n || '', g: !!s.g, line, ...a });
      }
      // 2. video
      await stage('building');
      const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
      const out = await buildVideo(dir, ffmpeg, v);
      // 3. save
      await stage('saving');
      const file = `procedures/${id}/ai-video-${Date.now()}.mp4`, token = crypto.randomUUID();
      await bucket.upload(out.file, { destination: file, metadata: { contentType: 'video/mp4', metadata: { firebaseStorageDownloadTokens: token } } });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(file)}?alt=media&token=${token}`;
      await ref.update({ aiVideo: { url, path: file, secs: Math.round(out.secs), at: Date.now(), sig: procStepsSig(fresh.steps), voice: name },
        'videoJob.status': 'done', 'videoJob.msg': '', 'videoJob.at': Date.now() });
      console.log(`Procedure video for ${id}: ${steps.length} steps, ${Math.round(out.secs)} s, voice ${name}`);
    } catch (e) {
      console.error('Procedure video failed for', id, e);
      const m = String(e.message || '');
      const friendly = e.friendly || (/SERVICE_DISABLED|has not been used|Text-to-Speech API/.test(m) ? "The voice service isn't switched on for this app yet." : 'Something went wrong while making the video. Try again.');
      await stage('error', friendly).catch(() => {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
module.exports = { buildVideo, wrap, procStepsSig, stepMedia, makeProcVideoFunction };
