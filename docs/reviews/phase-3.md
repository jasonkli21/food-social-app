# Goodfork phase 3: reliable decisions and a private dining memory

Independent defensive review and implementation handoff, 17 November 2026. This document covers the available repository snapshot, not a Git diff. No application code was changed during this review. No applicable project or ancestor AGENTS.md was found; dependency-local instructions do not govern this document. I read all of phase-2.md, including its main-session additions and implementation/verification record, and independently inspected the current implementation.

## Product and architecture assessment

The prototype now has credible connected loops: discover a restaurant or dish, inspect a first-party review, save, deliberately rate, optionally upload, and compare; a verified manager can update facts and answer a review. Typed Expo screens, interchangeable sample/HTTP services, a compact Go API, PostgreSQL transactions, and private object delivery are appropriate foundations. Keep them. Introducing microservices, a general autonomous agent, or a separate search engine now would increase uncertainty without solving the main product gaps.

The largest remaining gap is that “Log a visit” actually means “create or replace your one public review.” A second meal cannot become a separate private memory. Meanwhile, practical hours are unstructured strings, so the app cannot reliably answer whether a restaurant is open. Phase 3 should close those two gaps while repairing the concrete review findings below. The result should be a coherent **choose → visit → remember → optionally review** experience, with **maintain hours → preview diner facts → answer reviews** for owners.

Public source-backed content currently means Goodfork diner reviews and canonical listing fields. It does not establish an externally verified visit, imported Google/Yelp review provenance, allergen safety, real-time menu prices, or reservation availability. Product language must retain those distinctions. Preserve the visual identity and existing navigation; improve the semantics before adding more surfaces.

Strengths confirmed in source: explicit Google linking with password verification and subject-based returning login; device-bound handoffs; hashed bearer sessions; shared action/mail quotas; parameterized SQL; place-serialized claim/listing/reply/publication transactions; immutable reply report evidence; ownership-conflict holds; additive migrations; authenticated private media; conservative provider outputs; and scoped read cancellation. These fixes should not be undone while extending the model.

## Prioritized findings in the current code

Priorities describe impact: P1 is a trust or release-blocking issue; P2 affects important correctness, usability, or operational assurance; P3 is bounded polish. These are current-source findings, not a repetition of the baseline line numbers in phase-2.md. Paths and lines refer to the snapshot reviewed here. Acceptance criteria below are proposed checks unless explicitly marked as executed.

### F01 — P1 before public community use: editable reviews and listings can outlive their report eligibility

Evidence: `server/internal/goodfork/social.go:233–239` inserts every non-reply report with the default empty target version and silently ignores uniqueness conflicts. `sql/005.sql:21–25` keeps uniqueness on reporter/type/target/version. `operations.go:29–39` reads the live post/profile/listing instead of the reported version. `posts.go:215–221` changes a post revision on edit, but the report path does not use it. Thus, after one report is resolved, that same reporter's later report of a materially changed review or listing returns success without creating new work. An edit can also replace what the moderator sees for an existing report. Reply reporting already solves this problem for one content type.

Fix in this phase: extend versioned reporting to posts and listings, with bounded immutable evidence, author attribution where applicable, expiry, and explicit queue comparison to the current version. For profiles, use a version or server-computed content fingerprint; unchanged content must not create an unbounded report loop. Comments are immutable: retain their text at report time if evidence must survive deletion, and document its retention. Do not falsely acknowledge a new report that was discarded; return an explicit already-reported state when appropriate. Moderation against a stale report must not silently act on a different revision. Preserve immediate intentional hide actions through a separate explicit current-content operator path.

Acceptance: report v1, resolve it, edit to v2, report v2, and observe two distinguishable records. Edit/delete after reporting and verify bounded evidence remains available only to operators for the defined retention period. Account deletion removes evidence attributable to that author; cleanup expires it. Guest, blocked viewer, author self-report, and stale-version paths have negative checks. No evidence enters public DTOs or normal logs.

### F02 — P2: public review editing has no stale-editor precondition

Evidence: `posts.go:54–60` has no input revision; `posts.go:211–221` generates a new revision but does not compare the version the diner edited. `src/screens/Compose.tsx:133–135` submits only score/dish/text. Two devices can overwrite each other's edits, including the deliberate public score, despite the existing version infrastructure.

Fix: require the review revision for new-client edit/delete operations; reject stale edits with 409 and show current text, dish, and score while retaining the local draft. Serialize with the existing place lock. Be deliberate about old clients: a versioned endpoint or advertised capability is preferable to quietly allowing unconditional writes to the same protected path. Do not derive a revision after receiving an old draft and call that conflict detection.

Acceptance: two editors open v1; A saves v2; B cannot overwrite v2 without reviewing it. A repeated successful mutation with the same operation identity should recover its result when practical. Post moderation and ownership transitions remain serialized and the ownership hold remains effective.

### F03 — P2: bounded dish search can drop the only nearby match

Evidence: `directory.go:120–131` limits to 300 review rows after only a latitude check, then deduplicates by restaurant. Actual 50 km distance filtering occurs later at `directory.go:144–154`. Three hundred newer matching reviews far away at the same latitude can crowd out the only nearby match. Many reviews for a single restaurant can similarly consume the entire candidate budget before distinct restaurants are selected.

