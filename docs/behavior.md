# Data and delivery behavior

People have permanent random IDs, a display name, alternate names, and an email
address. Annual enrollments hold participation, wish lists, messages to gifters,
and gift ideas with product links.
The People page is the main invitation workflow: add or edit family members,
review the listed recipients, explicitly send their invitations, and see who has
submitted. A new year automatically carries the most recent earlier roster that
has members, including its participation choices; wish lists, messages, gift
links start fresh. On the first upgrade to this behavior,
missing prior-year members are added to existing open or drafted exchanges.
Existing annual content is not overwritten, and finalized or archived exchanges
are not changed. Adding members to an existing draft discards that stale draft.
The migration runs once, so later participation choices remain stable across
restarts.

Leave out removes a person from this year's active roster, keeps their identity
and private content, and cancels unsent invitation records. Include brings them
back. Finalized rosters remain locked. Add person can select a saved member or
recognize an existing name/alias before explicitly reusing their identity.

Send invitations lets the organizer choose recipients with checkboxes, initially
all unchecked. A test can include just one or two members; missing email
addresses or unfinished details for unselected people do not block sending.
People missing a valid email are shown but cannot be selected until corrected.
Sending requires a recipient review and confirmation. It only sends
invitation records for the reviewed active members who have not submitted and
have a new, pending, previewed, or cancelled invitation. The server rechecks the
reviewed IDs and email addresses. Successful, failed, or uncertain deliveries
are not automatically resent; delivery issues still require the existing
explicit retry workflow. A participant who has already submitted is not invited
again by this action. Assignment, correction, and sign-in messages are not sent
by this invitation-only action. Preview mode labels records as Preview only and
sends no email. SMTP success means the provider accepted the email.

Test invitations is a separate explicit action for open or drafted exchanges.
It can include already-invited or submitted active members, selected one by one.
Each dispatch has a new delivery record and a unique, email-bound, single-use
48-hour invitation. The link opens an empty first-submission form in a fresh-start
member session. Opening or reloading this form does not change the saved list,
participation, history, or previous successful email records. A valid submission
replaces only that member's current list, message, and gift ideas and returns to
the normal saved-list/edit flow. Normal sign-in continues to show the saved list.
Missing details for unselected people do not block a test. Pending test sends,
in-flight invitations, and uncertain deliveries must be resolved before another
test for that person. Finalized exchanges reject new fresh test invitations and
cannot be overwritten by previously issued fresh links or fresh-start sessions.
Old invitation links for the selected person are replaced, as with normal
invitation issuance. Test messages are delivered only for the reviewed batch;
assignment and other pending messages are untouched.

**Rules → Reset test data** prepares only the selected open/drafted exchange
for real invitations. The organizer reviews counts and types `RESET <year>`.
If the underlying lists, roster, draft, partner choices, or mail records changed,
the confirmation must be reviewed again. Reset clears wish lists, messages, gift
links, correction requests, legacy submissions, draft assignments, current
invitation status, and all family sessions/access tokens for that year. It closes
group registration. People, emails, aliases, participation choices, partner
pairs, settings, audit history, and other years are preserved. Finalized and
historical exchanges cannot be reset. Sending or uncertain messages block reset;
wait for delivery or review uncertain messages through Delivery first.

Earlier email records are archived unchanged in the private SQLite database,
including successful delivery records. They appear in the explicit private
export; old links in them stop working. Cleared wish lists have no in-app undo;
existing external backups follow their normal retention. No email is sent by
resetting. After reset, People shows Not invited / Not submitted, and the usual
reviewed invitation action can issue new unique links. Organizer sessions and
persistent sign-in rate limits remain intact.

Each year has independent settings and assignments. Everyone gives once and
receives once; nobody can draw themselves or a recipient they gave to in either
of the previous two calendar years. Under **Rules → Partners**, mark each couple
once to exclude both directions. A person can have one marked partner per year;
remove an existing pair before changing partners. Saving or removing a pair
invalidates a draft. The choices carry into new years alongside the roster and
remain saved when someone is left out. Unrelated mutual pairs are allowed.
Finalized or archived partner choices cannot change. Older finalized exchanges
retain their original restrictions.

For individual exceptions, use **Rules → Extra exclusions**. Choose the giver
and the person they must not draw, then select **Add exclusion**. Each rule is
one-way: the reverse direction remains allowed unless another rule blocks it.
Extra exclusions work alongside existing partners and the two-year history;
they do not consume or change either person's partner selection.

