# Durable native hook delivery

Status: implementation design, not a completed boundary. The former HTTP behavior
is recorded in golden-only commit `cb60ad66b`. Three private HTTP/registry regressions
in `d771b8836` fail on the former implementation: an owned pending delivery is lost
on restart, a completed delivery is notified again, and a changed payload under the
same delivery ID is accepted after restart. Receipt
`20261011T072723.699358Z-96575` records those assertion failures and the unchanged
passing Linux/macOS golden.

Implementation checkpoint (October 11): the immutable journal and read-only
registration preparation are now connected to HTTP admission and background
recovery. The three original restart regressions pass. Native client outboxes,
precise process revalidation, global capacity and linked Stop completion remain
unfinished; this is not a completed delivery boundary.
Journal receipt `20261011T111043.022808Z-75081` passed TypeScript and 38 tests,
including every first-initialization fsync boundary, both directory-creation
interruptions, competing claims, immutable result retries and completion near the
actual history limit. Registry receipt `20261011T111651.613829Z-3216` passed
TypeScript, the prior admission cases except the three recorded restart regressions,
new staged-claim tests, transcript proofs and the unchanged Linux/macOS delivery
golden. A controlled ten-second disk wait preserves the prepared native facts;
replacement during that wait still holds.

Independent storage review found and prompted fixes for stale consumed records,
iterator redirection, descriptor acquisition races, terminal capacity, unconfirmed
visible results, interrupted initialization and claim revocation. The mechanics
review found no remaining storage blocker; process contention, HTTP integration,
native conversation ordering, client migration and final acceptance remain open.
The same review found mutable staged registration inputs and expired evidence
budgets; preparation now copies inputs and retains facts verified with fresh budgets.

HTTP checkpoint receipts `20261011T115141.118304Z-65604` and
`20261011T115706.434998Z-88317` cover confirmed restoration of accepted native prompt
times before a delayed Stop, no credit for an unconfirmed visible result, immediate
shutdown revocation, and the transcript recovery barrier. The unchanged delivery
golden, 162 queue/attach/golden cases, 40 journal cases and TypeScript pass. The first
full HTTP/admission run passed 77 cases and found one regression: a newer pending
intent could starve an already-owned effect. The queue now finishes its exclusive
claim before selecting a successor; that regression and all six restart/Stop/
shutdown cases passed the focused follow-up. This is combined evidence, not a
second uninterrupted full admission run. Full coverage and end-to-end gates remain
pending.

The HTTP review also identified cross-core pending-intake order, acknowledgements
after capacity refusal, registration callbacks after terminal publication, native
process changes during disk waits and recovered Stop/Cancel authority. The first
three have implementation fixes: claims compare the entire inspected frontier,
pending conversations participate in ordering, capacity is reserved before intake,
and synchronous registration dispatch precedes the terminal slot. Review of those
fixes and separate-process contention evidence remain outstanding. Exact native
birth evidence and durable Stop correlation are still open blockers.

The next checkpoint, validated through October 11 at 13:36 UTC, supplies precise
kernel boot and process-birth evidence, retaining the original caller ancestry
before asynchronous resolution. Revalidation still checks the Registry's declared
executable. The identity-only native probe excludes changing file descriptors;
descriptor completeness remains required by consumers that actually need it.
Unavailable caller evidence now receives a retryable hold rather than a terminal
ignored acknowledgement. Recovery isolates unreadable sibling rows and restores
its barrier after a failed ownership probe.

Attachment recovery retains the first-turn replay request across overlapping
attempts. Cancel revokes an in-flight candidate and replays its original byte
boundary before any later prompt. Cursor passes the exact complete prefix and
opened-file identity from that recovery fold to its watcher, so a prompt appended
between folding and installing the watcher remains live. Rewrites, incomplete
cutoffs and omitted history hold visibly. The recovery reader allows 64 MiB while
the watcher prefix allows 32 MiB; a larger controlled Cursor prefix remains held.
The complete bounded Cursor reader migration remains in the completion checklist.

