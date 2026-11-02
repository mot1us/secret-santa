# Changelog

## 0.10.5

- Add year-specific, one-way extra exclusions in Rules alongside existing partner restrictions. Adding or removing a rule clears only the unfinalized draft; saved wish lists, invitations, partners and history are preserved.
- Apply saved exclusions to hidden matchmaking checks, drafts and final validation. Keep finalized draws locked, avoid clearing drafts for duplicate rules, and allow checking restrictions without revealing pairings.

## 0.10.4

- Add a reviewed Resend invitation action for one person, including lost or expired invitations. Each resend issues a fresh 48-hour link, preserves saved wish lists and prior delivery records, and sends only the selected message.
- Make corrected sent addresses eligible for the invitation picker again. Retire access issued to the previous address, preserve drafts for contact-only edits, and guard stale reviews, duplicate requests, in-flight sends and uncertain deliveries.

## 0.10.3

- Keep past years inside History and block matchmaking tests for historical exchanges. Reviewing or editing past pairings preserves the active draw year.
- Show the draw year and the two checked history years beside tests, with direct review actions for missing or unconfirmed records. Add explicit historical review and confirmation dialogs, preserve confirmed status when editing, and reject confirmation of incomplete recorded rosters.

## 0.10.2

- Give invitations, sign-ins, correction requests, and matches exchange-specific subjects and clear context. Use a recognizable default sender name while preserving the approved mailbox and custom identities.
- Render lightweight HTML letters with working visible links alongside plain text, escape member content, and identify automatic messages. Preserve access tokens, delivery records, and reviewed retry handling; no SMTP or Compose configuration change is required.

## 0.10.1

- Add optional named results for every validated matchmaking test draw, with a draw selector and hide action. Keep normal diagnostics private and preserve real draws, wish lists, history, and email records.

## 0.10.0

- Add yearly partner selection that blocks both matching directions, carries forward with the roster, and invalidates stale drafts.
- Add a reviewed current-year test reset with typed confirmation: clear private test lists, draft matches, invitation status, and old access while preserving people, partners, settings, past draws, and exact archived delivery records. Protect finalized exchanges and in-flight or uncertain mail.
- Open replacement invitation links correctly in an already-open family tab, clearing earlier form and reveal state.

## 0.9.1

- Simplify open exchanges to one gift given/received per person, no self-matches, and no repeat recipient from the previous two calendar years. Allow partners and mutual pairs, remove extra rule controls, and migrate open restrictions while preserving finalized draws and history.

## 0.9.0

- Add selected fresh test invitations, including members already invited or submitted, using unique single-use links and empty first-submission forms. Keep saved lists until their owner submits the replacement, preserve earlier delivery records, and protect uncertain deliveries and finalized exchanges.

## 0.8.1

- Let organizers select invitation recipients, including just themselves and a partner for testing, without completing everyone else's email details. Start with no recipients selected and preserve the roster, private submissions, and existing delivery safeguards.

## 0.8.0

- Carry the previous family roster into new years automatically and repair missing members in existing open exchanges once, preserving submitted lists and finalized history.
- Simplify People around adding members, reviewing invitation recipients, sending invitation-only batches, and seeing submitted/waiting status. Support leaving people out and including them again without deleting identities or history.
- Reuse saved people from Add person, keep past names in an optional field, and move invitation preparation out of the delivery-record view. Close old group entry links while preserving saved submissions, hidden wish lists, explicit reveals, and reviewed retry handling.

## 0.7.0

- Add a private organizer matching tester: check up to 100 temporary draws against the active roster, exclusions, and two-year history without saving or revealing pairings or sending mail.
- Bound testing time and request frequency; distinguish impossible rules from unfinished searches and flag unconfirmed history.
- Verify all 8,320 small-roster exclusion configurations against an independent exhaustive oracle, plus privacy and preservation of finalized draws and email records.

## 0.6.1

- Align dropdown arrows and control heights, enlarge tap targets, and stabilize disclosure and header layouts.
- Keep member and email actions visible in mobile cards, wrap dialog actions, and announce dialog titles and inline errors.
- Preserve the Christmas letter design, private organizer defaults, and submit/edit flow.

## 0.6.0

- Default to known-member invitations; keep group registration as an explicit organizer option.
- Make invitations single-use for 48 hours, retire legacy reusable links, limit sign-in email volume and submission writes, and bound container resources.
- Hide wish lists, messages, current matches, and email bodies from the organizer until explicitly revealed; show local validation checks and queue correction requests.
- Preserve saved submissions, participant identities, finalized draws, and successful delivery records.

## 0.5.1

- Remove decorative slogans and shorten participant instructions, keeping the letter-to-Santa design and animations.
- Serve responsive WebP artwork, load family artwork early, and cache fingerprinted images without caching private data.

## 0.5.0

- Give wish lists a Charlie Brown Christmas look, with new artwork, handwritten headings, snowy colors, and a letter to Santa.
- Animate sending, editing, gift ideas, match reveals, buttons, and dialogs; honor reduced-motion preferences.
- Keep artwork and the open-license display font on the app's own server.

## 0.4.2

- Promote checked releases to latest after published-image verification, keeping versioned images for rollback.
- Add an automatic-update Compose option and instructions for Ornament-only Dockhand schedules.

## 0.4.1

- Send a first wish list to Santa, show a clear confirmation, and keep Edit wish list with Save changes for later updates.

## 0.4.0

- Redesign family wish lists as vintage Christmas cards, with a finished saved view and explicit edit/cancel actions.
- Add gift ideas one at a time, simplify the optional note, and improve mobile layouts and inline errors.
- Clarify pending organizer review and verify a complete exchange through result delivery and private edits.

## 0.3.0

- Collect names, emails, wish lists, messages, and product links through one private group link, without a sign-in email.
- Review submissions against existing identities before drawing; keep each saved form private to its browser.
- Include the recipient’s message and gift ideas in match emails; preserve existing links, draws, and email records.

## 0.2.0

- Share one group URL; participants request an email sign-in link from the homepage.
- Keep sign-in links single-use and valid for 15 minutes, with request limits and private sessions.
- Preview sign-in emails during setup and send requested links separately from organizer email batches.
- Preserve existing personal links, family data, and finalized matches.

## 0.1.5

- Rename Docker services to `ornament` and `ornament-backup`, with routing to
  `ornament:3080`.
- Preserve existing data and backup volumes and document the stack upgrade.

## 0.1.4

- Publish checked Docker images for AMD64 and ARM64 to GitHub Container Registry.
- Deploy a pinned release through a regular Dockhand stack with private VPS volumes.
- Verify container startup and backups in CI; retain an optional local build override.

## 0.1.3

- Pass Dockhand settings and secrets into the app without requiring a local
  environment file in the Git checkout.
- Document deployment and updates through Dockhand with Pangolin routing.
- Keep Dockhand-generated environment files out of Git and Docker build context.
- Validate the Compose configuration in CI.

## 0.1.2

- Update VPS setup instructions for the renamed mot1us/ornament repository.
- Set private permissions on the VPS environment file during setup.

## 0.1.1

- Require a version bump and changelog entry for every completed update.
- Check that package versions agree and the current version has release notes.

## 0.1.0

- Build a self-hosted Secret Santa app with private links, wish lists, annual
  draws, two years of repeat avoidance, email previews, and SQLite backups.
- Refine the wish-list flow, add vintage Christmas artwork, and name the app
  Ornament.
