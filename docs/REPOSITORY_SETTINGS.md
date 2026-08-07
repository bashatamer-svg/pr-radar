# Repository settings an owner must enable

`.github/workflows/ci.yml` makes the suite RUN on every pull request. It does
not make it MATTER — nothing in a repository forces a check to pass, or forces a
change through a pull request at all, unless branch protection says so. Those
settings live in GitHub, not in this repo, and cannot be committed.

This file is the exact list. It is short on purpose: each entry names a failure
that has actually happened here, or that the current workflow makes possible.

> **Status: NOT VERIFIED.** Nobody has confirmed these are on. Do not read this
> file as a description of the current configuration — it is a request. Tick
> them off below when they are set, so the next reader knows.

## Why this matters more here than in most repositories

`main` deploys straight to production. There is no staging environment, no
manual promotion, and real users are on the live board. Until protection is on,
`git push origin main` is a production deploy with no review and no test run.

## Settings — Branches → Add branch ruleset (or classic protection) for `main`

| Setting | Value | Why |
|---|---|---|
| Require a pull request before merging | **On** | The whole release gate hangs off this. Without it every other setting here is optional. |
| Required approvals | **0 is acceptable** | A single-maintainer project should not pretend otherwise. Set 1 if a second reviewer genuinely exists — an approval requirement nobody can satisfy gets bypassed, and then bypassing becomes normal. |
| Dismiss stale approvals on new commits | **On** *(only if approvals ≥ 1)* | An approval is of a diff, not of a branch. |
| Require status checks to pass | **On** | |
| → required checks | **`test`**, **`audit`** | The job names in `ci.yml`. They only become selectable in the UI after the workflow has run once, so merge this branch first, then come back. |
| Require branches to be up to date before merging | **On** | Two changes that each pass alone can fail together. This is how the merged tree gets tested rather than two branches that were never combined. |
| Require conversation resolution | **On** | Cheap; stops a review comment being merged past. |
| Block force pushes | **On** | `main` is the deploy source. A force push rewrites what production is built from, and the previous commit becomes unfindable. |
| Restrict deletions | **On** | |
| Require linear history | Optional | Only if you prefer rebases. Nothing here depends on it. |
| Allow specified actors to bypass | **Leave empty** | See below. |
| Include administrators / "Do not allow bypassing" | **On** | The point. |

### The administrator-bypass decision, made explicitly

Turning **on** "do not allow bypassing" means the repository owner also has to
open a pull request to change `main`. That is mildly annoying for a one-line
fix and it is still the right setting, because the failure it prevents has
already happened in this project: a commit reached `main`, the Vercel webhook
missed it, and the live site sat on the previous commit while `git ls-remote`
showed the new SHA. Every incident of that shape starts with a change that
nobody looked at twice.

If it is turned off, that is a legitimate choice for a project this size — but
make it a choice. Write the date and the reason in the checklist below, and
accept that "protected" then means "protected from everyone except the one
person who pushes here".

## Also worth setting

| Where | Setting | Why |
|---|---|---|
| Settings → Actions → General | Workflow permissions: **Read repository contents** | `ci.yml` needs nothing more. The default write token is a standing credential this repo has no use for. |
| Settings → Code security | **Dependabot alerts**: On | Two runtime dependencies is still two supply chains, and `fast-xml-parser` parses hostile third-party XML. |
| Settings → Code security | **Dependabot security updates**: On | It opens a PR, CI runs, you review. That is the whole loop and it needs no attention until it fires. |
| Settings → Code security | **Secret scanning + push protection**: On | The repo handles a Supabase service-role key, `CRON_SECRET` and a Resend key. None belong in a commit; push protection stops the paste before it becomes history. |

## Checklist

Record what was actually done, with dates — an unticked line is more useful than
a wrong one.

- [ ] Ruleset created for `main`
- [ ] Require pull request — approvals: ____
- [ ] Required checks: `test`, `audit`
- [ ] Require branches up to date
- [ ] Block force pushes, restrict deletions
- [ ] Administrator bypass: **allowed / not allowed** (circle one) — decided by ______ on ____-__-__ because ______
- [ ] Actions workflow permissions set to read-only
- [ ] Dependabot alerts + security updates
- [ ] Secret scanning + push protection
