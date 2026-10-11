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

The server now accepts a bounded versioned original-caller envelope. Its ordered
ancestry retains boot, precise birth and a SHA-256 digest of the complete v1 native
identity, including argv boundaries; a retry never expands that prefix from a new
caller. Cursor alone may retain its unique original agent/process/routes/primary
snapshot. Malformed or unsupported origins hold without live ancestry fallback.
Selection is only a restriction on subsequent native proof: the core still checks
the Registry executable and rechecks full process evidence after claim sync. Origin
bytes participate in the immutable delivery fingerprint and linked Stop provenance.
The client does not yet emit or persist this envelope.

The initial origin run `20261011T144212.626440Z-54874` passed types and 144 tests,
including unchanged caller/delivery goldens, and failed one new HTTP assertion
whose expected fixture prompt was misspelled. Receipt
`20261011T144621.205226Z-73389` passed types, all origin baselines, the corrected
HTTP case and two composed HTTP/real-owner-reader cases requested by independent
review. Wrong engine digest and changed Cursor route receive retry without intake,
registration, prompt credit or live capture. All eight deliberate origin mutations
failed assertions. This is combined evidence, not an uninterrupted full suite.
Independent review approved this origin slice over `96578014d`; client persistence,
linked Stop completion, global budgets and final PR acceptance remain open.

The client outbox storage now has its own persisted log kind. Golden-only commit
`955065fc1` records the former effect journal before this extension; its records
and HTTP delivery golden remain unchanged. The outbox wrapper freezes the exact
wire bytes before its first await, includes namespace/UUID/time/port/endpoints/body
in its fingerprint, and chooses a shard from namespace/UUID alone. Registration
and linked Stop have separate append-only ownership acknowledgements. Compatible
owned-pending and completed registration responses normalize to one fact;
registration never acknowledges Stop or authorizes task deletion. Intake reserves
every remaining ACK record and both copies' bytes under the exclusive frontier.
No effect claim or finish API is exposed by an outbox.

Independent review found and prompted two corrections: reconstructed/duplicate
delivery proofs now retain namespace and close/current fences without freezing
sibling appends, and canonical base64 avoids double JSON expansion of large
escaped bodies. Two maximum 256 KiB request bodies and their ACKs fit the outbox's
720 KiB intake envelope and existing 1 MiB record limit; the effects limit remains
300,000 bytes. Recovery confirms durability before exposing ACK flags. Corrupt
encoding, changed immutable bytes, unavailable sync and missing authority hold.
The reviewer approved this storage slice over `955065fc1`, conditional on the
subsequent passing affected checks; it is not final-head PR approval.

Receipt `20261011T150641.977884Z-72716` passed types and the initial storage/journal
regressions. `20261011T150937.744247Z-85420` passed nine actual OS-process cases
(including outbox capacity contention and SIGKILL after registration ACK) and
the five existing effect mutations, but failed the new mutation gate: redundant
conflict checks masked two incomplete fingerprint oracles, and one changed-input
test threw before its assertion. Those oracles were strengthened rather than
counted as passing. Final storage receipt `20261011T151558.627196Z-14856` passed
types, all outbox regressions, thirteen assertion-failing outbox mutations and
both unchanged effect/delivery goldens. Its checks took 4.3, 16.3 and 1.0 seconds;
implementation and independent review overlapped from approximately 15:00 to
15:17 UTC. The golden recording receipt reports `source_changed` as expected;
unchanged baseline receipt `20261011T150105.879117Z-47508` is the passing evidence.
This is storage machinery, not yet a shipped client: catalog sealing, global
logical/physical budgets, production staging wiring, bundled client emission/replay,
durable server Stop completion and final private acceptance remain required.
No merge or publication occurred.

The staging mechanics are now implemented behind an optional publication seam;
production journals still use their former staging path until catalog integration.
Eight immutable writer lanes bound payload scratch space. Exclusive ownership is
remembered immediately after atomic metadata publication, before any fallible
verification. Interrupted acquisition and initialization retain exact cleanup
authority for retry by the same live writer. Complete initializer history,
metadata bytes, directory iterator acquisition and authority rebinding are
verified; missing history cannot create a new owner. Cleanup checks its generation
and route before unlinking, survives request revocation, and confirms absence after
actual directory flushes. A dead predecessor's cleanup has the same final fence.
The shared disk limiter permits at most two actual flushes and 32 queued flushes;
16 acquisition slots retain real work after a bounded reply expires. A refusal-only
preflight skips full or live lanes, but never replaces full history verification
before granting a new lease. No success cache or general record pruning was added.

Receipt `20261011T162242.788937Z-24623` passed TypeScript, 59 focused publication/
staging/golden cases and thirteen assertion-failing mutations. The earlier
`20261011T161841.850935Z-4438` passed its functional checks but failed the newly
added initializer mutation oracle: removing one redundant guard still held safely.
The corrected mutant restores the original unsafe early-break scan and is rejected
by the regression assertion. Receipt `20261011T162606.968009Z-39654` passed types
and all 25 final OS-process, capacity, architecture and unchanged launch/journal
golden cases. Real OS-process cases cover exclusive contention for the last lane,
SIGKILL during a real file flush, and refusal to borrow a live writer's stage.
Child exit and timeout cannot masquerade as successful contender holds.

The final local capacity run recovered generation 8,192 in 1.43 seconds; its final
lease fence took 0.82 ms and the largest timer callback gap was 22.8 ms. A free lane
after full and live histories was acquired in 89 ms without enumerating either
skipped history. This measures real metadata reads with mocked fsync callbacks;
it does not establish physical flush latency or Linux CI acceptance. Independent
review approved this staging-mechanics slice over `4c113bc67`, with its final
process/capacity condition now met. Implementation, review and validation overlapped
from approximately 15:29 to 16:27 UTC; receipt durations remain separate from that
elapsed interval. Production catalog/budget wiring, client replay, linked Stop
completion and overall PR review remain open. No merge, release or publication.

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

The existing random staging names do not yet provide the cross-process bound:
crashed clients can leave files before winning the exclusive publication. The
reviewed replacement design uses eight writer lanes with immutable generation
claims and releases. Only an exclusive claimant may write; observers may confirm
release but never inherit a writer lease. Each stage has a generation/nonce/step
name that cannot be reused, and a lease serializes its stages. Cleanup touches
only that generation's exact files. A dead-writer reaper must prove the original
boot/PID/precise birth is gone; unavailable evidence holds the lane. Mirrored
claim/release metadata, initialization authority and reserved release headroom
count toward retained bytes. Those metadata records need bounded atomic
publication themselves, without using the random staging helper recursively.

Revocation stops new publication immediately but keeps the lane until actual I/O,
FD closure, stage removal and directory sync finish. Cleanup has narrow generation
authority separate from the expired request: releasing in the caller's outer
`finally`, or attempting cleanup with its revoked `attempt.flush`, is unsafe.
Directory identity and destination filesystem remain pinned; cross-device
publication holds. The 8,192-generation lane cap has the local recovery and
final-fence evidence recorded above. Retained content and bounded staging
bytes are distinct from filesystem block/inode allocation. This is independently
implemented staging machinery, not a production capacity boundary or final acceptance; no broader
cleanup, record pruning or user-data deletion is authorized by it.

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
