# Ardeno Engine

The autonomous backend that powers Ardeno OS. Runs on Railway, talks to Discord, handles everything.

## What it does right now

- **Lead Engine** — You type `/findleads restaurant Colombo` in Discord and it:
  1. Searches Google Maps for businesses
  2. Audits each website
  3. Scores and profiles each lead with AI (Gemini/Groq)
  4. Posts approval cards to Discord with buttons
  5. You tap ✅ Approve or ❌ Reject
  6. Approved leads queue for outreach (coming next)

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
Copy `.env.example` to `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `DISCORD_TOKEN` | [Discord Dev Portal](https://discord.com/developers/applications) → Bot → Token |
| `DISCORD_CLIENT_ID` | Discord Dev Portal → General Information → Application ID |
| `DISCORD_GUILD_ID` | Right-click your Discord server → Copy Server ID |
| `DISCORD_APPROVAL_CHANNEL_ID` | Right-click your approvals channel → Copy Channel ID |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role key |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) — free |
| `GROQ_API_KEY` | [Groq Console](https://console.groq.com) — free |
| `GOOGLE_PLACES_API_KEY` | Google Cloud Console → Places API — $200/month free credit |

### 3. Set up Supabase
Run `supabase-migration.sql` in your Supabase SQL editor.

### 4. Register Discord slash commands (once)
```bash
npm run register-commands
```

### 5. Run locally
```bash
npm run dev
```

### 6. Deploy to Railway
1. Create a new project on [Railway](https://railway.app)
2. Connect this repo (or push to GitHub first)
3. Add all env vars in Railway dashboard
4. Deploy — Railway auto-detects Node.js

## Commands

| Command | Description |
|---|---|
| `/findleads <niche> <location> [limit]` | Find and score leads in a niche + location |

## Coming next

- [ ] Outreach agent — auto-draft personalised emails per lead
- [ ] Demo builder — trigger demo website creation from Discord
- [ ] Follow-up agent — chase leads that don't respond
- [ ] Competitor scanner — monitor what other agencies are doing