Fix: apply the full spatial eligibility predicate before bounding and bound distinct eligible restaurants, choosing one deterministic visible source review per restaurant. Define whether the remaining cap is intentionally incomplete and expose that limitation if it can affect ordinary search. Retain visibility filtering before evidence selection. Inspect query plans with a skewed dataset, not only one review per restaurant.

Acceptance: 300 newer remote matches plus an older local match still finds the local match; 300 reviews of one place do not exclude all other matching places. Include near-pole and date-line fixtures if longitude bounding is introduced. Hidden, blocked, and pending sources never qualify. A read-only synthetic SQL probe during this review confirmed the filter-order mechanism: one actual local row becomes zero after the current limit-before-longitude order; it was not a full API regression test.

### F04 — P2: comment submission can discard typing entered while the request is in flight

Evidence: `src/screens/Details.tsx:123–135` submits the captured draft and then unconditionally clears the input and rotates its request ID. The input remains editable at `Details.tsx:184–186` and each keystroke rotates the current ID. A person posting one comment and typing the next before completion loses the next text. Editing after an ambiguous failure also changes the retry identity, allowing two related comments if the first had committed.

Fix: capture a submitted draft/version/request ID; clear only that submitted version, or disable editing for the short submit interval with clear state. Preserve an ambiguous operation until its outcome is reconciled; distinguish retrying the same comment from intentionally submitting a new one. Reuse the pattern for private journal writes.

Acceptance: delay a successful response, type a second draft, and verify it survives; simulate response loss after commit and retry without duplication. Keyboard focus and accessible submission status remain predictable.

### F05 — P2: stale listing recovery does not show all fields that “Keep my draft” will replace

Evidence: `src/screens/Owner.tsx:197–206` displays current hours and description only, then accepts the latest revision while retaining all draft fields and submits the complete listing. A manager can overwrite an unseen newer phone, website, menu, dietary tag, or price while resolving an hours conflict.

Fix: present all changed fields, or track dirty fields and merge only explicitly chosen edits against the freshly loaded revision. Prefer a compact per-field “current / your change” presentation with a single deliberate publish action. New structured hours must use this same conflict behavior.

Acceptance: concurrent edits to hours and phone preserve both unless the user explicitly chooses to replace the phone. A second intervening change triggers another conflict. No draft disappears on reload failure or role revocation.

### F06 — P2: the audit trail records a role class but cannot identify the actor

Evidence: `operations.go:54–63` and `sql/005.sql:29–35` record only `operator` or `restaurant_manager`, action, target, version, and time. Historical owner transitions and multiple human operators cannot be attributed. This is useful event evidence, but it is not an attributable audit trail.

Fix: add nullable manager actor ID and a controlled operator principal identifier derived from the execution identity or required CLI configuration. Do not accept an actor from an untrusted HTTP body. Record action outcome and previous/current version when useful; keep private text, verification evidence, email, credentials, and prompts out. Use a documented deletion/pseudonymization and retention rule. Historical rows honestly remain “legacy actor unknown.” The operator CLI must have an ordinary way to supply its identity without embedding secrets.

Acceptance: two operators and two successive managers produce distinguishable events; denied operations cannot forge success events; runtime cannot read or update history; account deletion follows the documented privacy rule. Verify actual commands under the restricted roles, not just table grants.

### F07 — P2 release/operations risk: database work is not bounded by the HTTP write timeout

Evidence: `server/cmd/goodfork/main.go:205–209` constructs the HTTP server with read/write deadlines, while `api.go:160–176` passes `r.Context()` directly through authentication and handlers. `db.go:25–33` bounds connection setup and pool size, but sets no general query/lock deadline. Socket write deadlines do not themselves cancel a query waiting for a database lock. Eight blocked pool users per instance can consume capacity long after the client gives up.

Fix: add explicit bounded contexts for interactive API work, with a separate longer upload/media streaming budget and smaller database-operation budgets where appropriate. Configure database statement/lock timeouts compatibly with transaction pooling; avoid session settings leaking between requests. Map timeout/cancellation to stable retryable errors. Do not apply a short JSON timeout to byte streaming indiscriminately.

Acceptance: an isolated test holds a listing lock, the endpoint times out within its stated budget, and a subsequent request can use the pool after release/cancellation. Include auth lookup and owner writes. Verify shutdown cancels outstanding work. Measure before changing pool size or maximum instances.

### F08 — P2 evidence gap: current tests do not establish transaction races or full production-role operation

Evidence: `api_test.go:295–339` exercises ownership and revisions sequentially. `phase_test.go:115–130` performs one allowed and one denied query per role. `phase_test.go:213–214` unnecessarily requires PostgreSQL even for a standalone TLS provider protocol fixture. Go's race detector checks Go memory races, not database schedule correctness. A passing suite is valuable but cannot substantiate untested concurrent interleavings or all deployment commands.

