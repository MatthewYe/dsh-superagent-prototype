# 0003 Jarvis voice relay as a standard Source

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** the maintainer, after a design review of the voice path

## Context

dsh-superagent reaches people through Sources. GitHub and Feishu are the two so far, and each one is a plugin that translates its platform's events into Triggers, applies the Source's part of the Policy, answers in the Thread it came from and reports health. The core knows nothing about either platform. The question this record answers is whether the Jarvis voice relay can join them under the same shape without giving up streaming speech.

Jarvis is a separate product. It owns the microphone and the speaker, speech recognition, speech synthesis and the device sessions, and a person already reaches it through a phone or glasses. What it lacks is the orchestrator: an agent that can answer a question and start work. A person should be able to ask by speaking, and hear the answer as it is written.

The two needs under one entry pull in opposite directions. A read-only question — the state of a Ticket, who is waiting on review — should be answered in one hop and spoken within about a second of the person finishing the sentence. A request for work needs admission, a Mandate, a Ticket, a worker, an audit trail and a report back to the device. One path cannot serve both: the ticket machinery makes the quick answer slow, and the quick answer has no authorization to work.

Four properties of the host decide much of the design:

- **The main Session is shared.** It is the long-lived Session that holds the orchestrator's routing context and answers the relays. It cannot become the private property of voice, and anything voice adds to its prompt must not reach the other relays' turns.
- **A steering message joins the running turn.** A voice turn must never merge into a dispatch turn that is already running, so voice turns are queued, never steered.
- **A live stream does not replay.** A follower attached after a turn started receives only the deltas produced after it attached; nothing already emitted is replayed, and the final text is the only complete copy of an answer.
- **One Source instance per kind.** Several devices cannot be several instances of one kind. v1 admits one device and leaves several device configurations for later.

The audio boundary is the other constraint. Jarvis already has devices, credentials and a reconnecting session; dsh-superagent should not learn any of that.

This record was drafted as ADR 0001 on 2026-11-14 and renumbered to 0003 once ADRs 0001 (Slack) and 0002 (Docker) landed.

## Decision

### Two paths, one entry

Every voice turn enters dsh-superagent through the ordinary receive entry as one human Trigger on a Thread of its own for the device (`jarvis:<deviceId>`), so admission, the Policy's Source part, the audit record and the Source's read position apply unchanged. What follows depends on what the turn asks for:

- A turn that only reads is answered by the **main Session** in one hop and streamed back. No Eval, no Ticket.
- A turn that asks for work follows the standard path — Trigger, Eval, Ticket, worker — and its result is reported to the device.

The main Session is the single triage point for a voice turn. It decides the path from what the person said and asks for the confirmation in the same spoken reply.

### The main Session answers the fast path

The main Session is located by its preset (`dsh-superagent-router`) through the host's agent registry rather than by a remembered Session id, so a re-created Session is still found and the preset remains the contract. The fast path is one model hop in that Session: no Ticket, no worker, no waiting behind a queue of work.

### Voice rules are a scoped, required prompt section

The voice rules — answer in one or two spoken sentences, confirm before starting work, no progress narration, no file names or identifiers read aloud — are registered as a required system-prompt section on the main Session's agent scope, and rendered only on turns that carry the voice marker. Relay messages, GitHub events and every other turn never see them, so the other paths keep their behaviour. The rules are a soft constraint: the model is asked to keep them, and no code verifies that it did.

### The plugin lives with the audio and talks over a bridge

The Source is a plugin that lives in the Jarvis repository and is built and versioned with it. It is a client of the new versioned bridge on the Jarvis relay; turns, text deltas and cancellation travel over it in both directions. Jarvis keeps the audio, speech recognition, speech synthesis and device sessions; dsh-superagent keeps the Trigger, the Ticket, the worker and the reply. dsh-superagent's core and its existing Sources are not changed; the only change on this side is configuration that loads the plugin.

### Streamed speech, with the final text as the fallback

Each text delta is spoken as it arrives, batched by sentence so the synthesiser receives whole clauses. The final text of the turn is spoken only when no delta arrived or the stream timed out, and it is always kept as the turn's audit copy. A dispatch turn is the one exception: its final text is spoken even after a streamed answer, because it is the record of what was handed to work. Speaking both the stream and the final text of an ordinary turn would repeat the answer.

### Completion is announced

When a Ticket that a voice turn started ends, its result is announced to the device that asked, while that device is online, in at most two sentences. The announcement waits while the person is speaking. A worker takes minutes, and a person should not have to ask whether the work is done.

### Interruption stops before the first tool call, and only the speech afterwards

When the person speaks over the answer, the turn is cancelled only if it has not yet made a tool call. Once a tool call delta has appeared, the speech stops but the turn continues to its end. A turn stopped before any tool call has produced no side effect to unwind; a turn stopped after one would leave a half-finished action and an inconsistent Ticket.

### One opening of the microphone is one turn

An open microphone produces one voice turn, closed by eight seconds of silence, by the spoken end word, or by a manual stop. If the first delta has not arrived within one second, a filler line is spoken so the device is not silent. Speech-recognition partials and several turns per opening are not in v1; they are v1.1, and the turn boundary is what they will change first.

