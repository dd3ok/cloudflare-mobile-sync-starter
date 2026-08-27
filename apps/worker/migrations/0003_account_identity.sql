PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX account_provider_identity_idx
ON account(providerId, accountId);