Fix: add a small set of deterministic barrier-driven concurrent PostgreSQL tests for approve/revoke versus publish/reply/listing and report versus edit. Execute the ordinary API/CLI functions under runtime/operator/cleanup grants. Decouple pure provider tests from DB availability; split major ordered scenarios into independently seeded tests. Add malformed core DTO boundary checks where a wrong shape otherwise crashes rendering (`client.ts:112–121` checks only item IDs, and detail requests are casts).

Acceptance: tests prove both possible ordered outcomes satisfy the invariant, not merely that no SQL error occurred. Missing DB configuration must fail the required integration command. At least one new UI regression must exercise each repaired client race/conflict state.

### F09 — P2 release limitation, not a claim of complete media sanitization

Evidence: `media.go:131–143,180–217,220–236` validates selected container/codec declarations and erases known metadata boxes; it does not decode the actual video samples, normalize all metadata, or prove a device can play them. `media.go:110–128` decodes and re-encodes photos without handling EXIF orientation, so direct API JPEG clients can lose orientation when the metadata is stripped (the normal composer already normalizes through ImageManipulator). Four simultaneous 12-megapixel decodes plus input/output buffers also need an actual memory measurement against the documented 512 MiB deployment.

Immediate response: keep the narrow internal prototype contract, make photo orientation correct with a bounded implementation or explicitly reject unsupported orientation until normalized, and add benign rotated-image fixtures. Add configurable upload concurrency and record peak memory with valid large fixtures. Keep the broader video rendition pipeline in the release roadmap; do not describe the current parser as full video validation or complete privacy normalization. Do not silently broaden accepted formats.

Acceptance: ordinary portrait photos retain visual orientation and no location metadata; valid fixture playback still works; range, auth, missing storage, deletion, and cleanup tests remain green. Native real-world clip and complete metadata evidence are separate gates.

### F10 — P3/accessibility and scale: a few important surfaces remain hard to scan or grow

Evidence: `cards.tsx:146–149` flattens a review excerpt into “Read review of [name]”, omitting dish and review context from the accessibility label; `cards.tsx:198` gives the Watch clip control a 35-point minimum. Place reviews, owner inbox, and comparison choices still map all loaded rows inside a scrolling Screen (`Details.tsx:92`, `Owner.tsx:125`, `Saved.tsx:97`). The main Saved list is already virtualized; preserve that improvement.

Fix in touched surfaces: include meaningful short review/dish context in labels, keep an explicit full-review route, use at least 44-point controls, and virtualize the new journal and growing owner/review lists where feasible. Verify focus order, screen-reader labels, large text, reduced motion, and error announcements. Browser viewport success alone is not VoiceOver/TalkBack evidence.

## Independent checks actually executed

- TypeScript: the installed Node runtime ran `node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals`, passed.
- Go: `GOMODCACHE=/private/tmp/goodfork-go-mod GOCACHE=/private/tmp/goodfork-go-cache go vet ./...`, passed.
- Required integration run: `GOODFORK_TEST_REQUIRED=1 GOODFORK_TEST_DATABASE_URL='postgres://localhost/postgres?host=/private/tmp/goodfork-phase2-pg/socket&port=55436&sslmode=disable' go test -count=1 ./...`, using the same cache variables, passed after an approved sandbox escalation for the disposable local socket/TLS listener. The first sandboxed attempt failed on socket permissions, not on product assertions. The successful package run reported approximately 2.05 seconds.
- Read-only synthetic SQL demonstrated F03's candidate-order failure mode using 301 generated rows. No application fixtures or schema were changed by that probe.
- Inspected migrations 001–005, grants, auth/linking/session paths, moderation/ownership/report paths, media, directory/feed, assists/adapters, request state/hooks, principal diner/owner screens, sample service, existing tests, and deployment documentation. No application code was modified and no offensive testing was performed.

I did not rerun exports, audit, race tests, Playwright, native UI, or the 10k-row query plan benchmark. phase-2.md records the main session's earlier successful checks; those are inherited evidence, not independent results from this reviewer. No live credentials or service provisioning was assumed. No native device, real OAuth/SMTP/provider, Cloud Run, Neon pooler, or GCS claims were verified here. The findings above identified by code reasoning have not all been reproduced through UI/API tests; their acceptance cases should become the regression proof during implementation.

## Design decisions and end-to-end journeys

### Diner: decide without surrendering privacy

A guest starts in Discover or Explore, selects an area manually or grants foreground location, searches a dish, and sees restaurant identity, neighborhood, rating/count, approximate price, and explicit hours status. A source link opens the actual review; back returns to the same results. “Hours unavailable” is a valid outcome, never inferred from prose. Dietary tags remain attributed listing information, not safety guarantees. Saving prompts sign-in only when needed. Preserve the intended action across authentication when possible, while discarding drafts belonging to a previous account.

After a meal, **Log a visit** offers **Private memory** as the default and **Public review** as an explicit choice. The private form has restaurant, local visit date, optional dishes, optional note, and optional personal score. A small persistent label says “Only you.” It does not upload media or send data to AI in this phase. Save leads to a readable journal entry and optional “Write/update public review.” Publishing opens a separate review composer and requires a deliberate public score and public text; private notes are never silently copied. Repeated visits create separate entries; public community rating still counts one current review per person/place. Personal restaurant rankings remain anchored to the existing review IDs in this phase, with clear copy that they rank restaurants, not every journal event.

