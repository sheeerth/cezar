# Execution plan: `POST /runs` validates the contract's `createRunInputSchema`

Source doc: .ai/specs/2026-10-06-cez-mcp.md (Phase 1 — ships as its own PR; spec PR sheeerth/cezar#6)

## Goal

Delete the route-local `startRunSchema` in `server.ts` and validate `POST /runs` with `createRunInputSchema` from `@open-mercato/cezar-contract`, so the request shape a client (and the upcoming `cez mcp` `start_run` tool) compiles against is the one the route enforces.

## Scope

- `packages/cezar/src/server/server.ts`: route validator swap, `startRunSchema` removed, comment at the `planSchema` bound updated, now-unused `dispatchIntentSchema` import dropped.
- `packages/cezar/src/server/request-validation.test.ts`: a table of bodies judged by the contract schema; the route must agree (400 exactly when the schema refuses).

Non-goals: any other route's local schema (`messageSchema`, `continueSchema`); behavior changes of `POST /runs`.

## Risks

- The two schemas were field-identical (runner ids, bounds, XOR, attachment and dispatch schemas imported from the contract already; step schemas equivalent per upstream #1109 review). Guarded by the new table, proven red against a deliberately narrowed route schema.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: contract de-dup for POST /runs

- [x] 1.1 Swap the validator to createRunInputSchema and pin agreement with a test — 5c5cf5a3
