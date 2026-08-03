-- Migration: WhatsApp number on a subscriber, so the crisis list is managed in
-- the app instead of an environment variable.
--
-- WHY: urgent WhatsApp recipients lived only in WHATSAPP_TO, a Vercel env var.
-- Adding or removing one person meant a dashboard edit AND a redeploy, and only
-- someone with Vercel access could do it — so in practice the list never
-- changed. On 3 Aug it held exactly ONE number while the daily brief went to
-- five people: the channel added for speed reached the fewest readers, and
-- nothing on any screen said so. Admin → Subscribers already manages the email
-- list self-serve; this puts the phone beside it.
--
-- WHAT: one nullable text column. NULL (never '') means "no WhatsApp for this
-- person" — the same convention pr_items.author uses for "no byline", so the
-- absence is unambiguous rather than an empty string that reads as a value.
-- Digits only, E.164 without the leading '+', e.g. 201001234567; lib/whatsapp.js
-- strips non-digits anyway, so a pasted "+20 100 123 4567" still works.
--
-- The `active` flag governs BOTH channels: someone switched off stops getting
-- the daily brief and stops being paged. One switch, no surprises.
--
-- SHARED-PROJECT SAFETY: this Supabase project also hosts another app's
-- `radar_*` tables. This alters only `pr_subscribers`; nothing here reads,
-- alters or drops a `radar_*` object.
--
-- SAFETY: additive and nullable, so every existing row stays valid and the
-- current code (which never selects this column) is unaffected. WHATSAPP_TO
-- keeps working as a fallback for as long as it is set, so applying this
-- changes nothing until numbers are actually entered in Admin.
-- Rollback: `alter table pr_subscribers drop column whatsapp;`
--
-- Apply with the Supabase SQL editor or psql. Idempotent.

alter table pr_subscribers add column if not exists whatsapp text;

comment on column pr_subscribers.whatsapp is
  'E.164 digits, no +. NULL = this person gets no WhatsApp alerts. Gated by active.';
