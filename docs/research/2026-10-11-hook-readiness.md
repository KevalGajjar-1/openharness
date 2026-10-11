# Native hook maintenance after daemon readiness

Startup awaited the initial native hook installer pass before it opened the request
gate and reported readiness. A bounded OpenCode version probe still delayed every
session until that probe completed or timed out. This violated the daemon completion
bar even though the installer no longer depended on an optional worker.

Core now starts hook maintenance after opening requests and reporting readiness to
the master. Each launch independently confirms the required native hooks through
its original ownership and executable snapshot. Startup maintenance returns its
shutdown controller immediately. The same revocation predicate reaches all thirteen
native installers, so teardown does not need to await a pending disk operation to
revoke permission for its later writes. Existing adopted-home retries keep their
own shutdown fence.

`settled` observes the initial installer pass for tests; readiness never awaits it.
Failures remain independently reported for each engine. A launch that needs an
unavailable hook remains held with its reason.

The former vendor, port, selected-engine, adopted-home and refusal coordination was
recorded from main `16569f3d2` in the separate golden-only commit `43c76ff1c`, before
changing startup. The golden pins both Linux and macOS platform values and uses
fixture installers and paths. Its artifact remains unchanged.

The private daemon regression keeps an OpenCode startup probe alive behind a
test-owned release file. The daemon must report readiness and answer agent-list
requests while that exact child is still waiting. Releasing it then completes the
hook installation. The former implementation becomes ready only after its deadline
kills the child, so it fails this assertion.

Focused validation passed types, architecture, startup ordering and 79 tests, with
100% per-file statement, branch, function and line coverage of the hook coordinator.
Receipt: `20261011T053403.766571Z-65433`. The final dependency integration, full core
and master coverage, wiring mutations, private daemon acceptance, matched startup
cost, independent review and PR checks remain required before landing. No release
is authorized.
