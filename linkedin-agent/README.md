# LinkedIn agent

Autonomous LinkedIn prospecting for Ikonic. Sources prospects, engages on their posts, sends
connection requests, replies to DMs, and pushes everything into GoHighLevel — writing in Ikonic's
voice, with a daily brief so Josh stays the one running the channel.

## Read this part first

LinkedIn has no public API for connection requests, likes and comments on arbitrary posts, or
personal-account DMs. This tool drives the real site through a browser. That is against LinkedIn's
User Agreement, and they detect it. **The realistic downside is a restricted or permanently banned
personal account.** Josh knows and chose this. Don't run it on an account you can't afford to lose.

What this build deliberately does **not** contain: browser-fingerprint spoofing, `playwright-stealth`
or equivalent patches, residential proxy rotation, CAPTCHA solving, or any other measure whose only
purpose is defeating detection. When the agent hits a checkpoint or a CAPTCHA it stops and tells
Josh — it never tries to get past one. Daily caps and human-realistic pacing *are* here, as load
limits.

Everything the agent does is in the audit log, including the drafts it decided not to send.

## Setup

```bash
cd linkedin-agent
npm install
npx playwright install chromium     # skip if PLAYWRIGHT_BROWSERS_PATH already has one
npm run agent -- login              # opens a browser; sign in by hand, incl. 2FA
npm run agent -- status
```

No LinkedIn credentials are stored by this tool and none are ever typed by it. The session lives in
`data/chrome-profile/`, which is gitignored.

### Credentials

| Variable | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | all drafting and scoring | or run `ant auth login` — the SDK finds the profile on its own |
| `GHL_API_KEY` | CRM sync only | Private Integration Token from the sub-account: Settings → Private Integrations. Scopes: contacts r/w, opportunities r/w, notes write |
| `GHL_LOCATION_ID` | CRM sync only | defaults to `DSt3GeDVV0wQXQt9iuGn` |
| `LINKEDIN_AGENT_CHROME_PATH` | optional | use a specific Chromium instead of Playwright's |

Everything except the Anthropic key is optional — the agent runs fine without GHL configured and
reports the sync as skipped.

## The phased rollout

Writes are off by default. Each phase is a config change, and each one should sit for a few days
before the next.

| Phase | `LINKEDIN_AGENT_WRITES` | `LINKEDIN_AGENT_WRITE_ACTIONS` | What runs |
|---|---|---|---|
| 1 — read only | `0` | *(empty)* | Reads feed, profiles, inbox. Writes nothing. |
| 2 — drafting | `0` | *(empty)* | Adds scoring, classification, drafting. Review with `review` and `log`. |
| 3 — engagement | `1` | `like,comment` | Starts liking and commenting. |
| 4 — connections | `1` | `like,comment,connect` | Adds invitations with notes. |
| 5 — inbox | `1` | `like,comment,connect,message` | Adds autonomous replies. |
| 6 — CRM | *(as above)* | *(as above)* | Set `GHL_API_KEY` to turn on sync. |

**Do not skip to phase 5.** Phase 2 is where the voice gets tuned, and tuning it against Josh's
judgement costs nothing while tuning it against a real prospect's inbox costs a prospect.

## Daily use

```bash
npm run agent -- status        # what it's doing, what's capped, what's stopping it
npm run agent -- brief         # today's brief: what needs you, who's hot, what moved
npm run agent -- review        # everything it escalated instead of handling
npm run agent -- log           # audit log, including blocked drafts
npm run agent -- dry-run       # full pipeline, drafts everything, sends nothing
npm run agent -- pause "why"   # stop
npm run agent -- resume        # start again
```

### Stopping it

```bash
touch linkedin-agent/PAUSE
```

That's the kill switch. Checked before every single write, survives restarts, and works from
anything that can create a file. `npm run agent -- pause` does the same thing with a reason attached.

## What it will not do on its own

