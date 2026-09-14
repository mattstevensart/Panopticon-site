#!/usr/bin/env node
/**
 * Panopticon — post-convention avatar sender
 * ==========================================
 *
 * Reads the avatars people made at the table out of Firestore, pairs each
 * one with the address that registered it, and emails it to them from
 * hello@panopticoncomic.com via Zoho.
 *
 * It is deliberately cautious:
 *   - does NOTHING without --send (default is a dry run)
 *   - keeps a log so re-running never emails the same person twice
 *   - paces itself, because Zoho throttles on a rolling hourly window
 *   - skips avatars with no email, and anything older than --since
 *
 * Usage
 *   node send-avatars.mjs                          # dry run, shows the plan
 *   node send-avatars.mjs --to you@example.com     # one real test send
 *   node send-avatars.mjs --send                   # the real thing
 *
 * Options
 *   --since YYYY-MM-DD   only avatars from this date on   (default 2026-09-26)
 *   --delay SECONDS      gap between sends                (default 90)
 *   --limit N            stop after N recipients
 *   --to ADDRESS         ignore Firestore, send one test to this address
 *   --send               actually send. Without it, nothing leaves the machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import nodemailer from 'nodemailer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENT_LOG = path.join(HERE, 'sent-log.json');

// ── Config ────────────────────────────────────────────────────────────
const FIREBASE = {
  apiKey: 'AIzaSyBXi-F-yL1eqi1wPwVkzsB4BP6OyFu5Xdk',
  authDomain: 'panopticon-website.firebaseapp.com',
  projectId: 'panopticon-website',
  storageBucket: 'panopticon-website.firebasestorage.app',
  messagingSenderId: '205882520599',
  appId: '1:205882520599:web:2ade045c34557a359b1852',
};

const env = loadEnv(path.join(HERE, '.env'));
const args = parseArgs(process.argv.slice(2));

const SINCE = args.since || '2026-09-26';
const DELAY_MS = Number(args.delay || 90) * 1000;
const LIVE = Boolean(args.send || args.to);

// ── Main ──────────────────────────────────────────────────────────────
main().catch((err) => {
  const m = err.message || String(err);
  console.error('\n✗ Failed:', m);
  // Translate the two errors you're most likely to hit.
  if (m.includes('auth/invalid-credential') || m.includes('auth/wrong-password')) {
    console.error('\n  That is the FIREBASE password in .env — the one you use at');
    console.error('  /earlybird-admin, not your Zoho mailbox password.');
  } else if (m.includes('insufficient permissions')) {
    console.error('\n  Signed in, but Firestore refused the read. Check FIREBASE_EMAIL');
    console.error('  matches your admin account exactly.');
  }
  console.error('');
  process.exit(1);
});

async function main() {
  banner();

  // A dry run never touches Zoho, so you can inspect the plan before you
  // have mail credentials sorted out.
  let mailer = null;
  if (LIVE) {
    mailer = makeMailer();
    try {
      await mailer.verify();
    } catch (err) {
      console.error(`\n✗ Could not reach Zoho: ${err.message}`);
      console.error('  If that was a timeout, your network is blocking port 465.');
      console.error('  If it was an auth failure and you have 2FA on Zoho, you need');
      console.error('  an app password rather than your normal one.\n');
      process.exit(1);
    }
    console.log('✓ Zoho connection OK\n');
  }

  let recipients;
  if (args.to) {
    console.log(`Test mode — one message to ${args.to}, no Firestore read.\n`);
    recipients = [{ email: args.to, avatars: [testAvatar()] }];
  } else {
    recipients = await loadFromFirestore();
  }

  const sent = readSentLog();
  const pending = recipients.filter((r) => args.to || !sent[r.email]);
  const skipped = recipients.length - pending.length;

  const queue = args.limit ? pending.slice(0, Number(args.limit)) : pending;

  console.log(`${recipients.length} recipient(s) found`);
  if (skipped) console.log(`${skipped} already emailed on a previous run — skipping`);
  console.log(`${queue.length} to send now\n`);

  if (!queue.length) { console.log('Nothing to do.'); return; }

  for (const [i, r] of queue.entries()) {
    const n = `${String(i + 1).padStart(3)}/${queue.length}`;
    const names = r.avatars.map((a) => a.name || '?').join(', ');

    if (!LIVE) {
      console.log(`${n}  [dry run] ${r.email}  —  ${r.avatars.length} avatar(s): ${names}`);
      continue;
    }

    try {
      await mailer.sendMail(buildMessage(r));
      console.log(`${n}  ✓ sent to ${r.email}  (${names})`);
      if (!args.to) { sent[r.email] = new Date().toISOString(); writeSentLog(sent); }
    } catch (err) {
      // Log and keep going — one bad address shouldn't halt the run.
      console.log(`${n}  ✗ FAILED ${r.email}: ${err.message}`);
    }

    if (i < queue.length - 1) {
      process.stdout.write(`      waiting ${DELAY_MS / 1000}s (Zoho rate limit)...\r`);
      await sleep(DELAY_MS);
      process.stdout.write(' '.repeat(60) + '\r');
    }
  }

  console.log(LIVE ? '\nDone.' : '\nDry run complete — nothing was sent. Add --send to do it for real.');
}

// ── Firestore ─────────────────────────────────────────────────────────
async function loadFromFirestore() {
  const app = initializeApp(FIREBASE);
  const auth = getAuth(app);

  need('FIREBASE_EMAIL'); need('FIREBASE_PASSWORD');
  await signInWithEmailAndPassword(auth, env.FIREBASE_EMAIL, env.FIREBASE_PASSWORD);
  console.log(`✓ Signed in to Firebase as ${env.FIREBASE_EMAIL}`);

  const db = getFirestore(app);
  const snap = await getDocs(collection(db, 'avatar_uploads'));

  const cutoff = new Date(SINCE + 'T00:00:00').getTime();
  const byEmail = new Map();
  let noEmail = 0, tooOld = 0;

  snap.forEach((doc) => {
    const d = doc.data();
    const email = (d.email || '').trim().toLowerCase();
    if (!email) { noEmail++; return; }
    if (new Date(d.uploadedAt || 0).getTime() < cutoff) { tooOld++; return; }
    if (!byEmail.has(email)) byEmail.set(email, { email, avatars: [] });
    byEmail.get(email).avatars.push({
      name: d.name || '',
      inmateId: d.inmateId || '',
      filename: d.filename || 'inmate-id.png',
      imageData: d.imageData || '',
    });
  });

  console.log(`✓ Read ${snap.size} avatar record(s)`);
  if (tooOld) console.log(`  ${tooOld} before ${SINCE} — skipped`);
  if (noEmail) console.log(`  ${noEmail} with no email attached — skipped`);
  console.log();

  return [...byEmail.values()];
}

// ── Mail ──────────────────────────────────────────────────────────────
function makeMailer() {
  need('ZOHO_USER'); need('ZOHO_PASSWORD');
  return nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: env.ZOHO_USER, pass: env.ZOHO_PASSWORD },
    // Fail loudly instead of hanging forever if the network blocks 465.
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 40000,
  });
}

function buildMessage(r) {
  const multiple = r.avatars.length > 1;
  const first = r.avatars[0];

  return {
    from: `Panopticon <${env.ZOHO_USER}>`,
    to: r.email,
    subject: multiple ? 'Your Panopticon inmate IDs' : 'Your Panopticon inmate ID',
    text: [
      'INTAKE COMPLETE',
      '',
      multiple
        ? `Your inmate IDs are attached — ${r.avatars.length} of them.`
        : `${(first.name || 'INMATE').toUpperCase()}${first.inmateId ? ` — ID ${first.inmateId}` : ''}`,
      '',
      'Thanks for stopping by the table. Your ID is attached.',
      "We'll write when the next volume of Panopticon is out — that's it,",
      'no deluge.',
      '',
      'panopticoncomic.com',
    ].join('\n'),
    html: emailHtml(r),
    attachments: r.avatars.map((a, i) => ({
      filename: a.filename || `inmate-id-${i + 1}.png`,
      content: Buffer.from(stripDataUrl(a.imageData), 'base64'),
      contentType: 'image/png',
    })),
  };
}

function emailHtml(r) {
  const first = r.avatars[0];
  const who = esc((first.name || 'INMATE').toUpperCase());
  const id = esc((first.inmateId || '').toUpperCase());
  const line = r.avatars.length > 1
    ? `Your <strong style="color:#1ae0c2;">${r.avatars.length} inmate IDs</strong> are attached.`
    : `<strong style="color:#1ae0c2;">${who}</strong>${id ? ` &mdash; ID ${id}` : ''}`;

  // Plain markup on purpose: no external CSS, no web fonts, nothing that
  // makes a mail client suspicious or renders badly on a phone.
  return `<div style="background:#0a0a0f;padding:32px 20px;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#171721;border:2px solid #8c40ff;padding:28px;">
    <div style="color:#8c40ff;font-size:13px;letter-spacing:3px;margin-bottom:14px;">INTAKE COMPLETE</div>
    <div style="color:#d6d6e0;font-size:15px;line-height:1.7;">
      ${line}<br><br>
      Thanks for stopping by the table. Your ID is attached to this email.<br><br>
      We'll write when the next volume of <em>Panopticon</em> is out. That's it &mdash; no deluge.
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #5c576f;">
      <a href="https://panopticoncomic.com" style="color:#1ae0c2;font-size:13px;letter-spacing:2px;text-decoration:none;">PANOPTICONCOMIC.COM &rarr;</a>
    </div>
  </div>
</div>`;
}

// ── Small helpers ─────────────────────────────────────────────────────
function banner() {
  console.log('\nPANOPTICON — avatar sender');
  console.log('─'.repeat(46));
  console.log(`mode      ${LIVE ? 'LIVE — messages will be sent' : 'DRY RUN — nothing will be sent'}`);
  if (!args.to) console.log(`since     ${SINCE}`);
  console.log(`delay     ${DELAY_MS / 1000}s between sends`);
  console.log('─'.repeat(46) + '\n');
}

function stripDataUrl(s) {
  const i = (s || '').indexOf('base64,');
  return i < 0 ? '' : s.slice(i + 7);
}

function testAvatar() {
  return {
    name: 'TEST INMATE', inmateId: 'T00', filename: 'TEST_INMATE_T00.png',
    imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  };
}

function readSentLog() {
  try { return JSON.parse(fs.readFileSync(SENT_LOG, 'utf8')); } catch { return {}; }
}
function writeSentLog(obj) {
  fs.writeFileSync(SENT_LOG, JSON.stringify(obj, null, 2));
}

function loadEnv(file) {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { console.error(`\n✗ No .env file at ${file}\n  Copy .env.example to .env and fill it in.\n`); process.exit(1); }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function need(k) {
  if (!env[k]) { console.error(`\n✗ ${k} is missing from .env\n`); process.exit(1); }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
