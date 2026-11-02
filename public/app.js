import { privatePeoplePanel, personChecks, privateSubmissionReview, revealConfirmation, responsiveTable, invitationCandidates, canInvite, canTestInvite } from './organizer.js';
import { matchingTestPanel } from './matching-test.js';
import { historyChecks, historyLabel, historyReview } from './history.js';
const app=document.querySelector('#app');
const dialog=document.querySelector('#dialog');
let session=null, state=null, tab='people', selectedYear=null, member=null, group=null, revealed=false, familyEditing=false, familyUpdated=false;
let matchingReport=null,matchingDrawIndex=0;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const personName=id=>state.people.find(p=>p.id===id)?.name||'Unknown person';
const badge=(label,style='')=>`<span class="badge ${style}">${esc(label)}</span>`;
let noticeTimer;
function notice(message,error=false) {
  const el=document.querySelector('#notice');el.textContent=message;el.className=error?'error':'';el.hidden=false;
  clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.hidden=true,7000);
}
async function api(path,body) {
  const response=await fetch(`/api${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(session?{'X-CSRF-Token':session.csrf}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok) throw new Error(data.error||'Something went wrong.');return data;
}
function showDialog(html) {
  const content=document.querySelector('#dialog-content'),wasOpen=dialog.open;
  content.innerHTML=html;
  const heading=content.querySelector('h2');
  if(heading){heading.id='dialog-title';heading.tabIndex=-1;dialog.setAttribute('aria-labelledby',heading.id);}
  else dialog.removeAttribute('aria-labelledby');
  content.insertAdjacentHTML('beforeend','<p class="form-error" data-dialog-error role="alert" tabindex="-1" hidden></p>');
  dialog.showModal();
  if(wasOpen)heading?.focus();
}
const reducedMotion=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const envelopeIcon='<svg viewBox="0 0 64 48" fill="none" aria-hidden="true"><rect x="3" y="3" width="58" height="42" rx="5" fill="currentColor" stroke="var(--ink)" stroke-width="2.5"/><path d="m4 5 28 22L60 5M4 43l20-19m36 19L40 24" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round"/><path d="M32 25c-7-5-12 1 0 9 12-8 7-14 0-9Z" fill="var(--red)"/></svg>';
const treeIcon='<svg viewBox="0 0 32 40" fill="none" aria-hidden="true"><path d="M16 3v32M16 8 9 14m7-1 8 7m-8-1L5 26m11-1 12 6M9 36h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="24" cy="23" r="4" fill="var(--red)"/></svg>';
async function leaveCard(element) {
  if(reducedMotion()||!element?.isConnected)return;
  await element.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(8px)'}],{duration:140,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{});
}
async function sendLetter(form,updated) {
  if(reducedMotion()||!form.isConnected)return;
  if(updated){await leaveCard(form);return;}
  const flight=document.createElement('div');flight.className='send-flight';flight.setAttribute('aria-hidden','true');flight.innerHTML=envelopeIcon;
  form.parentElement.append(flight);
  form.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'translateY(12px) scale(.96)'}],{duration:260,easing:'ease-in',fill:'forwards'});
  await flight.animate([{opacity:0,transform:'translate(-50%, 30px) scale(.5) rotate(-8deg)',offset:0},{opacity:1,transform:'translate(-50%, 0) scale(1.1) rotate(5deg)',offset:.35},{opacity:1,transform:'translate(-50%, -18px) scale(1) rotate(-5deg)',offset:.55},{opacity:0,transform:'translate(-30%, -180px) scale(.65) rotate(-18deg)',offset:1}],{duration:720,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'}).finished.catch(()=>{});
  flight.remove();
}
document.querySelector('#close-dialog').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>document.querySelector('#dialog-content').replaceChildren());
document.querySelector('#logout').addEventListener('click',async()=>{await api('/logout',{});session=null;location.href='/';});

const artworkSrc='/christmas-friends-1200.3ac4a7fd0f0f.webp';
const artworkSrcset='/christmas-friends-480.9c3ae43a3035.webp 480w, '+artworkSrc+' 1200w';
const familyArtworkSizes='(max-width: 700px) 140px, 450px';
function holidayArtwork(sizes) {
  return `<img class="holiday-friends" src="${artworkSrc}" srcset="${artworkSrcset}" sizes="${sizes}" alt="Charlie Brown, Snoopy, and Woodstock beside a Christmas tree" width="1200" height="800" fetchpriority="high" decoding="async">`;
}
function preloadFamilyArtwork() {
  if(document.querySelector('[data-artwork-preload]'))return;
  const link=document.createElement('link');link.rel='preload';link.as='image';link.type='image/webp';
  link.href=artworkSrc;link.imageSrcset=artworkSrcset;link.imageSizes=familyArtworkSizes;
  link.fetchPriority='high';link.dataset.artworkPreload='';document.head.append(link);
}

function home() {
  if(session?.role==='member'){location.replace('/join');return;}
  app.innerHTML=`<section class="home-card"><div class="home-copy"><p class="eyebrow">SECRET SANTA FOR FAMILY &amp; FRIENDS</p><h1>Your Christmas<br>wish list.</h1><div class="home-invitation">${envelopeIcon}<p>Open your emailed invitation, or sign in with the email your organizer added.</p></div><p class="home-help"><a class="text-link" href="/join">Open your wish list <span aria-hidden="true">↗</span></a></p></div><div class="home-art">${holidayArtwork('(max-width: 700px) 90vw, 550px')}</div></section>`;
}
function signInForm() {
  return '<form data-form="email-sign-in" class="sign-in-form"><label>Email<input name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.com" required></label><button class="primary">Send sign-in link</button><p class="sign-in-status" role="status" aria-live="polite" hidden></p></form>';
}
function login(message='') {
  app.innerHTML=`<section class="login-card"><h1>Organizer</h1>${message?`<p class="inline-error">${esc(message)}</p>`:''}<form data-form="login"><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Sign in</button></form></section>`;
}
async function loadAdmin() {
  state=await api(`/admin/state${selectedYear?`?year=${selectedYear}`:''}`);
  if(state.exchange&&!state.currentYears.includes(state.year)) {
    selectedYear=null;state=await api('/admin/state');
  }
  matchingReport=null;
  matchingDrawIndex=0;
  selectedYear=state.exchange?.year||null;
  renderAdmin();
}
function renderAdmin() {
  const e=state.exchange;
  if(!e){app.innerHTML=`<section class="login-card"><h1>New exchange</h1>${newYearForm()}</section>`;return;}
  const active=state.people.filter(p=>p.active),ready=active.filter(p=>p.validation.passed&&!p.changesRequested).length;
  const pending=(state.submissions||[]).filter(p=>p.status==='pending').length;
  const status={open:'Not drawn',drafted:'Draft',locked:'Finalized',archived:'Archived',no_exchange:'No exchange'}[e.state];
  app.innerHTML=`<section class="dashboard"><div class="dash-heading"><h1>${esc(e.title)}</h1><div class="year-tools"><label class="sr-only" for="year-select">Year</label><select id="year-select">${state.exchanges.filter(y=>state.currentYears.includes(y.year)).map(y=>`<option ${y.year===e.year?'selected':''}>${y.year}</option>`).join('')}</select><button data-action="new-year" class="secondary">+ Year</button></div></div><p class="dashboard-status">${active.length} people · ${ready}/${active.length} wish lists${pending?' · '+pending+' to review':''} · ${esc(status)}</p><nav class="tabs" aria-label="Organizer sections">${[['people','People'],['rules','Rules'],['draw','Draw'],['history','History'],['email','Delivery']].map(([key,label])=>`<button data-action="tab" data-tab="${key}" class="${tab===key?'selected':''}" aria-pressed="${tab===key}">${label}</button>`).join('')}</nav><div class="tab-content">${({people:peoplePanel,rules:rulesPanel,draw:drawPanel,history:historyPanel,email:emailPanel}[tab])()}</div></section>`;
}
const isMutable=()=>['open','drafted'].includes(state.exchange.state);
function peoplePanel() {return privatePeoplePanel(state);}
function personForm(person={}) {
  const current=state.people.some(p=>p.id===person.id),available=state.identities.filter(p=>!state.people.some(member=>member.id===p.id));
  const title=person.id?(current?'Edit '+person.name:'Add '+person.name+' to '+state.year):'Add person to '+state.year;
  return `<h2>${esc(title)}</h2>${!person.id&&available.length?`<label>Saved family member<select id="existing-member-select"><option value="">Add someone new</option>${available.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>`:''}<form data-form="person"><input type="hidden" name="year" value="${state.year}"><input type="hidden" name="id" value="${esc(person.id||'')}"><label>Name<input name="name" required maxlength="80" value="${esc(person.name||'')}"></label><div data-existing-person hidden></div><label>Email<input type="email" name="email" value="${esc(person.email||'')}" placeholder="You can add this later"></label><details class="person-aliases"><summary>Other names</summary><label>Nicknames or previous names, separated by commas<input name="aliases" value="${esc((person.aliases||[]).join(', '))}"></label></details><label class="checkbox"><input type="checkbox" name="active" ${person.active===0?'':'checked'}>Taking part in ${state.year}</label><button class="primary">${current?'Save changes':'Add person'}</button></form>`;
}
function invitationDialog({test=false,personId=null}={}) {
  const resend=Boolean(personId),people=resend?state.people.filter(p=>p.id===personId):test?state.people.filter(p=>p.active):invitationCandidates(state),preview=state.emailMode==='preview';
  const available=p=>resend?p.invitation.canResend:test?canTestInvite(p,state):canInvite(p);
  const title=resend?'Resend invitation':test?'Test invitations':'Choose invitation recipients';
  const description=resend?'Send a new private link valid for 48 hours to the address below. Their previous invitation stops working. Their saved wish list stays intact.':test?'Send new unique links that open empty forms, even for people who already submitted. Their saved lists stay intact until they submit the new forms.':'Choose who to invite now. Everyone else can wait.';
  const submit=resend?(preview?'Preview new invitation':'Resend invitation'):test?(preview?'Create fresh test previews':'Send fresh test invitations'):(preview?'Create invitation previews':'Send invitation emails');
  return `<h2>${title}</h2><p>${description}</p>${preview?'<p class="callout">Preview mode is on. No emails will leave the app.</p>':'<p>Only the people you select will receive a private wish-list link.</p>'}<form data-form="invite-people"><input type="hidden" name="mode" value="${resend?'resend':test?'test':'send'}"><input type="hidden" name="year" value="${state.year}"><input type="hidden" name="recipients" value="${esc(JSON.stringify(people.map(p=>({id:p.id,email:p.email,invitationId:p.invitation.id}))))}"><fieldset class="invitation-selection"><legend>Recipients</legend><ul class="invitation-preview">${people.map(p=>`<li><label class="checkbox invitation-recipient"><input type="checkbox" name="recipient" value="${esc(p.id)}" ${available(p)?resend?'checked':'':'disabled'}><span><strong>${esc(p.name)}</strong><small>${available(p)?esc(p.email):!canInvite(p)?'Add an email address to invite':'Review pending or uncertain invitations in Delivery first'}</small></span></label></li>`).join('')}</ul></fieldset><p data-invitation-count role="status">${resend?'1':'0'} selected</p><button class="primary" data-invitation-submit ${resend&&people.some(available)?'':'disabled'}>${submit}</button></form>`;
}

function rulesPanel() {
  const e=state.exchange,disabled=isMutable()?'':'disabled';
  const legacy=!isMutable()&&(e.no_reciprocal||state.exclusions.length);
  const paired=new Set(state.partners.flatMap(p=>[p.first,p.second]));
  const available=state.people.filter(p=>!paired.has(p.id));
  const options='<option value="">Choose a person</option>'+available.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${p.active?'':' (not taking part)'}</option>`).join('');
  return `<div class="two-column"><section class="panel"><h2>Settings</h2><form data-form="settings"><fieldset ${disabled}><label>Exchange name<input name="title" value="${esc(e.title)}" required maxlength="100"></label><div class="form-row"><label>Gift budget<input name="budget" value="${esc(e.budget)}" placeholder="e.g. $50"></label><label>Exchange date<input name="event_date" value="${esc(e.event_date)}" placeholder="e.g. December 25"></label></div><button class="primary">Save details</button></fieldset></form></section><section class="panel"><h2>Matching rules</h2><ul><li>Everyone gives once and receives once.</li><li>You cannot draw yourself.</li><li>You cannot draw someone you gave to in either of the previous two years.</li><li>Marked partners cannot draw each other.</li></ul>${legacy?'<p>This finalized exchange keeps its original restrictions.</p>':''}</section></div>
  <section class="panel exchange-tools"><h2>Partners for ${e.year}</h2><p>Add each couple once. Neither person can draw the other. Partner choices carry into new years.</p>
    ${state.partners.length?`<ul class="submission-list">${state.partners.map(p=>`<li><strong>${esc(personName(p.first))} &amp; ${esc(personName(p.second))}</strong>${isMutable()?`<form data-form="partners"><input type="hidden" name="year" value="${e.year}"><input type="hidden" name="first" value="${esc(p.first)}"><input type="hidden" name="second" value="${esc(p.second)}"><input type="hidden" name="remove" value="true"><button class="quiet">Remove pair</button></form>`:''}</li>`).join('')}</ul>`:'<p>No partners marked yet.</p>'}
    ${isMutable()&&available.length>=2?`<form data-form="partners"><input type="hidden" name="year" value="${e.year}"><div class="form-row"><label>Person<select name="first" required>${options}</select></label><label>Their partner<select name="second" required>${options}</select></label></div><button class="secondary">Add partners</button></form>`:''}
  </section>
  ${extraExclusionsPanel()}
  <section class="panel exchange-tools"><h2>Prepare for real invitations</h2><p>Clear ${e.year} test lists, draft matches, and old access links. Keep your people, partner choices, settings, and previous years.</p>${isMutable()?`<button class="secondary" data-action="reset-exchange" ${state.reset.blocked?'disabled':''}>Reset ${e.year} test data</button>${state.reset.blocked?`<p role="status">${esc(state.reset.blocked)}</p>`:''}`:'<p>Finalized draws and historical years cannot be reset.</p>'}</section>`;
}
function extraExclusionsPanel() {
  const year=state.year,options='<option value="">Choose a person</option>'+state.people.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${p.active?'':' (not taking part)'}</option>`).join('');
  return `<section class="panel exchange-tools" id="extra-exclusions"><h2>Extra exclusions for ${year}</h2><p>Choose a giver and someone they must not draw. This applies in one direction, for ${year} only. Partner rules stay in place.</p>
    ${state.extraExclusions.length?`<ul class="submission-list">${state.extraExclusions.map(p=>`<li><div><strong>${esc(personName(p.giver))}</strong> must not draw <strong>${esc(personName(p.recipient))}</strong></div>${isMutable()?`<form data-form="exclusion"><input type="hidden" name="year" value="${year}"><input type="hidden" name="giver" value="${esc(p.giver)}"><input type="hidden" name="recipient" value="${esc(p.recipient)}"><input type="hidden" name="remove" value="true"><button class="quiet" aria-label="Remove exclusion: ${esc(personName(p.giver))} must not draw ${esc(personName(p.recipient))}">Remove</button></form>`:''}</li>`).join('')}</ul>`:'<p>No extra exclusions saved.</p>'}
    ${isMutable()?`<form data-form="exclusion"><input type="hidden" name="year" value="${year}"><div class="form-row"><label>Giver<select name="giver" required>${options}</select></label><label>Must not draw<select name="recipient" required>${options}</select></label></div><button class="secondary">Add exclusion</button></form><p class="section-note">Saving a change clears any current draft so the next draw uses these rules. Saved wish lists are kept. You can check the rules from Draw without revealing matches.</p>`:'<p>This draw is finalized. Its exclusions are locked.</p>'}</section>`;
}
function resetDialog() {
  const r=state.reset,year=state.year;
  return `<h2>Reset ${year} test data?</h2><p>This clears ${r.lists} saved lists, ${r.submissions} earlier submissions, ${r.draftMatches} draft matches, and the current invitation status. All ${year} invitation links, sign-in links, and family sessions will stop working.</p><p>Your ${r.people} people, emails, participation choices, partners, settings, and other years stay saved. ${r.emails} earlier email records (${r.sent} sent) will be kept in a private archive.</p><p>Cleared lists cannot be restored from this screen. No new emails are sent by resetting.</p><form data-form="reset-exchange"><input type="hidden" name="year" value="${year}"><input type="hidden" name="review" value="${esc(r.review)}"><label>Type RESET ${year}<input name="confirm" required pattern="RESET ${year}" autocomplete="off" spellcheck="false"></label><button class="primary">Clear test data</button></form>`;
}
function drawPanel() {
  const e=state.exchange;
  const historyReady=state.history.every(h=>h.status==='verified');
  return `<div class="section-heading"><div><h2>Draw</h2><p>Draw names for ${e.year}, using ${e.year-1} and ${e.year-2} history.</p></div>${isMutable()?'<button class="primary" data-action="draft">'+(e.state==='drafted'?'Generate another draft':'Generate a draft')+'</button>':''}</div>${matchingTestPanel(matchingReport,state.people,matchingDrawIndex,e.year)}${historyChecks(state.history)}${!historyReady&&isMutable()?`<p class="callout">Review the history years below before finalizing. Each Review button opens that year without leaving ${e.year}.</p>`:''}${state.assignments.length?`<div class="match-list">${state.assignments.map(p=>`<div><span>${esc(personName(p.giver))}</span><span class="match-arrow" aria-hidden="true">→</span><strong>${esc(personName(p.recipient))}</strong></div>`).join('')}</div>`:state.draw?.count?`<div class="private-draw panel"><h3>${state.draw.count} matches prepared</h3>${badge(state.draw.passed?'Matching checks passed':'Needs attention',state.draw.passed?'green':'amber')}<p>Matches are hidden. Everyone gives and receives once. Self-matches, marked partners, saved extra exclusions, and repeat recipients from the previous two years are checked automatically.</p><button class="secondary" data-action="confirm-draw-reveal">Reveal matches</button></div>`:'<div class="empty"><h3>No draw yet.</h3><p>Review the people and past matches, then draw.</p></div>'}${e.state==='drafted'?`<div class="finalize-bar"><div><strong>Ready to finalize?</strong><p>Finalizing locks this year's roster and draw. Emails are sent separately.</p></div><button class="primary" data-action="finalize" ${historyReady&&state.draw?.passed&&state.people.filter(p=>p.active).every(p=>p.validation.passed&&!p.changesRequested)&&!(state.submissions||[]).some(s=>s.status==='pending')?'':'disabled'}>Finalize draw</button></div>`:''}${e.state==='locked'?'<p class="callout green-callout">This draw is saved and locked. Go to Email to review delivery status and send. Message previews are optional.</p>':''}`;
}
function historyPanel() {
  const older=state.exchanges.filter(e=>state.historyYears.includes(e.year)&&!state.history.some(h=>h.year===e.year));
  const card=h=>`<article class="panel"><h3>${h.year}</h3>${badge(historyLabel(h),h.status==='verified'?'green':'amber')}<p>${h.noExchange?'No exchange recorded':h.pairCount===undefined?'Saved historical record':`${h.pairCount} recorded pairings`}</p><button class="secondary" data-action="view-history" data-year="${h.year}">Review ${h.year} history</button></article>`;
  return `<div class="section-heading"><div><h2>History for the ${state.year} draw</h2><p>Review ${state.year-1} and ${state.year-2}. Opening a past record keeps ${state.year} selected.</p></div><button class="secondary" data-action="import">Import or update a year</button></div>
    <div class="history-cards">${state.history.map(card).join('')}</div>
    ${older.length?`<details><summary>Older history</summary><div class="history-cards">${older.map(e=>card({year:e.year,status:e.history_status,noExchange:e.state==='no_exchange'})).join('')}</div></details>`:''}
    <p class="section-note">Only record no exchange when your group did not hold a draw that year.</p><button class="secondary" data-action="no-exchange">Record a year with no exchange</button><p><a class="text-link" href="/api/admin/export" download>Export private data (includes wish lists and matches) →</a></p>`;
}
function historyForm(record={year:state.year-1,pairs:[],source:'',history_status:'provisional'}) {
  return `<h2>Save a past year's matches</h2><p>The first name gave a gift to the second. One pairing per line. You will return to ${state.year} after saving.</p><form data-form="history"><input type="hidden" name="contextYear" value="${state.year}"><label>Year<input name="year" type="number" min="2000" max="2200" required ${record.exists?'readonly':''} value="${record.year}"></label><label>Pairings<textarea name="pairs" rows="10" required placeholder="Alex → Jamie&#10;Jamie → Sam&#10;Sam → Alex">${esc(record.pairs.map(p=>`${p.giver} → ${p.recipient}`).join('\n'))}</textarea></label><label>Source or notes<input name="source" value="${esc(record.source)}" placeholder="e.g. Family recollection, waiting for confirmation"></label><label class="checkbox"><input type="checkbox" name="verified" ${record.history_status==='verified'?'checked':''}>The family has confirmed all these matches</label><button class="primary">Save history</button></form>`;
}
function emailPanel() {
  return `<div class="section-heading"><div><h2>Delivery</h2><p>Invitation and match email records.</p></div>${badge(state.emailMode==='preview'?'Preview mode':'SMTP mode',state.emailMode==='preview'?'amber':'green')}</div>${state.emailMode==='preview'?'<p class="callout">Preview mode is on. Messages are stored here, and no emails leave the app.</p>':!state.smtpReady?'<p class="callout">SMTP is not configured. Add the server email settings before sending.</p>':''}<div class="email-actions"><button class="secondary" data-action="prepare-matches" ${state.exchange.state==='locked'?'':'disabled'}>Prepare assignment emails</button><button class="primary" data-action="send" ${state.outbox.some(p=>p.status==='pending'&&!p.kind.startsWith('signin:'))?'':'disabled'}>${state.emailMode==='preview'?'Mark pending messages as previewed':'Send pending emails'}</button></div>${state.resets.length?`<p class="callout">Earlier email records from ${state.resets.length} reset${state.resets.length===1?'':'s'} are kept privately. <a href="/api/admin/export" download>Export private data, including archived email records</a>.</p>`:''}${state.outbox.length?responsiveTable(['To','Message','Status','Actions'],state.outbox.map(mail=>[
    `<strong>${esc(personName(mail.giver))}</strong><small class="block muted">${esc(mail.recipient_email)}</small>`,
    `${mail.kind.startsWith('signin:')?'Sign-in link':mail.kind==='invite'?'Wish-list invitation':mail.kind.startsWith('invite-resend:')?'Resent invitation':mail.kind.startsWith('test-invite:')?'Fresh test invitation':mail.kind.startsWith('revision:')?'Update request':'Assignment'}${mail.error?`<small class="block inline-error">${esc(mail.error)}</small>`:''}`,
    badge(mail.status,mail.status==='sent'?'green':['failed','uncertain'].includes(mail.status)?'amber':''),
    `<button class="quiet" data-action="preview-email" data-id="${mail.id}">Reveal preview</button>${!mail.kind.startsWith('signin:')&&['failed','preview','uncertain'].includes(mail.status)?`<button class="quiet" data-action="retry-email" data-id="${mail.id}">${mail.status==='preview'?'Queue for sending':'Review & retry'}</button>`:''}`
  ]),'Email delivery'):'<div class="empty">No messages yet. Send invitations from People.</div>'}<p class="section-note">“Sent” means your mail server accepted the message. It does not guarantee delivery to the inbox. An interrupted send is marked uncertain and requires review before retrying.</p>`;
}
function newYearForm() {return `<form data-form="new-year"><label>Year<input name="year" type="number" min="${new Date().getFullYear()}" max="2200" value="${state?.year?state.year+1:new Date().getFullYear()}" required></label><p class="muted">Family members carry over automatically. Wish lists start fresh. You can include or leave people out afterward. Add past matches from History.</p><button class="primary">Create exchange</button></form>`;}