Saved gains a third segment, **Journal**, alongside Want to go and My rankings. Place has **Your visits** and an **Add private visit** action, while its public review control remains available. An existing public review remains editable with conflict handling. Do not backfill public reviews into private visits automatically: review creation time is not a reliable visit date. A user may intentionally save an existing review as a private memory through a prefilled form with a date they confirm.

Failure paths are part of the design: preserve fields on network errors, keep a stable operation ID across retry, show a read-only unavailable-place label for an existing private memory if a listing is hidden, and do not leak private entry counts into public profiles. On sign-out/account change, remove private screens and drafts, cancel reads, and clear cached journal state. Device persistence beyond the current form is deferred unless implemented with explicit account scoping and deletion semantics.

### Owner: maintain useful facts and see exactly what diners see

The owner enters Restaurant tools through You or Manage restaurant on Place, selects a verified listing, edits hours, previews the resulting week and current diner status, then publishes with a revision. Keep description/contact editing in the same workflow. A typical week supports closed days, split service, and an overnight period. Date-specific exceptions override that day's weekly schedule. A timezone is required for structured hours; the server verifies it against an IANA timezone database. No browser timezone or restaurant city guess should silently determine it.

The public listing shows “Open now”, “Closed”, or “Hours unavailable”, the restaurant-local schedule, and the relevant next change when known. “Open now” means within supplied business hours; it does not mean tables, kitchen availability, or holiday accuracy beyond entered exceptions. Owners see provenance/freshness and can preview a chosen date. Legacy string hours remain visible as “Hours provided” until deliberately replaced; do not parse them into authoritative availability.

An owner then filters Needs a response, reads the diner review, optionally requests an editable local suggestion, and explicitly publishes. Revocation or another manager action must invalidate authority server-side regardless of what the UI still displays. A stale form compares every changed field and retains the draft. Claim contact details and operator evidence remain private. Closed/hidden listings need an understandable support path; a report is not a claim or an edit suggestion.

## Finite immediate phase and implementation sequence

The immediate implementation consists of the following five deliverables. Named lists, manager teams, reservations, large-scale ranking, and a production media pipeline are not part of it.

1. **Repair F01–F08 and touched accessibility issues from F10.** Add focused regression cases before or with each fix. F09 gets the bounded photo/concurrency checks and accurate contract language; broader video work remains gated below. Preserve existing Google/password, source visibility, upload moderation, ownership holds, and ordinary sample/connected entry points.
2. **Private multivisit journal.** Implement create/read/update/delete, paged personal history, per-place history, empty/error states, idempotent create, revision-protected edits, and explicit transition to public review. Keep media out of private entries for this slice to avoid expanding object authorization and processing at the same time.
3. **Structured hours and open-now discovery.** Implement owner weekly hours, timezone, exceptions, preview, diner availability display, and an optional open-now directory filter. Keep unknown hours distinct from closed and keep legacy reads working. Hours must affect both normal search and local assist through the same server evaluation.
4. **Complete the connected loops and parity.** Extend `types.ts`, `Service`, `client.ts`, and `demo.ts` together; use existing Place, Compose, Saved, Manage, EditListing and Explore navigation. Build a shared contract fixture set for journal/hours semantics. Sample mode may label its simplified moderation behavior, but must match the new feature semantics and conflict behavior.
5. **Verify and record actual evidence.** Fresh/upgrade migrations, role-scoped commands, concurrent writes, API fixtures, sample/connected browser flows, exports, and an explicit remaining device/deployment checklist. Update README and this handoff's implementation record only with observed outcomes. No approval ceremony is needed for these authorized local changes.

Design the compact forms and state transitions before writing their handlers. Favor a small reusable conflict view and a pure hours evaluator over separate implementations in every screen. Keep this scope finite: do not add arbitrary AI features merely to label phase 3 “AI-powered.”

## Compatible API, data and IAM plan

### Additive migration 006

- Add `private_visits`: UUID ID, person FK with cascade, place FK, unique `(person_id,request_id)`, `visit_date` (calendar date, not fabricated timestamp), optional bounded note/dish and nullable score, revision UUID, created/updated timestamps. Index `(person_id,visit_date DESC,id DESC)` and `(person_id,place_id,visit_date DESC,id DESC)`. Existing IDs, posts, saves, and `people.rank_order` remain intact. If places are ever physically deleted, choose and test a minimal private name snapshot plus nullable place reference or a deliberate cascade policy; do not accidentally erase memories through operator directory cleanup. Current hide behavior should preserve entries.
- Add structured hours fields/table with timezone and a representation for weekly periods and date exceptions. A normalized periods table or strictly validated bounded JSON is acceptable; choose one and enforce the same invariant in Go and DB constraints where practical. Cap periods per day and exceptions, reject overlap, support overnight boundaries explicitly, and represent closed versus unknown separately. Couple updates to `listing_revision` and place locking. Keep legacy `hours` strings for older clients and synthesize their display projection from structured data after publication.
- Extend report evidence/version and actor audit fields with explicit retention and deletion behavior. Avoid unrestricted JSON snapshots containing private user objects. Existing reports keep a clearly identified legacy state; do not invent missing historical evidence.
- Update grants explicitly. Runtime gets the necessary journal rights; ordinary operator and cleanup identities should not gain private note reads. Account deletion uses FK cascades. Cleanup gets only what actual expiry/object work requires. Test old 005 data upgrades and unchanged public score/ranking behavior.

