# Open Architectural Decisions & Notes

This document records architectural notes and potential future decisions that require explicit review during implementation phases.

## 1. Open Decisions

### OD-01: QR Token Expiry Policy
- **Question**: Should QR tokens generated for orders and customers have a rolling expiration time or remain valid until explicit revocation/completion?
- **Why it matters**: Affects security and offline scanning longevity.
- **Current Approach**: Tokens are generated cryptographically random and stored securely with status tracking.

### OD-02: Multi-Currency Support Extension
- **Question**: Although the system currently operates primarily in NIS (₪) with integer minor units, should the database support multi-currency exchange rate snapshots in future iterations?
- **Why it matters**: Financial ledger design.
- **Current Approach**: Stored strictly in minor units (`_minor`) with single currency assumption for current business scope.
