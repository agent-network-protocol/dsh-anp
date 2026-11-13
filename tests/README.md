# DSH ANP acceptance tests

System scenarios belong to `tests/system/`; real DSH + DeepSeek browser journeys belong to `tests/e2e/`.
The repository owns its runner, assertions and fixtures. These tests do not use
`awiki-system-test`, import sibling source modules, or change shared DSH profiles.

This suite is being implemented. `--list` distinguishes executable scenarios from
`not_implemented`. Selecting a missing case or running the incomplete full suite
returns a nonzero status; absence of tests is never a pass.

## Running

Use Node >=24.9, the current Harness CLI and the ordinary npm install prerequisites.
Run the following commands from `.`:

```sh
npm run test:acceptance-support
npm run test:system -- --list
npm run test:system -- --case ANP-S02
npm run test:e2e -- --list
```

`DSH_CLI` selects the built DSH CLI bin (default: the sibling independent Harness).
`AWIKI_IDENTITY_PACKAGE` selects an absolute identity-plugin candidate tarball or
an exact published identity-plugin version. When omitted, this repository uses
the exact published identity plugin `0.1.16`. Its actual installed version is
included in runtime evidence. The local identity source is a separate candidate
and is never substituted silently.
The subject candidate is built and packed into a protected temporary directory.

S01 records the subject tarball SHA-256, installed entry hashes, exact identity
version and npm integrity, plus the actual native platform package, binary path,
version and SHA-256. Native wrapper/platform versions must agree. The evidence
is a native node:test diagnostic on the current OS/architecture; it creates no
separate result archive and does not imply cross-platform acceptance.

Installation uses normal npm resolution with scripts disabled, preserving peer
dependency checks. A candidate/Host mismatch is a failure, not a reason to force
installation or change public version numbers.

The deterministic controller is a private fixture installed by the actual Loader.
Only its parent's IPC channel can request ordinary consumer or user manager actions.
It registers no model tools or network listener. This is system-test control,
not the browser actor required for E2E.

## Protected factors and fixed destinations

`AWIKI_TEST_FACTOR_FILE` selects the protected AWiki Me YAML (fields `otp.phone`
and `otp.code`) or an explicit dotenv (only `DEV_OTP_PHONE` and `DEV_OTP_CODE`).
The default is the existing `~/awiki-space/awiki-me/tests/e2e/configs/e2e.local.yaml`.
Files must be owned by the invoking user, have no group/other permissions, and
must not be symlinks. `AWIKI_E2E_OTP_PHONE` and `AWIKI_E2E_OTP_CODE` override
as a complete pair. Missing explicit input never falls back to another file.

Identity requests go to `https://awiki.me`. Discovery begins at
`https://agent-network-protocol.com`; discovered origins are checked by the
actual Host. Service URLs, DB configuration and unrelated credentials in the
factor file are never inherited. The configured phone, OTP, tokens and private
keys must not be printed, recorded in prompts, snapshots or command arguments.

## Planned coverage

All locations below are implemented. This table is not full-run acceptance;
focused results apply only to the version and assertions exercised by that run.

| Cases | Scenario | Location |
|---|---|---|
| ANP-S01, ANP-S02, ANP-S09 | Installation, discovery and restart | `system/discovery.test.mjs` |
| ANP-S08 | Foreign references, origin and redirect boundaries | `system/boundary.test.mjs` |
| ANP-S03 | Actual authenticated description/interface | `system/authenticated-read.test.mjs` |
| ANP-S04, ANP-S05 | Precise document and approved write/readback | `system/business.test.mjs` |
| ANP-S06 | Denial, timeout, cancellation, unload and actor failure | `system/consent.test.mjs` |
| ANP-S07 | Persistent rules, extra scope and revocation | `system/policy.test.mjs` |
| ANP-S10 | Lost receipt, query before cleanup | `system/lost-receipt.test.mjs` |
| ANP-E01, ANP-E02 | Actual model catalog/document reading | `e2e/read.spec.mjs` |
| ANP-E03 | Actual model write with UI approval | `e2e/post.spec.mjs` |
| ANP-E04 | UI refusal without alternate-channel bypass | `e2e/denial.spec.mjs` |
| ANP-E05 | Actual restart, UI revocation and restore | `e2e/restart.spec.mjs` |

E05 accepts the two authenticated catalog paths advertised by the actual service:
`anp_read` of the discovered `/anp/catalog.json` information reference, or
`anp_call` of `/anp/api/protocols`. Both require a successful real tool result,
the expected Agent origin, and nonempty version/document arrays. This lifecycle
case verifies the directory outcome rather than prescribing one tool choice;
re-discovery, real restart, user UI revocation/restoration and zero denied sends
remain required. Native diagnostics record the selected tool/path for each
successful phase without recording credentials or document content.

## Evidence boundary

ANP-S08 supplements the original insecure-target/fabricated-reference assertions
with a reference minted by another real Host from the other discovery origin.
Explicit one-shot HTTPS response faults add an unapproved description link and
return redirects for one signed read and one anonymous discovery. The production
signer and actual remote requests remain in use. Faults must report applied;
requests to the fixed reserved forbidden origin must remain zero. These are
negative injected scenarios, not naturally occurring remote redirects.

ANP-S04 also checks missing parameters before sending and sends real read requests
with an unknown version, document and language. The latter fail according to the
ANP adapter's actual HTTP-error contract, with no write requests.
S04 and E02 compare the received Markdown SHA-256 with a separate read-only SSH
observation of the running Service Agent's deployed public catalog. The oracle
accepts only version/language/document selectors, binds its fixed catalog to the
active service release and returns metadata/hash only. It never receives an
arbitrary file path, API receipt, model answer or credential.
After an observed full-run setup failure, S04/S08 enable a bounded passive
request/response/error observer for the public directory, description and OpenAPI
paths. Unexpected failures include only method/host/path, actual call ID, HTTP
status and a fixed-format Node error code. Query values, headers, credentials,
body bytes and raw exception messages are excluded. This instrumentation does
not replace transport/signing or relax a failed assertion. Its new focused
verification is tracked separately from the original full-run failures. The two
authenticated cases have passed the new focused checks; the initial generic
failures were not reproduced and their cause remains unproven.

Unit/fixture checks are separate from installed-Host system evidence and real-model
E2E evidence. The local custody scenarios do not claim remote registration or publication.
Each runtime has a private temporary DSH home and state. Restart tests stop and
reopen the same state with a new process. Teardown waits for the actual child to
exit before removing owned files; failure does not authorize killing other processes.

Live registration and writes require an exact cleanup route before creation.
Uncertain writes are queried, never replayed. Do not bulk-delete identities by phone.
Preserve only necessary private recovery input if cleanup remains unresolved.
The protected `post-recovery.json` contains `scope`, `quotaBaseline` and
write-count observations. Pass only `scope` to the exact operator; keep the
baseline for restoration checks. A business-recovery error includes a safe
cleanup-stage code. Remove this input after restoration, never archive it.

If the actor fails, owned-post teardown first drains and stops the actual Host
before locating or deleting remote objects. An unconfirmed stop preserves recovery
input. S06's runner-error branch verifies cancellation across restart and rejection
of late approval. Native diagnostics bind the branch and actual tool call ID to
the fixed POST method/origin/path and observed send count; model traces also carry
the real DSH tool call IDs. Credentials and signed headers are never included.

Use native runner output and concise failure diagnostics. Do not create
`verification-runs/`, replacement archives or execution indexes. Full acceptance
receives a concise final HTML report according to workspace rules after all
implementation is complete; focused checks are reported directly.