### Service/API additions

Use `/v1/me/visits` and `/v1/me/visits/{id}` for authenticated CRUD; accept an optional place filter and keyset cursor. The viewer is derived solely from the session. Creation accepts a client operation UUID; edits accept a revision. Use the existing error envelope and 404 for another person's IDs. Explicitly select fields in the private DTO; never embed it inside `gf_place` or `gf_post`. Per-place “my visits” can be a separate private query, avoiding private data in public/share projections. Journal reads for hidden places return only the user's permitted memory and a minimal unavailable-place marker, never hidden public review/media content.

Use the existing owner listing endpoint or a dedicated `/places/{id}/hours` write with the same listing revision and role predicate. A public `hoursStatus` addition can include state, restaurant-local date/timezone, next transition, source and updated time. Accept `openNow` as an optional search flag. Compute the evaluation instant on the server once per request; pagination must carry or bind the same as-of instant so a closing boundary does not unpredictably move entries between pages. Do not expose an unrestricted client SQL/time expression. Test timezone/DST behavior in a pure function and route fixtures with a controlled clock.

Preserve `hours`, existing place/review shapes and prior reads. For new edit preconditions, state the rollout contract explicitly rather than silently breaking old clients. Deploy migration before new server, then new client; new nullable fields should have safe read defaults. The sample storage schema needs an explicit version/migration for new fields, not a blind cast of old persisted objects.

### Boundaries that must remain true

Public restaurant details, public reviews and approved media are guest-readable. Blocking filters the signed-in viewer's eligible content; it cannot revoke previously downloaded public content or prevent logged-out public viewing. Private visits, personal ranking order, saved state, business claim contacts, sessions, and moderation evidence are never public. Verified management permits only that listing's facts and attributed responses; it does not permit editing diners' reviews or reading their private journals. Operators act through the restricted CLI, not an unguarded HTTP route. Cloud roles and DB roles are separate controls; their configured existence is not inferred from source files.

For writes, retain a consistent lock order and document any cross-entity order introduced by the journal transition. Do not hold database transactions open across SMTP, storage, or provider calls. The private-memory-to-review action should be a deliberate client transition, not a distributed transaction pretending that two independent records must always be identical.

## AI scope for phase 3

Keep the provider interfaces and strict, two-second HTTPS adapter. The current category-selection contract is intentionally conservative; the local algorithm can complete both features. New hours eligibility is ordinary deterministic logic, never a model prediction. Private notes, visits, precise location, account identifiers, raw review text, and claim details stay out of remote requests. Existing per-request opt-in remains explicit and off by default.

Improve intent quality locally before adding remote capabilities: handle common negation and conflicting preferences by showing ambiguity rather than silently selecting a forbidden cuisine. `assist.go:94–120` currently recognizes labels independently of negation and strips filler words; a request such as “not Italian” can select Italian while retaining an unhelpful literal “not”. Add fixture cases, including contradictory diets, unavailable exact budgets, unknown area, no evidence, and closed-versus-unknown hours. Keep filters editable and describe origins as listing facts or a linked diner mention.

If a different provider protocol is later needed, add an adapter behind the same typed operation rather than coupling screens to model APIs. Retain allowlisted outputs, no redirects, bounded bodies, consent checks, budgets, cooldown, conservative fallback and server-side evidence. Record operation/outcome/fallback reason/latency and bounded usage if a provider supplies it; never log prompts, text, secrets or precise location. Test both dining and owner-reply adapters, including consent-off making zero outbound calls, timeout, transport failure, invalid enums, malformed JSON, cooldown and role/review changes during generation. Provider configuration is an optional deployment detail, not a prerequisite for the journal or open-now feature.

## Acceptance and regression matrix

