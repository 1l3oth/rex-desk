---
name: rex-code-explainer
description: Explain my changes. Turns your code changes into one self-contained HTML page for the person, the changed lines with plain notes beside them and a small picture of the idea, light and dark, works offline.
---

# Explain my changes

Use this when the person asks what you changed, or asks you to explain your changes or a piece of code.

## Steps

1. Look at the change (for example `git diff` or `git show <commit>`). Pick the parts that matter: usually 2 to 6 blocks. Leave out moves, renames and formatting noise.
2. Write a spec file (JSON) in your work folder:

```json
{
  "title": "Footer fits small windows",
  "summary": "The hint under the message box now hides when the box is narrow, so the pickers never wrap.",
  "idea": ["Box gets narrow", "Hint hides", "Pickers stay on one row"],
  "files": [
    {
      "path": "public/chat.css",
      "blocks": [
        { "start": 176, "code": "-.hint{font-size:12px}\n+.hint{font-size:12px;white-space:nowrap}", "note": "The hint stays on one line and is cut off with dots instead of wrapping." }
      ]
    }
  ]
}
```

   - `idea`: 2 to 5 short labels, drawn as boxes joined by arrows.
   - `code`: the lines as in a diff. Start a line with `+` for added, `-` for removed, a space for unchanged.
   - `start` (optional): the first line number in the new file.
   - `note`: one or two plain sentences on what the block does and why. No jargon, no emoji, no em dashes.
3. Render it:

```
node "<this folder>/scripts/render.mjs" <spec.json> --out <work folder>/code-explainer-<short-name>.html
```

4. Do not open the page yourself. Show it with `desk_show_page` and write two or three plain lines beside it.

The page has no links to the internet and needs nothing installed besides Node.