Independent review found and verified corrections for overlapping attachment
requests, Cancel during attachment, recovery-barrier loss, Cursor's newer-EOF
baseline, and blank prefixes falsely classified as omitted history. Private
acceptance also reproduced recovery and admission racing one journal's namespace
initialization; callers now share only in-progress authority verification, never
completed disk observations or effect claims. Shutdown revokes every waiter.
The reviewer approved this slice over `956dbc881`; full PR approval remains open.

Receipt `20261011T133306.338423Z-24372` passed TypeScript, all 308 attachment/watcher/
tail/golden cases with 100% attachment coverage, and all 43 journal cases. Receipt
`20261011T133416.104343Z-30207` passed all 159 admission/core-hook/architecture/golden
cases and both affected private daemon cases: a real native prompt held across
Registry failure and Cursor Cancel superseding a linked Stop. Earlier failed
receipts preserve the blank-prefix and initialization-race regressions; the
passing acceptance followed the product fix, not a retry of unchanged source.
Native client outboxes, complete global storage accounting, separate-process
contention, durable linked Stop completion, final coverage/mutations and full CI
remain required. These validation and review intervals overlap implementation;
they are not summed as elapsed task time. PR #1172 is still draft, with no merge
or publication.

The client transport checkpoint (October 11 at 14:03 UTC) preserves the former
wire contract recorded in golden-only commit `d919061fc`. A connected reset,
truncated response or HTTP refusal cannot authorize an offline Registry write.
Acknowledgements require complete bounded JSON and endpoint-specific, typed,
consistent flags. In particular, a registration `ignored` reply or a malformed
Stop reply cannot delete Cursor's pending tasks. A total request deadline bounds
streams that never finish, destroys the request and suppresses late callbacks.
This fixes transport ambiguity; durable client outboxes remain required.

Receipt `20261011T135250.330481Z-21890` records eleven wrong-acknowledgement assertion
failures before correction. It also records the first fake-clock fixture attempt
timing out; that attempt is not passing evidence. The HTTP golden now uses native
HTTP requests with a frozen application clock, avoiding fetch's shared timer
scheduling and host-dependent selection of the 100 ms pending response. Neither
golden artifact changed. Receipt `20261011T135750.961288Z-46072` passed TypeScript
and 84 selected transport/client/golden cases (40 unrelated cases were excluded).
`20261011T140007.933057Z-55961` caught all fifteen deliberate transport mutations
with assertion failures. `20261011T140148.787638Z-64632` passed the complete
85-case standalone client baseline and both pending/duplicate Stop task-loss
mutations. Independent read-only review approved this slice over `d919061fc`;
it did not approve the unfinished delivery protocol. Validation and review ran
alongside implementation; the draft PR has no merge or publication.

Separate-process ownership evidence now covers seven real OS-process cases:
same-ID and distinct-ID claim contention, mismatched agent views of one retained
ID, a paused witness confirmation repaired by a peer, SIGKILL before that
confirmation returns, stale inspection before an equal-time intake, and completed
retry/conflict after process exit. Only a recognized journal/publication hold can
satisfy the losing contender assertion; fixture timeout or exit cannot pass it.
Receipt `20261011T141330.641854Z-19434` passed TypeScript, the pre-extraction native
probe golden and all seven process cases, then caught four deliberately missing
claim/order/completion/immutability fences with assertion failures. Independent
review approved the corrected process tests. This proves journal mechanics across
processes; final HTTP/native-client crash acceptance remains open.

The shared native control probe now takes an explicit helper provider; immutable
helper preparation and the kernel boot reader have no daemon configuration or
migration imports. Golden-only commits `742697a59` and `d24d78bdb` preceded these
extractions. Their Linux/macOS artifacts remain unchanged. Receipt
`20261011T143337.167967Z-16980` passed TypeScript, 35 caller/probe/architecture cases,
all 48 journal cases, all seven OS-process cases and five assertion-failing journal
mutations. Receipt `20261011T143607.014866Z-28081` caught all eight helper, precise
birth, kernel boot and Registry executable mutations by assertion. The preceding
recording run passed each check but reports `source_changed` because recording
created the new golden; only the later stable run is aggregate passing evidence.

