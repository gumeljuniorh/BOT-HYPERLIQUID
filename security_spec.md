# Security Specification for Trade Logging System

## Data Invariants
1. A trade must belong to the system's authorized workspace.
2. Only authenticated system admins (identified by email or specific UID) can write to `trades`.
3. Trades are append-only. No updates allowed once a trade is closed/finalized (logic enforced by rules).
4. `analytics` data can only be updated by the system account.

## The Dirty Dozen Payloads (Rejection Tests)
1. Unauthenticated write to `/trades/test`.
2. Spoofed `ownerId` in a trade document.
3. Overwriting an existing trade document.
4. Setting a future `timestamp`.
5. Modifying `grossPnl` after the trade is closed.
6. Deleting a trade record.
7. Writing to `/analytics/global` as a standard user.
8. Injecting a 1MB string into `symbol`.
9. Negative `notional` value.
10. `side` value outside of `LONG` or `SHORT`.
11. Missing `required` fields like `symbol`.
12. Updating `createdAt` field on a second write.

## Test Runner (Logic Overview)
The `firestore.rules` will enforce:
- `allow create: if isSignedIn() && isValidTrade(incoming())`
- `allow update: if false` (Append-only)
- `allow delete: if false`
- `allow read: if isSignedIn()`
