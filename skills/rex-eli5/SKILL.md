---
name: rex-eli5
description: Explain it simply. Makes one self-contained HTML picture page that explains how something works, why something broke or what a choice means, in a few numbered steps with simple drawings and one or two plain sentences each, light and dark, works offline.
---

# Explain it simply

Use this when you explain to the person how something works, why something broke, what a choice means, or anything longer than a few lines. Explain like they are five: big pictures, few words. For your own code changes use `rex-code-explainer` instead.

## Steps

1. Write a spec file (JSON) in your work folder:

```json
{
  "title": "Why the message was lost",
  "steps": [
    { "text": "You schedule a message for 9:00.", "picture": ["You", "Schedule"] },
    { "text": "The agent wakes up, but reads an old note first.", "picture": ["Old note", "Agent"], "mark": "bad" },
    { "text": "Now the newest message always goes first.", "picture": ["New message", "Agent", "Reply"], "mark": "good" }
  ]
}
```

   - 3 to 6 steps. `text`: one or two plain sentences. No jargon, no emoji, no em dashes.
   - `picture`: 1 to 4 short labels, drawn as boxes joined by arrows. Or give `svg` instead: your own drawing as inline SVG markup (shapes and text only, no links, no scripts, no images).
   - `mark` (optional): `good` (green) or `bad` (red) colours the last box.
2. Render it:

```
node "<this folder>/scripts/render.mjs" <spec.json> --out <work folder>/eli5-<short-topic>.html
```

3. Do not open the page yourself. Show it with `desk_show_page` beside a two or three line answer in the chat.

The page has no links to the internet and needs nothing installed besides Node.
