// Discord review summaries and confirm cards for Memory proposals, posted to the status channel after a Memory Review.
// The owner check happens in app.ts before a click reaches this class, as for Task proposal cards (ADR 0027).
import type { MemoryProposalRecord } from "../connectors/persistence/sqlite/legacy-database.js";
import { redactSecrets, type MemoryReviewResult } from "../memory/memory-review.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import type { ButtonClick, ChatTransport, MessageButton } from "../transport/ports.js";

export type MemoryCardStore = Required<Pick<OperationalStore, "getMemoryProposal" | "setMemoryProposalCardMessage"
  | "confirmMemoryProposal" | "rejectMemoryProposal">>;
type CardTransport = Pick<ChatTransport, "sendMessage"> & Partial<Pick<ChatTransport, "sendMessageWithButtons" | "editMessage">>;
export type MemoryCardOptions = {
  statusChannelId: string;
  /** Unix seconds; defaults to the system clock. */
  now?: () => number;
};
export type CompletedMemoryReview = Extract<MemoryReviewResult, { state: "completed" }>;

const actor = "discord:owner";
const customIdPattern = /^inoai:memory:(\d{1,15}):(confirm|reject)$/;
const maxSummaryChanges = 10;
const unavailable = "This Memory proposal is no longer available. Nothing was changed.";

function clip(text: string, limit: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** Text shown in Discord: secret-like lines are redacted first, then the text is cut to one short line. */
function shown(body: string, limit: number): string {
  return clip(redactSecrets(body), limit);
}

/** Confirm and Reject buttons for one proposal. */
export function memoryCardButtons(proposal: Pick<MemoryProposalRecord, "id">): MessageButton[] {
  return [
    { label: "Confirm", style: "success", customId: `inoai:memory:${proposal.id}:confirm` },
    { label: "Reject", style: "secondary", customId: `inoai:memory:${proposal.id}:reject` },
  ];
}

/** One summary per review that changed Memory or stored proposals; undefined for a quiet review. */
export function reviewSummaryText(result: CompletedMemoryReview): string | undefined {
  if (!result.added && !result.updated && !result.deleted && !result.proposalIds.length) return undefined;
  const verb = { add: "Added", update: "Updated", delete: "Deleted" } as const;
  const lines = [
    "**Memory Review**",
    `Added ${result.added}, updated ${result.updated}, deleted ${result.deleted}. New proposals: ${result.proposalIds.length}.`,
    ...result.changes.slice(0, maxSummaryChanges).map((change) => `- ${verb[change.op]}: ${shown(change.body, 120)}`),
  ];
  if (result.changes.length > maxSummaryChanges) lines.push(`- …and ${result.changes.length - maxSummaryChanges} more.`);
  if (result.proposalIds.length) lines.push("Confirm or reject each proposal below.");
  return lines.join("\n");
}

function pendingText(proposal: MemoryProposalRecord): string {
  const kind = proposal.kind === "core" ? "core, used in every conversation" : "topic, used when relevant";
  return [`**Memory proposal** (${kind})`, `> ${shown(proposal.body, 500)}`, `This card expires <t:${proposal.expires_at}:R>.`].join("\n");
}

function statusText(proposal: MemoryProposalRecord): string {
  const quote = `\n> ${shown(proposal.body, 500)}`;
  switch (proposal.state) {
    case "pending": return pendingText(proposal);
    case "confirmed": return (proposal.created_memory_id === null
      ? "Confirmed. An active Memory already has this text, so nothing new was saved."
      : `Confirmed. Saved as ${proposal.kind} Memory #${proposal.created_memory_id}.`) + quote;
    case "rejected": return `Rejected. This text will not be proposed again.${quote}`;
    case "expired": return `Expired. Nothing was changed.${quote}`;
  }
}

export class MemoryProposalCards {
  private stopped = false;
  /** Review posts run one after another, so each summary is followed by its own cards. */
  private posting: Promise<void> = Promise.resolve();

  constructor(private readonly store: MemoryCardStore, private readonly transport: CardTransport, private readonly options: MemoryCardOptions) {}

  private now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.posting;
  }

  /**
   * Posts the review summary and one card per new proposal to the status channel. A quiet review posts nothing. Posts
   * follow ADR 0005 and are never retried: a proposal whose card could not be posted stays pending until it expires.
   */
  publishReview(result: CompletedMemoryReview): Promise<void> {
    const summary = reviewSummaryText(result);
    if (this.stopped || summary === undefined) return Promise.resolve();
    this.posting = this.posting.then(async () => {
      if (this.stopped) return;
      await this.transport.sendMessage(this.options.statusChannelId, summary).catch(() => undefined);
      for (const id of result.proposalIds) {
        if (this.stopped) return;
        await this.deliver(id).catch(() => undefined);
      }
    }).catch(() => undefined);
    return this.posting;
  }

  private async deliver(id: number): Promise<void> {
    if (!this.transport.sendMessageWithButtons) return;
    const proposal = await this.store.getMemoryProposal(id);
    if (proposal?.state !== "pending") return;
    const messageId = await this.transport.sendMessageWithButtons(this.options.statusChannelId, pendingText(proposal), memoryCardButtons(proposal));
    if (!await this.store.setMemoryProposalCardMessage(id, messageId, this.now(), "transport:discord")) {
      // Answered or expired while the card was sent: the card id is not stored, so show the outcome without buttons.
      const latest = await this.store.getMemoryProposal(id);
      await this.transport.editMessage?.(this.options.statusChannelId, messageId, latest ? statusText(latest) : unavailable, []).catch(() => undefined);
    }
  }

  /** Handles a Confirm or Reject click from the owner. Every click edits the card to show the stored outcome. */
  async handleClick(click: ButtonClick): Promise<void> {
    const match = customIdPattern.exec(click.customId);
    if (!match) { await click.replyEphemeral("This button is no longer available."); return; }
    const id = Number(match[1]);
    const proposal = await this.store.getMemoryProposal(id);
    if (!proposal || proposal.card_message_id !== click.messageId || click.conversationId !== this.options.statusChannelId) {
      await click.updateMessage(unavailable, []);
      return;
    }
    const answer = match[2] === "confirm"
      ? await this.store.confirmMemoryProposal(id, this.now(), actor)
      : await this.store.rejectMemoryProposal(id, this.now(), actor);
    const current = answer.proposal ?? proposal;
    await click.updateMessage(statusText(current), current.state === "pending" ? memoryCardButtons(current) : []);
  }
}
