# Security Boundary Reference (`docs/security-boundary.md`)

## 1. Trusted Zone (Server-Side)
- Supabase Auth identity context
- Server-side database state & transactions
- Effective permission calculation
- BIN hash verification
- Financial serialization & ledger authority

## 2. Untrusted Zone (Client-Side)
- Client payloads and timestamps
- Client-provided actor IDs, roles, and permissions
- Client balances and local offline state
- Device identifiers (when unverified)
