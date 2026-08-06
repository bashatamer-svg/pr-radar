-- Migration: the forgot-password queue — one timestamp on pr_users.
--
-- WHY: "Forgot password?" on the sign-in screen printed advice and sent nothing
-- ("an admin can reset it from Admin → Users"). So a locked-out person had to
-- know WHICH admin to chase and chase them out of band, and the admin never
-- learned anyone was waiting. There is deliberately no self-service reset link:
-- that needs an emailed token, and expiry / single-use / leaking via Referer are
-- a security surface not worth owning for a team this size. Instead the request
-- reaches the admin two ways at once — an email now, and a row in
-- Admin → Requests that stays visible until it is dealt with.
--
-- WHAT: one nullable timestamptz. NULL (the default) means "nothing outstanding";
-- a timestamp means this person asked, and WHEN — the queue is ordered oldest
-- first, because whoever has been locked out longest is the one to serve next.
--
-- It is cleared automatically by every path that sets a password (the admin's
-- "Reset password", a self-service change at /account, and a first-password
-- signup), so the queue empties itself rather than needing a second "mark done"
-- click. Admin → Requests also carries an explicit Dismiss for a request that
-- should not be actioned; that clears the same field and changes no password.
--
-- SAFETY: additive and idempotent. Nullable with no default, so it rewrites no
-- rows and locks nothing meaningfully — `add column` on a nullable column with
-- no default is a catalogue-only change in Postgres 11+.
--
-- The application code does NOT require this migration: lib/db.js asks for the
-- column and falls back without it (listUsers), and every reset helper returns
-- false / [] / null on failure. Until this is applied, "Forgot password?"
-- answers the user normally, records nothing, and the queue reads empty — the
-- feature is absent, never broken. Deploy first, migrate after.
--
-- Shared-project note: pr_* tables ONLY. The radar_* tables in this project
-- belong to a different application and are not touched here. (That app has its
-- own radar_users.reset_requested_at; same idea, separate table, separate
-- credentials — a person's PR Radar password is independent of their
-- Regulatory Radar one.)

alter table pr_users add column if not exists reset_requested_at timestamptz;

-- Partial index: the queue only ever asks for the handful of rows that are NOT
-- null, so indexing just those keeps it tiny (usually zero pages).
create index if not exists pr_users_reset_requested_idx
  on pr_users (reset_requested_at)
  where reset_requested_at is not null;

comment on column pr_users.reset_requested_at is
  'Set when the person taps "Forgot password?" on the sign-in screen; cleared automatically whenever a password is set. NULL = nothing outstanding.';
