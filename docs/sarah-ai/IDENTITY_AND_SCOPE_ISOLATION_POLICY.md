# Sarah — Identity, Tenant, and Capability Isolation (Security Foundation)

**Normative security policy for all future Sarah integrations**  
**Scope:** Admin, customer portal, wallet modules, any future staff roles, and device/account switching.

## Non-negotiable rule
Sarah is not an identity and has no independent privileges. At each request, she operates strictly as a delegated assistant within the authenticated actor's current tenant/account, identity, role, permission set, and resource ownership scope. She cannot elevate privileges, impersonate another user, or broaden scope through prompt instructions, chat history, retrieved content, tools, provider responses, cached state, device state, or UI navigation.

## Required execution model
- Resolve identity and session from trusted authentication state (server-side token validation), never from model-supplied actor IDs, role names, customer codes, permissions, or transcript.
- Resolve the current actor on every tool invocation and fail closed if session/account binding is missing, stale, revoked, or inconsistent.
- Effective authorization must be enforced by the trusted backend/domain use case, not by UI hiding, client filters, prompt rules, or a tool catalog alone.
- Bind every operation to an immutable authenticated actor ID and active tenant/account ID. Never accept a different actor or tenant from tool arguments.
- Re-check permissions and ownership at execution time, including resource-level permissions, and apply existing BIN/approval requirements where applicable.
- Admins are isolated: an admin's permissions cannot inherit another admin's permission set. SUPER_ADMIN privileges apply only when the authenticated identity is actually verified as SUPER_ADMIN by authoritative backend policy.
- Customer assistant mode is strictly self-scope: derive customer identity from the authenticated customer session; do not accept customer ID, name, phone, or account ID as a scope override. Access only that customer's own records and allowed aggregates. No searching other customers, listing, administrative reports, staff settings, finance administration, or mutation tools.
- For customer queries such as “what do I owe?”, “what did I charge?”, “how much per day?”, and date-specific history, expose only server-calculated summaries for the session-owned customer and approved date ranges.
- Separate capability catalogs by actor class (admin vs customer vs staff) and permission; default-deny. Customer catalog must never include admin tools. Admin catalog must never be automatically reused in customer mode.
- Permission-denied requests must not fall back to broader queries or alternate APIs; return a safe denial. No direct database access or generated SQL.
- Every read response must be minimized, bounded by record count and serialized size, and exclude fields unnecessary for the request. Provider prompts/context are untrusted and may not carry secrets.
- Queue, transcript, audio, cached tool results, pending actions, and execution receipts must be identity-bound and segregated; clear or isolate state on account switching. Do not replay queued operations under another account.
- Any mutation later requires permission validation, resource scope validation, confirmation for sensitive actions, idempotency, domain validation, and canonical application transaction/outbox execution. Provider response alone is not execution proof.

## Threat cases required in tests
1. Admin A cannot obtain Admin B's permissions by switching UI/account, injecting actor IDs, reusing conversation IDs, or queue records.
2. Non-super-admin cannot acquire SUPER_ADMIN privileges by changing role/permissions client-side.
3. Customer A cannot request Customer B's records by supplying B's ID, code, phone, or query.
4. Customer mode cannot invoke admin-only tools, finance admin summaries, settings, or mutation functions.
5. Cross-account transcript/queue/result cache isolation on account switch, logout, expired session, and reconnect.
6. Permission revocation mid-session blocks the next tool invocation.
7. Resource IDs, search results, tool arguments, and prompt/history injection do not alter authorization scope.
8. Missing identity, stale token, inconsistent session, unavailable permission source, or ambiguous ownership fails closed.
9. Limits and privacy tests: no bulk listing, no overlong histories, unnecessary phone/ledger notes excluded.
10. Offline pending items remain bound to the originating actor; no automatic execution until online authorization is revalidated.

## Implementation gate
This policy is architecture/specification, not a claim that customer assistant mode or tool isolation has been implemented. Each tool must have backend-enforced authorization and tests before release.