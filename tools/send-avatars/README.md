# Sending everyone their avatar, after the con

One command, run once, the evening of the 26th or any day after. It reads
the avatars people made at your table, matches each to the address they
registered, and emails it from `hello@panopticoncomic.com`.

## Setup — about ten minutes, once

**1. Install the two libraries.** From this folder:

```
npm install
```

**2. Make your credentials file.**

```
cp .env.example .env
open -e .env
```

Fill in two passwords:

- `FIREBASE_PASSWORD` — the one you created for `/earlybird-admin`. The
  script signs in as you, which is how the locked-down security rules let
  it read the avatars at all.
- `ZOHO_PASSWORD` — your Zoho mailbox password. **If you have two-factor
  turned on for Zoho, this has to be an app password**, not your normal
  one: Zoho Account → Security → App Passwords → Generate. A normal
  password fails with an authentication error if 2FA is on.

`.env` is gitignored. Don't paste either password anywhere else.

**3. Send yourself a test.**

```
node send-avatars.mjs --to your@email.com
```

That skips Firestore entirely and sends one message with a placeholder
image, so you can see the formatting and confirm Zoho is working before
any of it touches real people. Check your spam folder too.

## The actual run

Dry run first — this is the default, it cannot send anything:

```
node send-avatars.mjs
```

You'll get a list: how many avatars it found, how many had no email, how
many predate the convention, and exactly who would receive what. Read it.
If the count looks wrong, stop and tell me rather than sending.

When it looks right:

```
node send-avatars.mjs --send
```

Leave the terminal open. It paces itself at 90 seconds between messages —
sixty people takes about an hour and a half. That pacing is deliberate:
Zoho throttles on a rolling hourly window, somewhere between 50 and 500
messages depending on your sending reputation, and as a low-volume sender
you're near the bottom. Firing sixty at once risks getting cut off partway
with no clear signal which ones made it.

## Things it does so you don't have to think about them

**It won't email anyone twice.** Every successful send is recorded in
`sent-log.json`. Re-run the command as many times as you like — people
already emailed are skipped. If the run dies halfway through, just run it
again; it picks up where it stopped.

**It won't email your back catalogue.** Only avatars uploaded on or after
`--since` (default `2026-09-26`) are included. Older records from the
Kickstarter era are left alone. If the con runs more than one day, or you
want a different window:

```
node send-avatars.mjs --since 2026-09-25 --send
```

**One person, one email.** If someone makes three characters, they get one
message with three attachments rather than three separate emails.

**A bad address doesn't stop the run.** Failures are printed and skipped;
everyone else still gets theirs. Anything that failed stays out of the
sent log, so a later re-run retries it.

## Other options

```
--limit 5          stop after 5 recipients (good for a cautious first batch)
--delay 120        seconds between sends, if you want to be gentler
--to ADDRESS       single test send, ignores Firestore entirely
```

## If something goes wrong

- **`auth/invalid-credential`** — the Firebase password in `.env` is wrong.
  It's the `/earlybird-admin` one, not your Zoho one.
- **`Invalid login` / `535`** — Zoho rejected the mailbox password. If 2FA
  is on, you need an app password.
- **`Missing or insufficient permissions`** — the Firebase sign-in didn't
  take, so Firestore refused the read. Check `FIREBASE_EMAIL` matches the
  account exactly.
- **Everything lands in spam** — your domain's SPF and DKIM are already
  set up correctly for Zoho, so this is unlikely. If it happens anyway,
  send a handful over a few days rather than all at once.