function giftRow(gift={},index=0) {
  return `<div class="gift-entry" data-gift-row><span class="gift-doodle" aria-hidden="true">✧</span><div class="gift-entry-fields"><label>Gift idea<input name="gift-label-${index}" maxlength="160" value="${esc(gift.label||'')}" placeholder="e.g. A cozy scarf"></label><label>Product link <span class="optional">optional</span><input name="gift-url-${index}" type="url" maxlength="2000" value="${esc(gift.url||'')}" placeholder="https://…" aria-describedby="gift-link-hint-${index}"></label><small class="field-hint" id="gift-link-hint-${index}">Start the link with https://</small></div><button type="button" class="remove-gift" data-action="remove-gift" aria-label="Remove gift idea">×</button></div>`;
}
function giftFields(gifts=[]) {
  return `<div class="gift-editor" data-next-gift="${gifts.length}"><div class="gift-fields">${gifts.map((gift,i)=>giftRow(gift,i)).join('')}</div><button type="button" class="add-gift" data-action="add-gift" ${gifts.length>=5?'disabled':''}><span aria-hidden="true">+</span> Add a gift or product link</button><span class="gift-limit" ${gifts.length>=5?'':'hidden'}>Up to 5 gift ideas.</span></div>`;
}
function giftLinks(gifts=[]) {
  const safe=url=>{try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password;}catch{return false;}};
  return gifts.length?`<ul class="gift-ideas">${gifts.map(g=>`<li>${g.url&&safe(g.url)?`<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(g.label||'Gift idea')}</span><span aria-hidden="true">↗</span></a>`:`${esc(g.label||'Gift idea')}${g.url?' (invalid product link)':''}`}</li>`).join('')}</ul>`:'';
}
function familyHeading(e,title,description,saved=false) {
  return `<header class="family-heading"><p class="exchange-tag">${treeIcon}<span>${esc(e.title)}</span></p>${saved?'<span class="saved-seal" aria-hidden="true">✓<span class="seal-sparkle">✧</span></span>':''}<h1 tabindex="-1">${title}</h1><p class="family-intro">${description}</p><div class="family-art">${holidayArtwork(familyArtworkSizes)}</div>${e.budget||e.eventDate?`<div class="exchange-details">${e.budget?`<span><small>Gift budget</small>${esc(e.budget)}</span>`:''}${e.eventDate?`<span><small>Exchange date</small>${esc(e.eventDate)}</span>`:''}</div>`:''}<ol class="family-steps" aria-label="How it works"><li class="${saved?'complete':'current'}"><span aria-hidden="true">1</span>Write your list</li><li class="${saved?'complete':''}"><span aria-hidden="true">2</span>Send to Santa</li><li><span aria-hidden="true">3</span>Get your match</li></ol></header>`;
}
const wishListSubmitted=(p,type)=>type==='group-wishlist'?!!p:!!(p?.wishlist||p?.gifts?.length);
function wishListForm(p,type,{identity=false,approved=false}={}) {
  const saved=wishListSubmitted(p,type);
  return `<form data-form="${type}" class="family-card wishlist-form"><div class="letter-heading"><h2>${saved?'Edit wish list':'Dear Santa,'}</h2><span class="postage-stamp" aria-hidden="true">${treeIcon}</span></div>${identity?`<fieldset class="form-section"><legend>Your details</legend><div class="form-row"><label>Name<input name="name" autocomplete="name" required maxlength="80" placeholder="Your name" value="${esc(p?.name||'')}" ${approved?'readonly':''}></label><label>Email<input name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" placeholder="you@example.com" value="${esc(p?.email||'')}" ${approved?'readonly':''}></label></div><p class="field-hint">Used for your sign-in and match emails.</p></fieldset>`:''}<fieldset class="form-section"><legend>Gift ideas</legend><label class="sr-only" for="wishlist">Wish list</label><textarea id="wishlist" name="wishlist" rows="4" maxlength="5000" placeholder="Gift ideas, sizes, and favorite colors…">${esc(p?.wishlist||'')}</textarea>${giftFields(p?.gifts)}</fieldset><details class="message-details" ${p?.message?'open':''}><summary><span class="disclosure-label"><span class="note-heart" aria-hidden="true">♡</span> Message to your Secret Santa <span class="optional">optional</span></span></summary><label class="sr-only" for="gifter-message">Message to your gifter</label><textarea id="gifter-message" class="gifter-message" name="message" rows="3" maxlength="2000" placeholder="Anything your Secret Santa should know…">${esc(p?.message||'')}</textarea></details><p class="form-error" data-form-error role="alert" tabindex="-1" hidden></p><div class="family-actions"><button type="submit" class="primary">${saved?'Save changes':'Send to Santa'} <span class="button-envelope">${envelopeIcon}</span></button>${saved?'<button type="button" class="quiet" data-action="cancel-wishlist">Cancel</button>':''}</div><p class="family-footnote">Return on this device to edit, or request a new email sign-in link.</p></form>`;
}
function wishListSummary(p,{editable=true,identity=true}={}) {
  return `<section class="family-card saved-wishlist" aria-label="Your saved wish list"><div class="saved-card-heading"><div><p class="eyebrow">YOUR WISH LIST</p>${identity?`<h2>${esc(p.name)}</h2>${p.email?`<p class="saved-email">${esc(p.email)}</p>`:''}`:'<h2>Wish list</h2>'}</div><span class="postage-stamp" aria-hidden="true">${treeIcon}</span></div><div class="letter-receipt"><span aria-hidden="true">✓</span><p>Wish list saved.</p></div>${p.wishlist?`<div class="saved-section"><h3>On my wish list</h3><p class="wishlist-text">${esc(p.wishlist)}</p></div>`:''}${p.gifts?.length?`<div class="saved-section"><h3>Gifts &amp; links</h3>${giftLinks(p.gifts)}</div>`:''}${p.message?`<div class="saved-section saved-message"><h3>Message to your Secret Santa</h3><p class="wishlist-text">${esc(p.message)}</p></div>`:''}${editable?'<button class="secondary edit-letter" data-action="edit-wishlist"><span aria-hidden="true">✎</span> Edit wish list</button>':''}${editable?'<p class="family-footnote">Return on this device to edit, or request a new email sign-in link.</p>':''}</section>`;
}
function focusFamilyHeading() {app.querySelector('.family-heading h1')?.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
function renderGroup() {
  const {exchange:e,submission:p}=group;
  const approved=['approved','accepted'].includes(p?.status);
  const declined=p?.status==='rejected';
  const closed=declined||e.state==='archived'||(!approved&&!['open','drafted'].includes(e.state));
  const editing=(!p||familyEditing)&&!closed;
  const title=declined?'Check with your organizer.':closed?'Wish lists are closed.':editing?'Your Christmas<br>wish list.':familyUpdated?'Changes saved.':'Sent to Santa.';
  const description=declined?'Your list wasn’t approved. Ask your organizer about the details.':closed?'Contact your organizer if you need to make a change.':editing?'Add gift ideas, product links, and a message for your Secret Santa.':approved?'We’ll email your match after the draw.':'Your organizer will review your wish list. We’ll email your match after the draw.';
  app.innerHTML=`<section class="family-page">${familyHeading(e,title,description,!!p&&!editing&&!closed)}<div class="family-content">${p?.changesRequested?`<p class="callout" role="status">Your organizer requested an update: ${esc(p.changesRequested)}</p>`:''}${editing?wishListForm(p,'group-wishlist',{identity:true,approved}):p?wishListSummary(p,{editable:!closed}):'<div class="family-card"><p>No wish list has been submitted.</p></div>'}</div></section>`;
}
function submissionReview(p) {return privateSubmissionReview(p,state);}
function recipientCard(r) {
  return r?`<section class="recipient-card" aria-label="Your Secret Santa match">${revealed?`<p class="eyebrow">You’re giving to</p><div class="recipient-heading"><h2 tabindex="-1">${esc(r.name)}</h2><button class="quiet" data-action="hide-match">Hide match</button></div>${r.wishlist?`<p class="wishlist-text">${esc(r.wishlist)}</p>`:'<p>No wish list yet.</p>'}${giftLinks(r.gifts)}${r.message?`<div class="saved-message"><h3>A note from ${esc(r.name)}</h3><p class="wishlist-text">${esc(r.message)}</p></div>`:''}`:'<p class="eyebrow">The names have been drawn</p><h2>Your match is ready.</h2><button class="primary" data-action="reveal">View my match <span aria-hidden="true">→</span></button>'}</section>`:'';
}
function renderRecipient() {
  app.querySelector('.recipient-card').outerHTML=recipientCard(member.recipient);
  app.querySelector(revealed?'.recipient-heading h2':'[data-action="reveal"]')?.focus({preventScroll:true});
}
function renderMember() {
  const {exchange:e,person:p,recipient:r}=member;
  const editable=e.state!=='archived'&&p.active;
  const editing=editable&&(familyEditing||(!p.wishlist&&!p.gifts.length));

  app.innerHTML=`<section class="family-page">${familyHeading(e,editing?'Your Christmas<br>wish list.':wishListSubmitted(p,'wishlist')?(familyUpdated?'Changes saved.':'Sent to Santa.'):'Your wish list.',!p.active?'You’re sitting out this year.':member.freshStart?'This invitation starts an empty list. Submitting it replaces your saved list.':editing?'Add gift ideas, product links, and a message for your Secret Santa.':r?'View your match below.':'We’ll email your match after the draw.',!editing&&!!(p.wishlist||p.gifts.length))}<div class="family-content">${p.changesRequested?`<p class="callout" role="status">Your organizer requested an update: ${esc(p.changesRequested)}</p>`:''}${recipientCard(r)}${editing?wishListForm(p,'wishlist'):wishListSummary(p,{editable})}</div></section>`;
}
function renderFamily() {if(session?.role==='member')renderMember();else renderGroup();}
function formGifts(form) {
  return [...form.querySelectorAll('[data-gift-row]')].map(row=>({label:row.querySelector('input[name^="gift-label-"]').value.trim(),url:row.querySelector('input[name^="gift-url-"]').value.trim()})).filter(g=>g.label||g.url);
}
document.addEventListener('input',event=>{
  const form=event.target.closest('[data-form="person"]');
  if(!form || event.target.name!=='name' || form.elements.id.value)return;
  const key=event.target.value.trim().toLocaleLowerCase('en-US');
  const existing=state.identities.find(p=>[p.name,...p.aliases].some(name=>name.trim().toLocaleLowerCase('en-US')===key));
  const hint=form.querySelector('[data-existing-person]');hint.hidden=!existing;
  hint.innerHTML=existing?`<p>This person is already saved. Use their existing entry to keep their history.</p><button type="button" class="secondary" data-action="use-person" data-id="${esc(existing.id)}">Use ${esc(existing.name)}’s entry</button>`:'';
});
document.addEventListener('change',event=>{
  const exclusion=event.target.closest('[data-form="exclusion"]');
  if(exclusion&&event.target.name==='giver') {
    for(const option of exclusion.elements.recipient.options)option.disabled=Boolean(option.value&&option.value===event.target.value);
    if(exclusion.elements.recipient.value===event.target.value)exclusion.elements.recipient.value='';
  }
  if(event.target.id==='existing-member-select'&&event.target.value)showDialog(personForm(state.identities.find(p=>p.id===event.target.value)));
  const invitations=event.target.closest('[data-form="invite-people"]');
  if(invitations&&event.target.name==='recipient') {
    const count=invitations.querySelectorAll('input[name="recipient"]:checked:not(:disabled)').length;
    invitations.querySelector('[data-invitation-count]').textContent=`${count} selected`;
    invitations.querySelector('[data-invitation-submit]').disabled=!count;
  }
});
app.addEventListener('input',event=>{
  if(!event.target.closest('.wishlist-form'))return;
  event.target.removeAttribute('aria-invalid');
  event.target.closest('form').querySelector('[data-form-error]').hidden=true;
});
app.addEventListener('change',async event=>{if(event.target.id==='year-select'){selectedYear=Number(event.target.value);try{await loadAdmin();}catch(error){notice(error.message,true);}}});
app.addEventListener('change',event=>{
  if(event.target.id==='matching-test-draw'){
    matchingDrawIndex=Number(event.target.value);renderAdmin();document.querySelector('#matching-test-draw')?.focus();
  }
});
let working=false;
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||working)return;
  const action=button.dataset.action,id=button.dataset.id;
  try {
    if(action==='edit-wishlist'||action==='cancel-wishlist'){
      working=true;await leaveCard(app.querySelector('.family-content'));familyEditing=action==='edit-wishlist';renderFamily();focusFamilyHeading();return;
    }
    if(action==='add-gift'){
      const editor=button.closest('.gift-editor');
      if(editor.querySelectorAll('[data-gift-row]').length>=5)return;
      const index=Number(editor.dataset.nextGift);editor.dataset.nextGift=index+1;
      editor.querySelector('.gift-fields').insertAdjacentHTML('beforeend',giftRow({},index));
      button.disabled=editor.querySelectorAll('[data-gift-row]').length>=5;
      editor.querySelector('.gift-limit').hidden=!button.disabled;
      editor.querySelector('[data-gift-row]:last-child input').focus();return;
    }
    if(action==='remove-gift'){
      const editor=button.closest('.gift-editor'),row=button.closest('[data-gift-row]');
      working=true;button.disabled=true;await leaveCard(row);row.remove();
      editor.querySelector('[data-action="add-gift"]').disabled=false;
      editor.querySelector('.gift-limit').hidden=true;
      editor.querySelector('[data-action="add-gift"]').focus();return;
    }
    if(action==='hide-match'){working=true;await leaveCard(app.querySelector('.recipient-card'));revealed=false;renderRecipient();return;}
    if(action==='copy-link'){
      const input=document.querySelector('#shared-link');
      try {await navigator.clipboard.writeText(input.value);notice('Link copied.');}
      catch {input.focus();input.select();notice('Link selected. Copy it to share.');}
      return;
    }
    if(action==='tab'){tab=button.dataset.tab;renderAdmin();return;}
    if(action==='reset-exchange'){await loadAdmin();if(state.reset.blocked)throw new Error(state.reset.blocked);showDialog(resetDialog());return;}
    if(action==='new-year'){showDialog('<h2>New year</h2>'+newYearForm());return;}
    if(action==='use-person'){showDialog(personForm(state.people.find(p=>p.id===id)||state.identities.find(p=>p.id===id)));return;}
    if(action==='invite-people'){showDialog(invitationDialog());return;}
    if(action==='resend-invitation'){showDialog(invitationDialog({personId:id}));return;}
    if(action==='test-invitations'){showDialog(invitationDialog({test:true}));return;}
    if(action==='remove-person'){showDialog(`<h2>Leave ${esc(personName(id))} out of ${state.year}?</h2><p>They will not be included in this year’s draw or invitation batch. Their saved list and past history are kept.</p><form data-form="participation"><input type="hidden" name="year" value="${state.year}"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="active" value="false"><button class="primary">Leave out this year</button></form>`);return;}

    if(action==='add-person'||action==='edit-person'){showDialog(personForm(state.people.find(p=>p.id===id)));return;}
    if(action==='review-submission'){showDialog(submissionReview(state.submissions.find(p=>p.id===id)));return;}
    if(action==='group-revoke'){showDialog('<h2>Close the group link?</h2><p>The shared link will stop accepting new people. Saved wish lists stay available to their owners.</p><form data-form="group-revoke"><button class="primary">Revoke group link</button></form>');return;}
    if(action==='contact'){const p=state.people.find(p=>p.id===id);showDialog(`<h2>Update ${esc(p.name)}'s email</h2><p>The draw stays locked. Pending and failed messages use the corrected address. Already sent messages stay in the delivery record.</p><form data-form="contact"><input type="hidden" name="id" value="${p.id}"><label>Email<input name="email" type="email" required value="${esc(p.email)}"></label><button class="primary">Save email address</button></form>`);return;}
    if(action==='import'){showDialog(historyForm());return;}
    if(action==='no-exchange'){showDialog(`<h2>No exchange in a previous year?</h2><p>Use this only when your group did not hold a draw that year. Existing matches cannot be erased with this option.</p><form data-form="no-exchange"><label>Year<input name="year" type="number" min="2000" max="2200" value="${Number(button.dataset.year)||state.year-1}" required></label><label>Type NO EXCHANGE<input name="confirm" required autocomplete="off"></label><button class="primary">Record empty year</button></form>`);return;}
    if(action==='finalize'){showDialog('<h2>Finalize draw</h2><p>The roster and matches will be locked, and recipients will appear on family pages. Emails are a separate step.</p><form data-form="finalize"><label>Type FINALIZE<input name="confirm" required autocomplete="off"></label><button class="primary">Finalize draw</button></form>');return;}
    if(action==='preview-email'){showDialog(revealConfirmation('email',id));return;}
    if(action==='confirm-wishlist-reveal'){showDialog(revealConfirmation('wishlist',id));return;}
    if(action==='confirm-submission-reveal'){showDialog(revealConfirmation('submission',id));return;}
    if(action==='confirm-draw-reveal'){showDialog(revealConfirmation('draw'));return;}
    if(action==='wishlist-status'){showDialog(personChecks(state.people.find(p=>p.id===id),state));return;}
    if(action==='request-changes'){const p=state.people.find(p=>p.id===id);showDialog(`<h2>Request an update from ${esc(p.name)}</h2><p>This queues an email. Send it separately from the Email tab.</p><form data-form="request-changes"><input type="hidden" name="id" value="${esc(id)}"><label>What should they fix?<textarea name="note" maxlength="1000" required>${esc(p.validation.issues.join(' '))}</textarea></label><button class="primary">Queue update request</button></form>`);return;}
    if(action==='group-settings'){showDialog(`<h2>${state.exchange.allow_group_join?'Close':'Enable'} group registration?</h2><p>${state.exchange.allow_group_join?'Existing saved lists stay available to their owners.':'Anyone holding the group link can submit a pending list. You will review their identity.'}</p><form data-form="group-settings"><button class="primary">${state.exchange.allow_group_join?'Close registration':'Enable registration'}</button></form>`);return;}
    if(action==='reveal'){working=true;await leaveCard(app.querySelector('.recipient-card'));revealed=true;renderRecipient();return;}
    if(action==='view-history'||action==='edit-history'){
      const record=await api(`/admin/history/record?year=${Number(button.dataset.year)}`);
      if(action==='edit-history'&&!record.canEdit)throw new Error('Finalized history cannot be overwritten.');
      showDialog(action==='edit-history'?historyForm(record):historyReview(record,state.people));return;
    }
    if(action==='test-matching'){
      const year=state.year,label=button.textContent;
      const showPairings=document.querySelector('#show-test-pairings').checked;
      working=true;button.disabled=true;button.textContent='Testing…';matchingReport=null;
      document.querySelector('.test-pairings')?.remove();
      document.querySelector('#matching-test-result').textContent='Testing…';
      try {
        const report=await api('/admin/matching-test',{year,...(showPairings?{showPairings:true,confirm:'REVEAL'}:{})});
        if(state.year!==year)return;
        matchingReport=report;matchingDrawIndex=0;renderAdmin();document.querySelector('#matching-test-result').focus();
      }catch(error){renderAdmin();document.querySelector('[data-action="test-matching"]').focus();throw error;}
      finally{button.textContent=label;}
      return;
    }
    if(action==='hide-test-pairings'){
      if(matchingReport)delete matchingReport.testDraws;
      matchingDrawIndex=0;renderAdmin();document.querySelector('#show-test-pairings').focus();return;
    }
    if(action==='send'&&state.emailMode==='smtp'){showDialog('<h2>Send these emails to the family?</h2><p>Only pending messages will be sent. Check the recipient addresses and delivery status. Opening message content is optional.</p><form data-form="send"><label>Type SEND<input name="confirm" required autocomplete="off"></label><button class="primary">Send pending emails</button></form>');return;}
    if(action==='retry-email'){const mail=state.outbox.find(m=>m.id===id);showDialog(`<h2>Queue this message again?</h2><p>To: ${esc(mail.recipient_email)}</p><p>${mail.status==='uncertain'?'Check with the recipient first: the previous attempt may have delivered. Type CHECKED once you have verified they did not receive it.':'This will return the message to pending. Sending happens separately.'}</p><form data-form="retry"><input type="hidden" name="id" value="${id}">${mail.status==='uncertain'?'<label>Type CHECKED<input name="confirm" required></label>':''}<button class="primary">Queue for sending</button></form>`);return;}
    if(action==='revoke'){showDialog(`<h2>Revoke ${esc(personName(id))}'s access links?</h2><p>All their existing links and signed-in sessions for this year will stop working. Create and share a new link afterward.</p><form data-form="revoke"><input type="hidden" name="id" value="${id}"><button class="primary">Revoke links</button></form>`);return;}
    working=true;button.disabled=true;
    if(action==='share'){const data=await api('/admin/group-link',{year:state.year});showDialog(`<h2>One link for everyone</h2><p>Share this in your family chat. Everyone can fill out their own form.</p><label>Group link<input id="shared-link" readonly value="${esc(data.link)}"></label><button class="primary" data-action="copy-link">Copy link</button>`);return;}
    if(action==='link'){const data=await api('/admin/link',{year:state.year,personId:id});showDialog(`<h2>${esc(personName(id))}'s private link</h2><p>Share this only with ${esc(personName(id))}. It works once, expires in 48 hours, and replaces their previous invitation link.</p><label>Personal link<input readonly value="${esc(data.link)}"></label>`);return;}
    if(action==='reject-submission'){await api('/admin/submissions/reject',{id});dialog.close();}
    if(action==='include-person')await api('/admin/participation',{year:state.year,id,active:true});
    if(action==='draft')await api('/admin/draft',{year:state.year});
    if(action==='prepare-invites'||action==='prepare-matches')await api('/admin/mail/prepare',{year:state.year,kind:action==='prepare-invites'?'invite':'assignment'});
    if(action==='send')await api('/admin/mail/send',{year:state.year});
    await loadAdmin();notice('Saved.');
  }catch(error){notice(error.message,true);}finally{working=false;button.disabled=action==='add-gift'&&button.closest('.gift-editor')?.querySelectorAll('[data-gift-row]').length>=5;}
});

