# Local Paperclip instance

This directory is your `PAPERCLIP_HOME` — agent instructions, companies, and runtime state for your Paperclip install.

```bash
export PAPERCLIP_HOME="/Users/briantimmons/Developer/paperclip/paperclip-data"
pnpm paperclipai run
```

Git tracks config and agent instruction files only. Database files, logs, and backups stay local (see `.gitignore`).
