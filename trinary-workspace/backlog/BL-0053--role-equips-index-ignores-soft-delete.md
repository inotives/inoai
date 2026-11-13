---
id: BL-0053
title: role_equips open-row index ignores soft deletion
type: idea
status: open
created_at: 2026-11-13T09:26:00Z
source: IP-0008 T-0002 reviewer handoff
promoted_to: null
---

# BL-0053: role_equips open-row index ignores soft deletion

## Description

`getEquippedRole` filters `deleted_at IS NULL`, but the partial unique index `one_equipped_role` covers only `unequipped_at IS NULL`. A soft-deleted row that is still open would be invisible to `getEquippedRole`, yet it would block every new equip with a UNIQUE error. Nothing soft-deletes `role_equips` rows today, so this is latent. If a later feature adds soft deletion, either add `AND deleted_at IS NULL` to the index (which needs an index rebuild migration) or close the row when it is deleted.

## Context and evidence

- [T-0002 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0002--role-equip-persistence/handoffs/20261113_092515--reviewer-handoff-1.md), Follow-ups.

## Discussion

- None yet.

## Open questions

- None