### The bridge being offline is said out loud

When the bridge is not connected, the device is told that the orchestration service is unavailable and the turn is not queued. The older direct Session client remains in the Jarvis repository but is off by default.

### What v1 is

v1 is the chain and nothing more: the text bridge, the main Session answering, streamed speech, and the confirmation before work. Speech-recognition partials and multiple turns per opening are v1.1.

### Targets

First audio — the time from the end of the person's utterance to the first audible syllable — should be 1.2 seconds or less at the median, with speech delivered sentence by sentence. This target is what rules out waiting for a complete answer, and it is the reason the fast path exists.

## Consequences

Positive:

- Voice becomes a Source like GitHub and Feishu. Admission, the Policy, Mandates, Tickets, workers, health and the panel apply with no new domain concept.
- dsh-superagent's core does not change. The plugin is the whole integration, and removing it leaves the product as it was.
- Speech starts while the answer is still being written, so a long answer is heard once, in order, and the fast path can meet the first-audio target on a read-only turn.
- The voice prompt section is scoped to marked turns, so the relay and GitHub routing prompts do not inherit voice behaviour.
- Jarvis keeps what it already owns: audio, recognition, synthesis and device sessions. dsh-superagent never opens a microphone.

Negative, with the risks this accepts:

- **The confirmation and the execution strength are soft constraints.** The model can misread a turn, or be argued out of asking, and dispatch work without a confirmation; nothing in code stops it. Prompt wording is the only defence in v1. The trade-off buys one-hop triage and the latency target; if the risk fires often enough, a code-enforced gate returns as a new decision.
- **A cancel after a tool call leaves a half turn.** The spoken answer stops, but the work goes on, so the person may have withdrawn a request that is still being carried out, and the Ticket may need an explicit stop. A cancel before the first tool call is clean; there is no clean cancel after it.
- **The pairing is a version matrix, not any-to-any.** The plugin is built against a DeepSeek Harness version and the host's turn, delta and prompt interfaces; another host version can change the shape of a turn or a delta. The bridge interface carries its own version, and the two versions have to be tested together.
- **The fast path is only as fast as the shared main Session.** A voice turn queues behind whatever the main Session is doing, including relay and routing turns; voice never steers, so it cannot pre-empt. First audio can miss the target on a busy orchestrator.
- **A reconnect mid-answer loses what was already spoken.** Nothing is replayed, so the plugin recovers only from the final text onwards; the fallback can repeat part of the answer, and the audit copy is the final text rather than the spoken syllables.
- **One device in v1.** The kind admits one instance; several devices are a later configuration array, and concurrent speakers are untested.
- **Announcements have no queue across devices.** A completion waits only for its own device to be online and not speaking; there is no ordering between announcements.
- **The bridge is one more process to keep alive.** Jarvis being down is a health problem this Source must report, and the person hears about it only when they speak.
- **The spoken and audited copies can differ.** What was heard is the streamed text; what is recorded is the final text. The mismatch is accepted rather than reconciled.

## Alternatives considered and rejected

- **Every voice turn as a strict Ticket.** Rejected. Eval, a Ticket and a worker start would stand between the question and the first syllable, so a read-only question could not meet the latency target, and every trivial question would take a worker slot. The fast path exists to avoid exactly this; the slow path keeps the ticket machinery where work needs it.
- **A dedicated voice Session of its own.** Rejected. It would duplicate the orchestrator context the main Session holds, need its own lifecycle, recovery and prompt, and drift from the main Session's routing. Scoping a prompt section to voice turns in the shared Session costs one condition and keeps one source of routing truth.
- **The plugin connects to the device directly.** Rejected. The device speaks an audio protocol, and the network and credentials sit with the relay; a direct connection would put audio transport, speech recognition and speech synthesis inside the Source and give dsh-superagent responsibilities that belong to Jarvis. It would also break the no-core-change boundary.
- **A hard confirmation gate in code.** Rejected. A gate would have to classify every spoken turn twice — once to know whether it needs confirmation and once to route it — and would either block legitimate read-only turns or force a confirmation before every question. The prompt rule keeps triage in one place; the cost is the soft-constraint risk recorded above.
- **Keep the plugin in this repository and let it reach the relay.** Rejected. The bridge client changes whenever the audio protocol or the device session changes, and those are Jarvis releases; keeping it here would make every voice change a release of this product and add another product's build target to this repository.

## Revisit when

- Speech-recognition partials and several turns per opening arrive (v1.1). The turn boundary, the end word and the filler rule all change with them.
- A second device must speak at the same time, or the one-instance-per-kind limit is lifted.
- The confirmation is ignored often enough that a code gate is worth the latency.
- DeepSeek Harness offers a stable streaming or turn-marker interface, which would shrink the version matrix and the bridge protocol.
- Tool-call delta or cancellation semantics change, reopening what an interruption may stop.
- Jarvis exposes a result feed of its own, making the completion announcement a relay responsibility instead of this Source's.