| Area | Required proof for this phase |
| --- | --- |
| Private memory | Two visits at one restaurant persist separately; optional score works; public score/count does not change; duplicate retry creates one entry; stale edit conflicts; delete removes only the chosen visit; other users/guests/operators cannot read notes; account deletion cascades; hidden restaurant behavior is explicit. |
| Review transition | Existing one-review uniqueness remains; journal does not auto-publish; public composer requires deliberate score/text; existing review is offered for edit; comparisons and prior rank order survive upgrade; no private note leaks through a share, feed, profile, AI request, log or owner inbox. |
| Hours | Closed, unknown, split hours, overnight, exception closure, exception override, timezone difference, DST transition, malformed/overlapping ranges, legacy strings, and as-of pagination have deterministic outcomes. A manager sees the same preview state as diners; stale updates retain drafts. |
| Auth/IAM | Guest, diner A/B, pending claimant, active owner of A, owner of B, revoked owner, operator and cleanup roles get only their intended rights. Existing Google collision/linking, verified password, resend/recovery and deletion checks pass. Test a private read returning after account change. |
| Transactions/moderation | Deterministic concurrent schedules for ownership/publication/reply/listing, stale reports and edits, plus idempotent retry after response loss. Verify invariant and stored state, not only HTTP status. |
| Search | Skewed dish fixtures from F03, no-review restaurants, source visibility, normal/manual area search, denied location, open-now including unknown hours, list/map consistency. Keep fallback useful in a town with no social content. |
| Client behavior | Delayed comment response, account transition, preserved form drafts, conflict comparison across every edited field, large/narrow layout, keyboard traversal, loading/error/retry, save consistency, journal paging, clip play/pause/reduced motion and full-review path. |
| Media | Rotated benign photo fixture, metadata removal, size/pixel limits, valid clip fixture and rejection cases, authorized byte range, missing object, hidden/block/deleted parent, no protected cache reuse, bounded concurrent memory, cleanup retry. |
| Delivery | Frozen locked install; TypeScript including unused locals; Expo iOS/Android/web exports; Go vet, required DB suite and race suite; fresh and populated 005→006 migrations; role operation tests; local TLS provider fixture; sample and connected UI smoke. Record failures and remaining environmental limitations accurately. |

For performance, repeat a documented workload rather than inventing a universal latency threshold. Include popular restaurants with many reviews, many journal entries per user, heterogeneous hours, multiple areas, simultaneous reads/writes, and a blocked-content population. Measure route p50/p95, query plans, query count per UI action, pool waits, peak upload memory and response bytes. The phase-2 single-run query timings are a baseline observation, not a scalability guarantee.

## Later roadmap, separate from the immediate phase

1. **Planning and sharing:** private named lists, then explicitly shareable/revocable lists with owner-controlled visibility and no accidental private note inclusion. Add collaborative outing planning only after a stable list model exists. Improve missing-place submission with address confirmation/map selection and licensed geocoding; raw coordinates should not remain the primary ordinary-user route.
2. **Restaurant utility:** durable listing field provenance/history, correction suggestions and duplicate merges with redirects, temporary/permanent closure states, richer attributes, menu/dish structure and sources. Integrate reservations/waitlists/external catalog data only with documented rights and freshness semantics. Never imply first-party scores include external provider reviews unless that is explicitly true and permitted.
3. **Community and memory:** taste overlap, transparent following signals, friend discovery and privacy settings, journal search, optional private media, intentional review history and restaurant ranking reconciliation. Measure useful local coverage and discovery-to-save/visit conversion before increasing personalization complexity.
4. **Clip quality:** accessible captions/transcripts and creator descriptions, poster generation, asynchronous private ingest, standardized renditions, complete metadata handling, idempotent processing jobs and explicit processing/failure UI. Any transcription provider requires its own consent, privacy and retention treatment. Keep one canonical restaurant and source review for each clip.
5. **Owner teams:** invitation, role delegation, least-privilege staff rights, attributable response drafts and handoffs, team revocation and conflict resolution. Existing single-manager constraints must be intentionally migrated; do not merely remove a uniqueness constraint.
6. **Measured scale:** add aggregate tables when repeated `gf_place`/`gf_person` counts dominate profiles/feed; inspect broad directory sorts and dish fanout; introduce spatial indexing when actual locality workloads warrant it; add media delivery infrastructure with authorization semantics before a public CDN. Keep explainable ranking and cursor semantics. Embeddings, recommendations services and multi-region architecture need measured justification.

## Deployment and device gates

Local implementation can proceed completely without cloud credentials. Before a pilot using real accounts, separately verify Google OAuth callback/cancellation/account collision/linking on iOS and web, real verified non-Gmail signup and SMTP failure behavior, session storage/logout/deletion, private GCS Put/read/range/delete with the actual service identities, Neon pooled transactions and connection budget, Cloud Run cancellation/startup/shutdown/resource limits, and scheduled cleanup with real failure alerts. Test restore from backup with documented deletion/retention reconciliation. Add operational metrics for errors, latency, pool waits, quota exhaustion, moderation queue age, cleanup backlog and provider fallbacks without sensitive payloads. Establish who handles reports and claim verification; a CLI queue alone does not establish operating coverage.

Before a public iOS release with Google login, re-check current store requirements and implement/verify the equivalent privacy-preserving sign-in option identified in phase-2.md. Native install, VoiceOver, large text, permission denial, Maps, picker orientation, clip codec compatibility, foreground/background playback, deep links and low-memory behavior require device evidence. Android remains a compatibility target with separate permission, Maps and TalkBack checks. Validate actual policy/support URLs, store privacy disclosures and account-removal behavior against the final data flows. Re-check authoritative platform/provider documentation at release time; this review did not browse current policy pages.

Do not mark these gates complete because bundles export or local fixtures pass. Conversely, do not let missing credentials block the finite local feature and regression work above. The next main-session step is to critically validate this handoff, refine any disputed finding with a focused check, and implement the defined immediate phase through the normal app and API entry points.

## Main-session review and implementation decisions

The main session reviewed the complete handoff and inspected the reporting, public review mutation, directory query, request middleware, media decoder, owner editor, client state, and sample persistence paths before starting phase 3.