document.addEventListener('submit',async event=>{
  const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();if(working)return;
  const values=Object.fromEntries(new FormData(form));const type=form.dataset.form;
  const button=form.querySelector('button[type="submit"], button:not([type])');
  working=true;if(button)button.disabled=true;
  const familyForm=['group-wishlist','wishlist'].includes(type),buttonText=button?.innerHTML;
  const alreadySubmitted=familyForm&&wishListSubmitted(type==='group-wishlist'?group?.submission:member?.person,type);
  if(familyForm){form.setAttribute('aria-busy','true');if(button)button.innerHTML=`${alreadySubmitted?'Saving…':'Sending…'} <span class="button-envelope">${envelopeIcon}</span>`;}
  try {
    if(type==='email-sign-in'){
      const result=await api('/sign-in',{email:values.email});
      const status=form.querySelector('.sign-in-status');
      status.textContent=result.mode==='email'?"If that email is on the list, check your inbox for a sign-in link. It works once and expires in 15 minutes.":'Email is being set up. Ask the organizer for your sign-in link.';
      status.hidden=false;return;
    }
    if(type==='request-changes')await api('/admin/changes-request',{year:state.year,personId:values.id,note:values.note});
    if(type==='group-settings')await api('/admin/group-settings',{year:state.year,enabled:!state.exchange.allow_group_join});
    if(type==='reveal-private'){
      const endpoints={wishlist:'/admin/wishlist/reveal',submission:'/admin/submissions/reveal',email:'/admin/mail/preview',draw:'/admin/draw/reveal'};
      const data=await api(endpoints[values.kind],{year:state.year,personId:values.id,id:values.id,confirm:'REVEAL'});
      if(values.kind==='draw'){state.assignments=data.assignments;dialog.close();renderAdmin();return;}
      if(values.kind==='email'){showDialog(`<h2>${esc(data.subject)}</h2><p>To: ${esc(data.recipient_email)}</p><pre class="email-preview">${esc(data.body)}</pre>`);return;}
      showDialog(`<h2>${esc(data.name)}’s wish list</h2>${data.wishlist?`<p class="wishlist-text">${esc(data.wishlist)}</p>`:''}${giftLinks(data.gifts)}${data.message?`<h3>Message to their gifter</h3><p class="wishlist-text">${esc(data.message)}</p>`:''}`);return;
    }
    if(type==='login'){session=await api('/login',{password:values.password});document.querySelector('#logout').hidden=false;await loadAdmin();return;}
    if(type==='person')await api('/admin/people',{...values,id:values.id||undefined,year:Number(values.year),active:form.elements.active.checked,aliases:values.aliases.split(',').map(s=>s.trim()).filter(Boolean)});
    if(type==='participation')await api('/admin/participation',{year:Number(values.year),id:values.id,active:values.active==='true'});
    if(type==='invite-people'){
      const selected=new Set(new FormData(form).getAll('recipient'));
      const recipients=JSON.parse(values.recipients).filter(p=>selected.has(p.id));
      if(!recipients.length)throw new Error('Choose at least one person to invite.');
      const test=values.mode==='test',resend=values.mode==='resend';
      const result=await api(`/admin/invitations/${resend?'resend':test?'test':'send'}`,{year:Number(values.year),confirm:resend?'RESEND':test?'TEST':'SEND',...(resend?{recipient:recipients[0]}:{recipients})});
      dialog.close();await loadAdmin();
      const issues=result.counts.failed+result.counts.uncertain;
      notice(issues?`${result.counts.sent} invitations sent; ${issues} delivery issues. Review Delivery.`:resend?(state.emailMode==='preview'?'Invitation preview created. No email sent.':'Invitation sent.'):state.emailMode==='preview'?`${result.counts.preview} ${test?'fresh test ':''}invitation previews created. No emails sent.`:`${result.counts.sent} ${test?'fresh test ':''}invitation emails sent.`,!!issues);return;
    }
    if(type==='partners')await api('/admin/partners',{...values,year:Number(values.year),remove:values.remove==='true'});
    if(type==='exclusion')await api('/admin/exclusions',{...values,year:Number(values.year),remove:values.remove==='true'});
    if(type==='reset-exchange'){
      await api('/admin/reset',{...values,year:Number(values.year)});selectedYear=Number(values.year);tab='people';
      dialog.close();await loadAdmin();notice('Test data cleared. Review your people, then send real invitations.');return;
    }
    if(type==='contact')await api('/admin/contact',{...values,year:state.year});
    if(type==='settings')await api('/admin/settings',{...values,year:state.year});
    if(type==='new-year'){const data=await api('/admin/exchanges',{year:Number(values.year),copyFrom:Number(values.copyFrom)||null});selectedYear=data.year;tab='people';}
    if(type==='history'){
      const assignments=values.pairs.split('\n').filter(line=>line.trim()).map(line=>{
        const parts=line.split(/\s*(?:→|->| - |,)\s*/);if(parts.length!==2)throw new Error('Use one Giver → Recipient pairing per line.');return {giver:parts[0],recipient:parts[1]};
      });
      await api('/admin/history',{year:Number(values.year),assignments,source:values.source,status:form.elements.verified.checked?'verified':'provisional'});selectedYear=Number(values.contextYear);
    }
    if(type==='confirm-history')await api('/admin/history/confirm',{year:Number(values.year)});
    if(type==='finalize')await api('/admin/finalize',{year:state.year,confirm:values.confirm});
    if(type==='no-exchange')await api('/admin/history/none',{year:Number(values.year),confirm:values.confirm});
    if(type==='send')await api('/admin/mail/send',{year:state.year,confirm:values.confirm});
    if(type==='retry')await api('/admin/mail/retry',values);
    if(type==='revoke')await api('/admin/revoke',{year:state.year,personId:values.id});
    if(type==='group-revoke')await api('/admin/group-revoke',{year:state.year});
    if(type==='approve-submission')await api('/admin/submissions/approve',{id:values.id,personId:values.personId});
    if(type==='group-wishlist'){
      const gifts=formGifts(form);
      if(!values.wishlist.trim()&&!gifts.length)throw new Error('Add a wish list or a gift idea.');
      session=await api('/group/profile',{name:values.name,email:values.email,wishlist:values.wishlist,message:values.message,gifts});
      document.querySelector('#logout').hidden=false;
      group=await api('/group/profile');await sendLetter(form,alreadySubmitted);familyUpdated=alreadySubmitted;familyEditing=false;renderGroup();focusFamilyHeading();return;
    }
    if(type==='wishlist'){
      const gifts=formGifts(form);
      if(!values.wishlist.trim()&&!gifts.length)throw new Error('Add a wish list or a gift idea.');
      await api('/member/profile',{wishlist:values.wishlist,message:values.message,gifts});member=await api('/member/profile');await sendLetter(form,alreadySubmitted);familyUpdated=alreadySubmitted;familyEditing=false;renderMember();focusFamilyHeading();return;
    }
    dialog.close();await loadAdmin();notice('Saved.');
  }catch(error){
    if(familyForm){
      const message=form.querySelector('[data-form-error]');message.textContent=error.message;message.hidden=false;message.focus();
      if(!values.wishlist.trim()&&!formGifts(form).length)form.elements.wishlist.setAttribute('aria-invalid','true');
    }else if(dialog.contains(form)){
      const message=dialog.querySelector('[data-dialog-error]');message.textContent=error.message;message.hidden=false;message.focus();
    }else notice(error.message,true);
  }finally{working=false;if(familyForm)form.removeAttribute('aria-busy');if(button){button.disabled=type==='invite-people'&&!form.querySelector('input[name="recipient"]:checked:not(:disabled)');if(familyForm)button.innerHTML=buttonText;}}

});