Enforced in `src/governor/rules.ts` as code, checked against the finished text of every draft —
not as prompt instructions, which a persuasive inbound message can talk a model out of.

- **Book or agree to a meeting.** It can say Josh would be glad to talk and ask what their week
  looks like. It cannot confirm a time.
- **Touch a negative, complaint, dispute, or legal thread.** Routed to Josh unanswered.
- **Engage an existing client or open deal.** Pulled from GHL and permanently excluded.
- **Quote a price.** It may mention the published ranges ($3K–$5.2K wraps, $497/$797/$1,297
  retainers) conversationally. Any specific number, discount, or scope commitment escalates.
  *Josh did not pick this guardrail; it's here because his own brand-voice rules require his
  confirmation on pricing. Loosen it in `config.ts` if that's wrong.*
- **Message the same person twice in 7 days**, or comment on one person's posts twice in 14.
- **Send anything generic.** A draft without a concrete, specific hook is blocked, not sent.

Anything blocked lands in the review queue and the daily brief. Nothing is silently dropped.

## Volume

Caps ramp rather than opening at the target — week 1 lands near 10 actions/day, week 2 around 20,
week 3 around 35, week 4 onward at the ~50/day target. Jumping straight to 50 on a fresh automation
pattern is the most reliable way to get flagged, and the ramp reaches the same place inside a month.

Override with `LINKEDIN_AGENT_SKIP_RAMP=1` if you want the target immediately. Per-type ceilings are
in `src/config/caps.ts`.

Replies to people who wrote to *us* are exempt from caps. Leaving someone on read is worse behaviour
than answering them, and it isn't what gets accounts flagged.

## Sourcing

Three layers, in order of footprint:

1. **Clay / Vibe Prospecting** — those connectors run in Claude sessions, not in this process. Build
   a list in a session, save it as JSON to `data/import/`, and the `import` stage ingests it. Keeps
   the heaviest prospecting entirely off LinkedIn. See `src/sourcing/import.ts` for the shape.
2. **Engagement mining** — harvests people commenting on posts in Ikonic's world. Highest signal,
   most natural-looking behaviour. Feeds are in `src/config/icp.ts`; extend that list.
3. **LinkedIn search** — gap-fill only, hardest cap of the three, runs last.

## Scheduling

macOS: edit the paths in `scripts/com.ikonic.linkedin-agent.plist`, then

```bash
cp scripts/com.ikonic.linkedin-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ikonic.linkedin-agent.plist
```

Four weekday windows. The agent paces itself within each one.

## Layout

```
src/
  config/    config.ts caps.ts icp.ts       all tunables; no magic numbers in logic
  browser/   session.ts selectors.ts        Playwright, and every LinkedIn selector in one file
  actions/   profile engage connect inbox search
  governor/  index.ts rules.ts ramp.ts pacing.ts killswitch.ts breaker.ts
  brain/     client.ts voice.ts score.ts classify.ts draft.ts
  sourcing/  import.ts mine.ts
  memory/    db.ts schema.ts prospects.ts threads.ts posts.ts audit.ts
  crm/       ghl.ts sync.ts
  report/    brief.ts
  run.ts     the run loop
  cli.ts
```

Every write goes through `governor.request()`. Action modules never touch Playwright directly, so
that one function is the complete answer to "what will this thing do".

## Tests

```bash
npm test        # 69 tests
npm run typecheck
```

Covers the ramp and cap maths, pacing windows, the voice linter against every banned phrase, and the
rule engine against adversarial fixtures — a price ask, a meeting confirmation, an angry message, an
existing client. Also an end-to-end pass over the real decision path: kill switch, phase gating,
cap exhaustion, and the audit trail.

The browser layer is **not** covered by tests. It can't be without a live LinkedIn session, and the
selectors in `src/browser/selectors.ts` are best-effort against a site that changes constantly.
That's what phase 1 is for — run it read-only and see what actually resolves before enabling writes.
