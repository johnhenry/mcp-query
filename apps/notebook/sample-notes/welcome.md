# Welcome to the Living Notebook

This is a **notes + knowledge** UI sitting on top of a *filesystem* MCP server.
Every file in `sample-notes/` is a note you can open, read, and edit.

## The killer feature: live updates

Open this file in the viewer, then edit it **on disk** (or let an agent edit it):

```bash
echo "
## Edited from the terminal!" >> sample-notes/welcome.md
```

The viewer updates **live** — the app and any agent share one live view of the
same files. That is MCP subscriptions in action.

## Markdown the app understands

- Headings (`#`, `##`, `###`)
- **bold** text
- `inline code`
- unordered lists
- fenced ```code blocks```

Toggle **Raw** in the viewer to see the source. Switch to **Edit** to write
changes back through the filesystem `write_file` tool.