Private acceptance exposed another race between confirmation of identical
immutable records. Nonexclusive confirmations may now join an in-flight sync;
each waiter retains its own record, route and owner fences. Exclusive publication
never joins, and confirmation cannot inherit dispatch permission. Three regression
assertions failed before correction in `20261011T142328.934198Z-67294`. Independent
review approved the probe extraction, confirmation fix and subsequent verbatim
boot extraction over `d24d78bdb`. Its requested producer-revocation test confirms
that a surviving observer can retry confirmation but cannot inherit a claim.

Receipt `20261011T142435.161799Z-72981` passed types, journal/preparation/delivery
goldens and the private Cursor Cancel case; the native Codex prompt case failed
waiting for its first acknowledgement. Earlier receipt
`20261011T142014.809689Z-49892` failed both private cases. Neither is full passing
acceptance. The remaining client has no durable retry after a pre-intake refusal
or an uncertain response; migration and a new private acceptance run are required.
No release or merge occurred during this checkpoint.

Client packaging will retain one self-contained `notify.mjs` artifact under the
existing updater, checksum and rollback protocol. The shared native probe must
receive its helper artifact and routed runtime directory through a pure interface;
it cannot import daemon configuration, legacy migrations, Registry or services.
Development output must expose a checked protocol version. Missing output or a
missing verified Darwin helper holds delivery rather than activating offline
fallback. Preserve the original UUID, time, body and caller across loading, and
bound all work by the hook deadline. These requirements received independent
design review; they are not yet a completed client implementation.

## Ownership before acknowledgement

Core must durably retain the immutable native body, delivery ID, native time,
original routing hints and proved engine process incarnation before acknowledging
owned pending work. A write that cannot be confirmed receives an unowned retry
response and a visible hold. Neither a service nor readiness waits for this work.

Use private, bounded, immutable intake/claim/result records under the daemon data
root. Each process-incarnation order namespace is keyed by kernel boot identity and
native engine birth identity. Agent ID is a separately checked ownership field,
not part of that key: two registry views of the same process must share one order
authority. A delivery ID is never reused within that process namespace. An
unavailable kernel boot identity holds new ownership instead of guessing from
wall-clock time. An immutable witness outside the record directory names its
identity and durable frontier: a missing or replaced history is unavailable
evidence, never an empty history that permits replay. The existing bounded native publication mechanism supplies
asynchronous file and directory sync, route/owner checks and actual-I/O capacity
retention. An exclusive bootstrap intent precedes directory creation; authority
pins both directory identities and a permanent seal confirms initialization before
any intake. All three records live outside the history directories. An incomplete
bootstrap may recover only empty private directories; established missing metadata
holds. This detects individual namespace and receipt loss, not erasure of all
independent outside evidence; a higher-level catalog must retain that boundary.
Existing corrupt, unsafe or contradictory records hold the delivery;
they are not absence. No record or user data is deleted to admit another event.

Healthy completed and held replies retain the former protocol. Distinct native
IDs remain distinct prompts, and one ID with another payload remains a conflict.
Legacy headerless callbacks can be durably owned under a generated ID, but cannot
prove that a later callback is their retry; the client protocol migration remains
necessary rather than pretending the server can infer that identity.

## Binding and crash recovery

An undispatched intake can be recovered after fresh proof that the exact original
engine process still owns the named route. Recovery must not depend on the original
short-lived hook parent PID. A replacement engine, reused PID, changed route,
unavailable process table or unavailable transcript cannot grant it authority.

Before binding and notifications, publish one exclusive effect claim. Only the
exclusive publisher, still in its original live attempt, may dispatch; confirming
an existing claim or its directory sync never grants dispatch ownership. Complete
results name that exact claim and are durable before the completed acknowledgement.
A receipt which already completed suppresses duplicate binding and notification.
An interrupted claim without a conclusive result is held visibly; it must never be
blindly dispatched again. Read-only reconciliation may establish facts already
committed, but cannot invent evidence that a callback or a turn-closing effect did
not occur. Completed prompt-time facts must be restored before they can contradict
a delayed Stop; optional notifications are not replay authority.

