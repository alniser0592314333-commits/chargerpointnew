# Authentication & Authorization Architecture (`docs/auth-and-authorization.md`)

## 1. Authentication & Identity
- **Supabase Auth Integration**: `auth.users.id` is linked directly to `admins.auth_user_id`. Clients cannot spoof actor IDs; the server resolves the authenticated admin context from the secure session.
- **Admin Model**: Tracks `id`, `auth_user_id`, `username`, `email`, hashed BIN credentials (`bin_hash`), active status, role, and version.

## 2. Super Admin & Privileges
- **Single Super Admin**: Enforced strictly via database constraints and server triggers.
- **Regular Admins**: Cannot create or promote admins or escalate privileges.
- **Effective Permissions**: Calculated via `Role Permissions + Explicit Custom Grants - Explicit Custom Denials`.

## 3. BIN Security & Credentials
- **Hashed BIN**: BIN credentials are securely hashed (never stored in plaintext, logs, audit trails, or outbox).
- **Sensitive Operations**: Require valid BIN authorization.
