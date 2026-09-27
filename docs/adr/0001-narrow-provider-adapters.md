# Keep chat transports and agent runtimes behind narrow adapters

inoai starts with Discord and Codex, but it must be able to support Slack/Telegram and Claude/OpenCode without rewriting its persistence, queueing, memory, task, or dashboard logic. The application therefore owns provider-neutral Conversation and Agent Session records, while the configured chat transport and agent runtime sit behind small adapter interfaces; a simple `switch` selects the one implemented v1 adapter for each.