- F01 requires immutable evidence for every supported report target and a target version attached to each decision. Add explicit report-scoped hide actions for reviews and listings. Existing current-content moderation actions remain intentional operator actions. Duplicate reports return an explicit conflict. Evidence retains its 90-day expiry and author-deletion cascade.
- F02 will require a revision on public review edits and deletion. This is a pre-release write-contract change. Older readers keep working, and clients omitting the new precondition receive a recoverable conflict. A replay whose fields already equal the current review can recover the current result.
- F03 should remove the review-row cap from canonical dish eligibility and select one latest eligible source per place. Applying exact distance before source selection avoids both longitude skew and popular-place crowding. Keep page limits and indexed dish matching, and measure the skewed workload.
- F05 should merge only fields deliberately changed from the loaded base. Show every field whose draft conflicts with a newer value. Keeping the draft must preserve unrelated newer fields. The hours form uses the same merge rule.
- Add a minimal private restaurant-name snapshot and nullable place reference to each journal entry. A hidden or deleted listing must leave the person's memory readable. Operators and cleanup roles receive no private-journal SELECT grant. Journal records and snapshots cascade with account deletion.
- Represent structured hours as a bounded timezone plus seven Sunday-first lists of minute periods and date exceptions. An end minute beyond 1440 represents overnight service. A date exception overrides the entire local date, including carry-in service. Unknown schedules remain explicit. Use restaurant wall time across DST, and validate overlap across day boundaries. Retain legacy hour strings in existing DTOs.
- Open-now search evaluates a server-issued as-of instant. Return that instant with the page, carry it on later pages, and reject expired or future anchors. The ordinary directory and dining suggestions share the eligibility predicate. Private journal contents never enter search or provider inputs.
- F07 will bound all interactive work through request contexts, including authentication and database lock waits. Upload and streaming requests get separate longer budgets. Shutdown cancels outstanding request work. No transaction-pool session configuration will leak across requests.
- F09 needs a concrete resource bound. Default to one simultaneous media normalization per instance, expose a bounded configuration setting, and correct EXIF orientation before re-encoding. Container/codec checks remain the documented supported-video contract. Native playback and a full video processing pipeline retain their separate release evidence.

### Additional findings from the main-session review

**F11 — Private ownership must survive directory visibility changes.** A journal endpoint that reuses the public place reader would erase access to a memory when its listing becomes hidden. Use a private projection with the user's name snapshot and an unavailable marker, with no hidden review, media, or listing details. Check cross-account access and hidden/deleted listings through the authenticated endpoint.

**F12 — Availability must stay consistent through paging and sample persistence.** A new filter evaluated with a different clock per page can skip or repeat entries near closing time. Carry a bounded as-of value through both service implementations and migrate old local sample records with an explicit schema version. Do not synthesize historic visit dates or authoritative schedules from legacy review timestamps or prose hours.

**F13 — Optional AI must respect negative preferences.** The current keyword selector can map an excluded cuisine into a positive filter. Detect negation locally before building the allowlisted provider input, retain editable filters, and return a clear ambiguity message when the request cannot be represented. The model receives no private notes or raw prompt.

The immediate phase remains the five deliverables above. The expanded decisions refine the implementation and acceptance criteria within that scope.

## Phase 3 implementation record

The main session implemented the five immediate deliverables after reviewing and expanding this handoff. Private memory is the default in Log a visit. Public review is an explicit selection with a deliberate public score and text. Saved includes a virtualized Journal, and restaurant pages link to personal visit history. Entries support repeated visits, optional private scores, revision-protected editing, deletion, and recovery after an ambiguous create. Text entered during a pending save remains available for the next save. A memory opens the public composer through an explicit action.

Migration 006 introduces person-owned private visits with a restaurant-name snapshot, nullable place reference, request identity, calendar date, revision, and timestamps. It also adds structured schedules, generic report evidence, and audit actor fields. Existing restaurant IDs, public reviews, ratings, ranks, and revisions survive the populated 005 upgrade. Hidden or deleted listings retain a minimal unavailable marker in their owner's journal. The operator and cleanup roles have no journal read grant.

Owners can edit seven days of split or overnight service, an explicit timezone, and date exceptions, then preview the diner result before publishing. Restaurant pages expose supplied weekly and date-specific hours. Explore and dining suggestions share the open-now predicate. Pages carry a bounded as-of instant, and the client refreshes an expired opening-hours page. Sample storage has a versioned migration and shares the hours contract fixtures with the connected implementation.