async function boot() {
  if(location.pathname==='/join'||location.hash.startsWith('#group-'))preloadFamilyArtwork();
  try {
    if(location.pathname==='/'&&location.hash.startsWith('#group-')){const token=location.hash.slice(7);history.replaceState(null,'','/');session=await api('/group/redeem',{token});}
    else if(location.pathname==='/join'&&location.hash.length>1){const token=location.hash.slice(1);history.replaceState(null,'','/join');session=await api('/redeem',{token});}
    else try{session=await api('/session');}catch{session=null;}
    document.querySelector('#logout').hidden=!session;
    if(location.pathname==='/join') {
      if(session?.role==='member'){member=await api('/member/profile');renderMember();}
      else app.innerHTML=`<section class="login-card"><h1>Your wish list</h1><p>Enter your email for a sign-in link.</p>${signInForm()}</section>`;
    } else if(location.pathname==='/admin') {if(session?.role==='admin')await loadAdmin();else login();}
    else if(['group','submission'].includes(session?.role)){preloadFamilyArtwork();group=await api('/group/profile');renderGroup();}
    else home();
  }catch(error){app.innerHTML=`<section class="login-card"><h1>Link unavailable</h1><p>${esc(error.message)}</p><a href="/" class="text-link">Back to Ornament</a></section>`;}
}
// A replacement invitation may open in a tab already on /join. Start a new page
// so the new token is redeemed and earlier form/reveal state cannot carry over.
window.addEventListener('hashchange',()=>{
  if(location.pathname==='/join'&&location.hash.length>1 || location.pathname==='/'&&location.hash.startsWith('#group-'))location.reload();
});
boot();