Extra exclusions apply only to the selected year and are not copied into a new
exchange. They survive restarts and explicit test-data resets. Adding or removing
a rule clears the current unfinalized draft, preserving wish lists, invitations,
partners and past matches. Re-adding an existing rule or removing an absent rule
does not discard a draft. Finalized or archived rules cannot be changed.

To check restrictions privately, leave **Show test pairings** unchecked under
**Draw → Test matchmaking**. The result includes **Saved exclusions respected**;
it does not reveal the generated pairs. Draft generation and finalization enforce
the same restrictions, and impossible rules are reported without relaxing them.

The latest two years' directed giver-to-recipient matches are excluded even if
their history is provisional. A draw can be drafted with incomplete history but
cannot be finalized until both preceding histories are verified.
For a new tradition, the organizer can explicitly confirm that no exchange
happened in a prior year. This counts as verified empty history; it cannot
replace an existing draw.

The randomized constraint search returns a valid draw or an explicit failure.
It checks self-matches, both directions of marked partnerships, and directed history. Saved extra restrictions on older
finalized exchanges remain supported for validating those records. It does not
claim to sample all possible valid draws uniformly. A
bounded search prevents a complex exchange from exhausting the server.

**Draw → Test matchmaking** checks up to 100 temporary draws using the selected
exchange's active participants and two preceding calendar years. Testing an
older finalized draw also honors its saved original restrictions. The response
contains counts and rule results only by default. Select **Show test pairings**
before testing to explicitly reveal the giver/recipient names for each validated
test draw. The Test draw selector browses those temporary results; Hide test
pairings removes them from the page and browser app state. Results are cleared
when organizer data or the selected year changes. A failed or unfinished test
only exposes draws that completed and passed validation; zero completed draws
show no pairings. Test pairings are separate from the saved draft/final draw,
which remains hidden. No wish lists, contact details, or email content are
included in test responses. It does not save a draft,
change a finalized draw, write database records, or prepare/send email.
Incomplete or provisional history is flagged because only recorded matches can
be checked. A passing test checks matching rules, not finalization readiness,
uniform randomness, or email delivery. Repeated valid draws may be identical
when restrictions leave few possibilities.

The organizer-only endpoint requires the normal origin and CSRF protections.
A test stops after 100 draws, about one second, or a 50,000-node per-draw search
limit. The time check occurs between search steps, so normal request overhead
can add a small amount of time. A limit result is inconclusive, not proof that
no draw exists. Five test requests per organizer session are allowed in fifteen
minutes. Normal draft generation retains its existing 500,000-node search limit.
The displayed result is cleared when organizer data is reloaded or changed.

Draft generation, history imports, and finalization use SQLite transactions.
Changing a roster, matching rule, or relevant history discards affected drafts.
Finalization revalidates the entire draw against the current roster and rules.
A finalized draw cannot be regenerated, and email retries do not change it.

Emails are persisted in an outbox before delivery. Each person/year/type has
one message record with a stable Message-ID. A successful SMTP acceptance is
recorded as `sent` and skipped on future batch runs. A definite SMTP rejection
is `failed`; an ambiguous connection failure is `uncertain`. A process restart
also converts an in-flight `sending` record to `uncertain`. The organizer must
check the mailbox before explicitly retrying an uncertain message.

On **People**, **Resend invitation** reviews one person's current email and sends
a new personal invitation, including when the earlier link was lost or expired.
The link lasts 48 hours from dispatch and replaces that person's previous
invitation; their saved wish list, message and gift ideas remain available.
Each resend has its own delivery record and Message-ID, preserving earlier
successful sends. Only the reviewed message is dispatched; other pending emails
are left queued. Replaying an old review cannot send another invitation.

Correcting a sent address also makes an unsubmitted person available in **Send
invitations** again. Saving an address never dispatches email. An actual address
change retires that person's earlier invitation/sign-in links and owner sessions,
and updates unsent messages for the selected year. Contact-only edits preserve
draft matches. Existing successful and uncertain delivery records stay intact;
uncertain delivery must be reviewed in Delivery before resending. Resends are
available while the exchange is open or drafted. Finalized records stay locked.

SMTP cannot guarantee exactly-once delivery: a server can accept a message
before the app learns it succeeded. The uncertainty workflow avoids automatic
duplicate sends but cannot rule out a duplicate after an incorrect manual
retry decision. `sent` means the provider accepted the message, not proof that
the recipient opened it or that it avoided spam.

