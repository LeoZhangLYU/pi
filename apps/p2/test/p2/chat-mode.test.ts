// Chat mode: the mention token, the digest it builds, and ChatModeDoc's migration.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntryRecord, InboxState } from "@earendil-works/pi-durable";
import { mentionsAgent, mentionToken } from "../../plugins/chat-mode/contract.ts";
import {
	type ChatEntry,
	composeMention,
	digest,
	MAX_DIGEST_IMAGES,
	unmentioned,
} from "../../plugins/chat-mode/digest.ts";
import { ChatModeDoc } from "../../plugins/chat-mode/worker.ts";

describe("chat-mode mentions", () => {
	it("recognizes @pi as a word of its own, in any case", () => {
		for (const text of ["@pi", "hey @Pi, look", "(@PI)", "ok @pi."]) assert(mentionsAgent(text), text);
		for (const text of ["@pizza", "me@pi", "pi", "@@pi", "@pi_bot"]) assert(!mentionsAgent(text), text);
	});

	it("recognizes a renamed agent's mention instead of @pi", () => {
		for (const text of ["@claude", "hey @Claude, look", "(@CLAUDE)"]) assert(mentionsAgent(text, "Claude"), text);
		for (const text of ["@claudette", "me@claude", "Claude", "@pi", "@claude-bot"])
			assert(!mentionsAgent(text, "Claude"), text);
		assert.equal(mentionToken("Claude"), "@claude");
		// A conversation from before names: the default.
		assert.deepEqual(ChatModeDoc.definition.migrate?.({ enabled: true }, 1), { enabled: true, name: "Pi" });
	});
});

describe("chat-mode digest", () => {
	it("names who a message answers and quotes the start of it", () => {
		const ann = { kind: "guest", id: "ann", name: "Ann" } as const;
		const bob = { kind: "guest", id: "bob", name: "Bob" } as const;
		const chat: ChatEntry[] = [
			{
				id: 7,
				message: { author: ann, text: "should we split the tokenizer and the parser work?", attachments: [] },
			},
			{
				id: 9,
				message: {
					author: bob,
					text: "yes, the tokenizer part",
					attachments: [],
					replyTo: { entryId: 7, author: ann, excerpt: "should we split…" },
				},
			},
		];
		const text = digest(chat, { kind: "owner", id: "owner", name: "Owner" }, "@pi agreed?");
		assert.match(text, /^Bob \(guest, replying to Ann: "should we split…"\): yes, the tokenizer part$/m);
		assert.match(text, /\nOwner mentioned you:\n@pi agreed\?$/);
	});

	it("composes a mention in one place: its entry's data for people, the digest for the model", () => {
		const owner = { kind: "owner", id: "owner", name: "Owner" } as const;
		const ann = { kind: "guest", id: "ann", name: "Ann" } as const;
		const file = { id: "u1", name: "plan.md", path: "/uploads/u1-plan.md", size: 3 };
		const chat: ChatEntry[] = [{ id: 4, message: { author: ann, text: "lunch?", attachments: [] } }];
		const submission = composeMention({
			author: owner,
			text: "@pi go",
			chat,
			attachments: [file],
			files: [file],
			requestId: "r",
			whenBusy: "followUp",
		});
		assert.deepEqual(submission.entry, {
			kind: "chat.mention",
			data: { author: owner, text: "@pi go", attachments: [{ id: "u1", name: "plan.md" }], included: [4] },
		});
		assert.match(
			submission.text,
			/^<chat>\n[^\n]*\nAnn \(guest\): lunch\?\n<\/chat>\n\nOwner mentioned you:\n@pi go$/,
		);
		assert.equal(submission.author, owner, "the chat plugin writes the author's speaker block for the model");
		assert.equal(submission.maxImages, MAX_DIGEST_IMAGES);
	});

	it("passes on each chat message once: a mention covers what its digest included, nothing placed after", () => {
		const ann = { kind: "guest", id: "ann", name: "Ann" } as const;
		const chatEntry = (id: number, text: string) =>
			({ id, kind: "chat.message", data: { author: ann, text, attachments: [] } }) as unknown as EntryRecord;
		const mentionEntry = (id: number, included: number[]) =>
			({
				id,
				kind: "chat.mention",
				data: { author: ann, text: "@pi", attachments: [], included },
				model: [{ role: "user", content: "digest" }],
			}) as unknown as EntryRecord;
		// Mention 5 was composed with chat 2 and 3; chat 4 was placed while it waited in the queue.
		const entries = [
			chatEntry(6, "after"),
			mentionEntry(5, [2, 3]),
			chatEntry(4, "raced"),
			chatEntry(3, "b"),
			chatEntry(2, "a"),
			chatEntry(1, "old"),
		];
		assert.deepEqual(
			unmentioned(entries).map((entry) => entry.id),
			[4, 6],
		);
		// A mention still queued covers its chat too.
		const inbox = {
			items: [
				{
					id: 99,
					mode: "followUp",
					content: "digest",
					entry: { kind: "chat.mention", data: { author: ann, text: "@pi", attachments: [], included: [4, 6] } },
				},
			],
		} as unknown as InboxState;
		assert.deepEqual(unmentioned(entries, inbox), []);
	});
});
describe("chat-mode tutorial", () => {});
