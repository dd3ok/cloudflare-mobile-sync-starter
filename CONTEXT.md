# Cloudflare Mobile Sync

Cloudflare Mobile Sync is a reusable, self-hosted authentication and incremental-sync platform for
local-first applications. Its public source and each running product deployment are distinct things.

## Language

**Platform Source**:
The reusable Cloudflare Mobile Sync project published for adopters and contributors. It is not a
running backend or a public data service.
_Avoid_: Shared backend, global service

**Host Application**:
A product application that integrates with Cloudflare Mobile Sync while retaining ownership of its
product behavior and local data.
_Avoid_: Tenant, platform app

**Deployment Instance**:
An independently operated installation for exactly one Host Application and one deployment
environment. Accounts and application data do not cross Deployment Instances.
_Avoid_: Tenant, shared instance

**Product Account**:
A user's account inside one Deployment Instance. Use of the same identity provider in another Host
Application does not make the two Product Accounts the same account.
_Avoid_: Studio account, global account

**Identity Proof**:
Short-lived evidence from an identity provider used to establish or recover a Product Account
session. It is not the Product Account itself.
_Avoid_: Account, user profile

**Sync Record**:
Opaque Host Application data synchronized for one Product Account under an explicitly allowed
collection.
_Avoid_: User profile, platform document

**Adopter**:
A developer or organization that operates its own Deployment Instance and owns the resulting
provider, privacy, security, and support obligations.
_Avoid_: Customer, tenant

**Maintainer Deployment**:
A Deployment Instance operated by the Platform Source maintainers for one of their own Host
Applications. It is not a public sandbox.
_Avoid_: Demo server, shared production

**Hosted Service**:
A multi-customer runtime operated on behalf of adopters. Cloudflare Mobile Sync does not currently
offer one.
_Avoid_: Platform Source, Maintainer Deployment
