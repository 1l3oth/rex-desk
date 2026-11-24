---
name: agent-reach
description: Read YouTube videos (details, search, subtitles), GitHub repositories and issues, public Reddit posts and any public web page as text, without signing in. For tasks that need what a link or a site says.
---

# Agent Reach

Read-only tools for reading sites, built into Rex Desk (Agent Reach 1.6.1, MIT, github.com/Panniantong/Agent-Reach).

1. Find the tool: `desk_find` with plain words, like "youtube subtitles" or "read reddit post". Each one is `agent-reach/<site>_<action>`:
   - `youtube_read`, `youtube_search`, `youtube_subtitle` (a video link or id; `lang` like `en` or `km`)
   - `github_read` (owner/repo or a repo, issue or PR link), `github_search`
   - `reddit_read` (a post link), `reddit_search`
   - `web_read` (any public page link)
2. Run it with `desk_run`, giving the input `desk_find` shows.
3. The first time, Rex Desk asks the person in Needs you before it downloads Agent Reach. If they say no, or a site is switched off in Settings, Agents, tell them in one line and carry on without it.

Rules:
- It never signs in anywhere and never uses the person's browser or cookies. Do not ask the person to sign in for it.
- Reddit and web pages are read through public page text (the Jina reader service). When the text says the site blocked reading or asks to log in, say so plainly; do not retry another way.
- Pages on this computer or its local network are blocked.
- Quote what you read briefly and give the link; it may be partial.