Every process has a recovery barrier. Before admitting a fresh conflicting hook,
applying a Stop, or publishing recovered interpretation, restore its complete
order frontier, maximum accepted prompt time for each conversation, unresolved effect claims and linked
Stop obligations. An incomplete scan holds that process with a visible reason.
It does not delay readiness or unrelated processes. A per-delivery claim alone
cannot serialize different delivery IDs from two cores: publication must share
per-process durable order authority: one immutable effect-slot chain per canonical
process key. Each exclusive slot names its validated predecessor result digest and
intake/frontier selection. Slot N+1 cannot dispatch until N has a durably confirmed
terminal result; an uncertain predecessor holds this process. Fresh frontier checks
alone cannot substitute for this shared chain. After each asynchronous durability boundary,
reprove current ownership and order, then check both again under the registry
commit boundary. An older claimant may not publish after a newer acceptance.

Recovery scans and active attempts need separate bounded capacities and fair
cursors. One stalled disk operation retains its actual I/O slot, while a bounded
reply keeps unrelated control responsive. Scans start after readiness, yield between
bounded batches, and cannot discard an old receipt to make room for a new delivery.
Shutdown revokes future effects before waiting for any outstanding operation.
Each process history is capped at 4,096 records, reserving claim and terminal
records before intake. This fits the complete final verification's operation
budget; the 196,608-record global allowance is not a safe per-process limit.
The starting resource budget is 64 pending deliveries per process, 65,536 retained
deliveries and 256 process namespaces, with 16 MiB of retained active payload and
256 MiB of immutable disk history. Count metadata and linked obligations too.
Count concurrent reservations before publication, then reserve capacity before
acknowledgement and hold visibly when full; never prune
completion records to reclaim authority. Recovery inspects at most 64 directory
entries or 20 ms per slice, rotates processes fairly, and allows four recovery
attempts and eight actual disk publications globally. An expired reply retains
its I/O reservation until the underlying operation settles. These are resource
bounds, not measured performance targets.

Linked Cursor/Command Code Stop reserves a durable completion obligation with
its first registration intake. Registration completion and Stop completion are
separate states; recovery installs unresolved Stop obligations before attach can
publish interpretation. Calling the current void `onTurnStop` callback does not
complete that obligation: it schedules asynchronous drain/grace work. Keep the
obligation until core records an authoritative terminal outcome under fresh turn
ownership, or conservatively hold it. Optional notification dispatch can be marked
as dispatched; asynchronous session control cannot use that marker as completion. After restart the former in-memory Cancel witness is
gone: completion must remain held unless durable correlation and Cancel/forget
revocation prove which turn it can affect. Rebuilding an in-memory witness after
restart does not grant new permission.

The native client persists its immutable UUID, original fired-at time, exact body
and engine incarnation before the first send. Owned pending and retryable 202 are
different protocol states; HTTP success alone is not acknowledgement. Retained or
possibly sent work must not fall through to offline registry mutation. Recovery
after the original caller exits must reprove the saved engine incarnation and
route, rather than reuse the short-lived caller PID. Generated plugins migrate to
the same identity/time contract; already-loaded legacy plugins retain an honest
hold explanation. Client outbox recovery and server intake recovery are separately
bounded, and neither may invent ownership for the other.

## Required evidence

Keep the former delivery, admission and installation goldens unchanged for moves.
Add crash-boundary tests before/after intake sync, effect claim, binding publication,
result sync and reply, plus same-ID contention, immutable conflicts, original-process
revalidation, pressure/fairness and corrupted storage. Include separate-process
contention on different IDs and different agent IDs for one process, a paused
predecessor claim, receipt/directory disappearance, delayed Stop arriving
before recovery finishes, linked Stop then Cancel then core crash, and a crash
during asynchronous Stop handling.
Deliberately broken wiring must fail assertions. Private daemon acceptance kills
the core while a real native hook is held, confirms readiness and unrelated control,
then recovers exactly once without using an owner's daemon, homes or tmux server.
The final client-protocol change needs its own explicit compatibility evidence;
installer source snapshots must not be silently re-recorded to hide behavior changes.