| Finding | Implemented response and observed verification |
| --- | --- |
| F01 | Every report target preserves versioned evidence. Duplicate reports return an explicit conflict. Report-scoped review/listing decisions reject a changed version. Tests cover review, response, profile, listing, and comment evidence, edits and deletion, new reports of changed content, and author-deletion cascades. |
| F02 | Public review edits and deletion require the loaded revision. The composer preserves stale drafts and presents current content. An already-committed identical edit can recover its result. API and browser regressions passed. |
| F03 | Dish selection applies full distance and visibility eligibility before choosing one source per restaurant. The review-row cap was removed. API fixtures passed with 301 newer distant matches and a popular restaurant containing many matching reviews. |
| F04 | Comment submission retains its operation identity across response loss, preserves later typing, and clears a definitive rejected operation so the person can correct it. Journal submission uses the same preservation principle. Delayed-response and retry browser regressions passed. |
| F05 | Listing recovery displays current field values and merges deliberately changed draft fields with unrelated current changes. The browser preserved a newer phone number while applying an hours draft, then published structured hours successfully. |
| F06 | Manager events carry the authenticated actor ID. Production moderation requires a controlled operator principal identifier. Tests verify operator attribution and actual restricted-role operations. Actor links clear with account deletion, and audit retention remains 365 days. |
| F07 | Interactive request contexts include authentication and database waits, with longer upload and streaming budgets. Server shutdown cancels request contexts. A held-lock endpoint returned within its budget and the pool served a later request successfully. |
| F08 | Added independently seeded journal, report, hours, IAM, and transaction tests. Three place-lock barrier cases cover approval/publication, revocation/reply, and revocation/listing. Ordinary API/CLI functions ran under restricted roles. Core DTO checks reject malformed nested data. Pure provider protocol tests run independently of Postgres. |
| F09 | JPEG normalization preserves EXIF orientation, upload normalization defaults to one concurrent request, and a bounded configuration setting is available. The 12MP rotated fixture passed. Full video renditions, common-device codecs, and complete video metadata verification remain release work. |
| F10 | Restaurant reviews, owner inbox, comparison choices, and the new journal use virtualized lists. Review labels include dish/text context and clip controls have a 44-point minimum. Native screen-reader and large-text checks remain device work. |
| F11–F13 | Private memories survive listing visibility/deletion, opening-hours pages retain a shared clock, old sample records migrate, and negative dining preferences return editable clarification with local handling. |

### Verification evidence

- Frozen offline install passed. TypeScript with unused-local checking and the shared client contract suite passed.
- Expo exported the final iOS, Android, and web bundles. These artifacts establish bundle compatibility.
- Go vet, the required Postgres suite, Go race checks, and a Linux amd64 cross-build passed. A focused populated 005-to-006 upgrade also passed, retaining public scores, personal ranking, existing revisions, legacy report state, and zero fabricated visits.
- The sample browser flow passed at a 393-by-852 viewport with reduced motion. It exercised saved places, editable dining suggestions, source navigation, manual clip playback, deliberate public photo review, comparison, private journal editing, owner schedule preview, explicit response publication, and persistence.
- The final connected browser flow passed against a fresh local Go/Postgres fixture with private temporary media. It exercised verified email signup, private photo rendering, revision-scoped publication, stale public-review recovery, typing during delayed comment and private-visit submissions, retry after a committed comment response was lost, journal editing and reload, verified claims, listing conflict merge, supplied-hours preview, open-now search, offline logout, and password login.
- A connected run identified a JSON-null schedule write failure. The server now maps an explicit empty schedule to SQL NULL, and a focused regression passed. The final test harness uses the running fixture server's mail log and waits for complete log records without printing verification codes.
- Dining and owner-response provider fixtures passed structured-output, privacy, consent-off, unsupported-result, timeout, and cooldown cases. The owner fixture established zero automatic response publications.
- With 10,000 synthetic restaurants and 10,000 reviews in a rolled-back transaction, the actual directory query took approximately 6.9 ms for name search, 5.7 ms for dish search, and 177 ms for nearby/open-now search in single local runs. Separate skewed API fixtures exercised popular and remote dish matches.
- The isolated valid 12MP orientation test reported 201 MiB of total allocation and a macOS peak memory footprint of 150,700,824 bytes, approximately 143.7 MiB. This measures one local process and fixture. Cloud Run concurrent-load memory still needs deployment evidence.

The fixture diagnostics briefly encountered an automatic approval-review usage limit. After the session resumed, the authorized checks completed. A later fixture failure came from selecting a previous API's mail log. The final connected run used the correct log and completed successfully.

## Open dependency finding F14

The final production-dependency audit reports one high-severity picomatch advisory, GHSA-fc5q-39xc-vjpf. The installed 4.0.7 release remains the registry's latest release at the final check on 17 November 2026, and the advisory lists no patched version. The reported paths traverse Expo CLI/config plugins and tinyglobby. The Cloud Run Dockerfile builds and ships the Go executable. Preserve the audit finding in the release assessment and update the affected tooling when an upstream remediation is available. [GitHub advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

The dependency audit remains a failing check. The local feature implementation and the verification above are recorded independently of that open upstream finding.

## Remaining release evidence and next development

Live Neon pooling, Cloud Run identities and resource behavior, private GCS lifecycle and ranges, real Google OAuth and SMTP, paid provider configuration, native installation, Maps, permissions, VoiceOver/TalkBack, device video compatibility, and store-sign-in requirements retain the deployment and device checks described above. Cloud credentials and device results have not been inferred from local fixtures.

The next feature sequence remains named planning lists with explicit sharing controls, listing provenance and corrections, journal search and richer taste signals, accessible processed clips, and verified owner teams. Each should build on the canonical restaurant identity, person-scoped journal, revision contracts, and existing provider boundaries. The phase 3 immediate implementation is complete, with F14 and the live release evidence still open.