Known-member invitations are the default. The organizer adds or reuses stable
participants and their email addresses, then explicitly prepares and dispatches
invitation emails. Each invitation is bound to the member's current address,
works once, and expires after 48 hours. Dispatch starts a fresh lifetime, including
an explicitly reviewed retry. Issuing a new invitation replaces that person's
previous invitation. A browser session lets them edit for 30 days; a fresh email
sign-in works on another device or after the session expires.

The standard People workflow uses invitations. The upgrade closes old group
registration links and group entry sessions, while keeping saved submissions
and their owner sessions. Pending owner submissions remain reviewable. The
underlying group API remains for compatibility; its controls are no longer
shown on People.
Group registration is closed by default. An organizer can explicitly enable it
for an open exchange; its random group link expires in 30 days. Anyone holding
that link can submit a pending form without proving email ownership. Review their
name/address and map it to a stable identity before approval. Closing registration
revokes group entry links and unsubmitted sessions while retaining saved owner
sessions. Upgrading from older releases closes group registration and retires
legacy reusable personal links. Submissions, identities, signed-in owners,
finalized draws, and successful delivery records are retained.

Organizer state contains identity/contact metadata and validation results, never
wish-list text, gifter notes, gift URLs, current draw pairings, or email bodies.
**Checks & options** reports local checks for a valid member email, a wish list or
gift idea, text/gift limits, and http(s) product URL format without credentials.
These checks do not contact product sites or an external AI, verify availability,
or judge whether a gift is appropriate. Bad submissions cannot overwrite a saved
list. Optional notes and links are not required. Finalization requires every
active list to pass and resolve any correction request.

**Request changes** saves the organizer's instruction and queues a separate email
for explicit sending. A valid participant resubmission clears the instruction and
cancels unsent correction emails. Successful or uncertain deliveries remain in
the record unchanged.
**Reveal wish list**, **Reveal matches**, and **Reveal preview** each require a
deliberate confirmation and fetch private content from a separate authenticated,
CSRF-protected endpoint. Reveals are recorded without their content in the audit
log. Reloading organizer state hides private content again. Historical pairings
remain visible when reviewing an archived year. Exporting private data is an
explicit action; exports and SQLite backups include wish lists and matches.
This is spoiler protection for an organizer who participates, not encryption
against the VPS administrator, who controls the database.

Invitation messages include the expiring invitation. Assignment messages link
to `/join`, which requests a fresh sign-in email rather than including a reusable
access credential. Assignment
emails contain the recipient's name, wish list, message to the gifter, and
product links as a snapshot taken when messages are prepared. The personal
page shows the recipient's latest saved content. Later edits do not change
already prepared messages. The SMTP provider and the recipient's mail provider
process these emails; their contents are not confined to the self-hosted database.

Organizer authentication uses a server-side session and scrypt password hash.
The email sign-in page at
`/join` sends a sign-in link only to a known, active participant in
the latest open, drafted, or finalized exchange. Responses do not disclose
whether an email is on the roster. Each person needs a separate email address.
Email sign-in tokens are random and hashed in SQLite, work once, and expire in
15 minutes. Requests are limited by IP and by email, with email limits surviving
restarts. Sign-in delivery never sends prepared invitation or assignment batches;
failed or uncertain links are not retried automatically. Request a new link.
New invitations can be revoked together with email sign-in links and sessions.
Legacy reusable links stop working after the upgrade; their owners can request
fresh sign-in emails. Sign-in emails are bounded by address/IP limits and a
persistent global budget of 20 per 15 minutes and 100 per rolling day. Submission
saves are limited to 30 per session per 15 minutes. Secure HttpOnly SameSite cookies,
CSRF tokens, origin checks, and a restrictive content security policy protect
browser requests. Family member API responses contain only the person's own
content and the name, wish list, message, and gift ideas of their recipient after
finalization. Group submission sessions expose only their own form, including
after the draw. Neither exposes a list of other family members, their email
addresses, or the incoming giver.

The organizer export includes people, rosters, matching settings, exclusions,
assignments, partner pairs, and email records archived by an explicit reset.
Archived records include private message bodies and revoked links; treat the export
as private. Current session credentials and current prepared email bodies are omitted. Full
SQLite backups include all runtime data and therefore need stronger storage
protection.
