import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openDatabase, importHistory, members } from '../src/database.js';
import { createExchange, savePerson, inviteLink, draftDraw, lockDraw, prepareMail, matchingOptions } from '../src/service.js';
import { passwordHash, readConfig } from '../src/security.js';
import { createApp } from '../src/server.js';
import { savePartners, resetPreview } from '../src/exchange-management.js';
import { generateDraw, validateDraw } from '../src/matching.js';
import { createMailer } from '../src/mail.js';
import { prepareSignIn, expireSignIns } from '../src/signin.js';
import { hash } from '../src/security.js';
import { validateWishlist } from '../src/validation.js';
import nodemailer from 'nodemailer';

async function fixture(t,{emailMode='preview',transport}={}) {
  const dir=mkdtempSync(join(tmpdir(),'santa-test-'));
  const db=openDatabase(dir);
  const config=readConfig({ADMIN_PASSWORD_HASH:passwordHash('a-valid-test-password'),DATA_DIR:dir,EMAIL_MODE:emailMode});
  const server=createApp(config,db,transport).listen(0,'127.0.0.1');await once(server,'listening');
  config.publicUrl=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.close();server.closeAllConnections();await once(server,'close');db.close();rmSync(dir,{recursive:true,force:true});});
  const call=async(path,body,auth={})=>{
    const response=await fetch(`${config.publicUrl}/api${path}`,{method:body===undefined?'GET':'POST',
      headers:{'Content-Type':'application/json',Origin:config.publicUrl,...(auth.cookie?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...auth.headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=await call('/login',{password:'a-valid-test-password'});
  const admin={cookie:login.cookie,csrf:login.data.csrf};
  return {db,config,call,admin,dir};
}
function history(year,offset=1,names=Array.from({length:10},(_,i)=>`Person ${i}`)) {
  return {year,status:'verified',source:'Test fixture',assignments:names.map((giver,i)=>({giver,recipient:names[(i+offset)%names.length]}))};
}
function seed(db,status='verified') {
  importHistory(db,history(2024,1));importHistory(db,{...history(2025,2),status});
  createExchange(db,2026,2025);
  for(const p of members(db,2026)){savePerson(db,2026,{...p,email:`person-${p.id}@example.test`,active:true});db.prepare("UPDATE enrollments SET wishlist='A book' WHERE year=2026 AND person_id=?").run(p.id);}
}

test('matching diagnostics use the active roster without altering open, draft, finalized, or email records',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const inactive=members(db,2026).at(-1);savePerson(db,2026,{...inactive,active:false});
  prepareMail(db,config,2026,'invite');
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  const verify=async()=>{
    const before=snapshot();
    const response=await call('/admin/matching-test',{year:2026,draws:1000000},admin);
    assert.equal(response.status,200);assert.equal(response.data.status,'passed');
    assert.equal(response.data.participants,9);assert.equal(response.data.requested,100);assert.equal(response.data.checked,100);
    assert.equal(response.data.assignments,undefined);assert.equal(response.data.pairs,undefined);
    for(const p of members(db,2026))for(const value of [p.id,p.name,p.email,p.wishlist])assert.equal(JSON.stringify(response.data).includes(value),false);
    assert.equal(snapshot(),before);
  };
  await verify();
  draftDraw(db,2026);await verify();
  lockDraw(db,2026);prepareMail(db,config,2026,'assignment');await verify();
});

test('matching diagnostics require organizer authentication, origin and CSRF, and limit repeated runs',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  assert.equal((await call('/admin/matching-test',{year:2026})).status,403);
  assert.equal((await call('/admin/matching-test',{year:2026},{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/matching-test',{year:2026},{...admin,headers:{Origin:'https://attacker.test'}})).status,403);
  const link=inviteLink(db,config,2026,members(db,2026)[0].id),redeemed=await call('/redeem',{token:new URL(link).hash.slice(1)});
  assert.equal((await call('/admin/matching-test',{year:2026},{cookie:redeemed.cookie,csrf:redeemed.data.csrf})).status,403);
  for(let i=0;i<5;i++)assert.equal((await call('/admin/matching-test',{year:2026},admin)).status,200);
  assert.equal((await call('/admin/matching-test',{year:2026},admin)).status,429);
});

test('past years are history-only and cannot be used as matchmaking test years',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const state=(await call('/admin/state',undefined,admin)).data;
  assert.equal(state.year,2026);assert.deepEqual(state.currentYears,[2026]);
  assert.deepEqual(state.historyYears,[2025,2024]);
  assert.equal((await call('/admin/exchanges',{year:2023},admin)).status,400);
  assert.equal(db.prepare('SELECT year FROM exchanges WHERE year=2023').get(),undefined);
  for(const year of [2024,2025]) {
    const before=JSON.stringify(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all());
    const report=await call('/admin/matching-test',{year,showPairings:true,confirm:'REVEAL'},admin);
    assert.equal(report.status,400);assert.match(report.data.error,/Past years are history records/);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all()),before);
  }
  db.prepare("UPDATE exchanges SET state='locked' WHERE year=2025").run();
  assert.equal((await call('/admin/matching-test',{year:2025},admin)).status,400);
  assert.deepEqual((await call('/admin/state',undefined,admin)).data.currentYears,[2026]);
});

test('historical review is explicit, excludes private submissions and current matches, and confirms the requested year',async t=>{
  const {db,call,admin}=await fixture(t);seed(db,'provisional');draftDraw(db,2026);
  assert.equal((await call('/admin/history/record?year=2025')).status,403);
  const record=(await call('/admin/history/record?year=2025',undefined,admin)).data;
  assert.equal(record.year,2025);assert.equal(record.pairs.length,10);assert.equal(record.canConfirm,true);
  assert.deepEqual(Object.keys(record.pairs[0]).sort(),['giver','recipient']);
  for(const person of members(db,2026))for(const value of [person.email,person.wishlist])assert.equal(JSON.stringify(record).includes(value),false);
  assert.equal((await call('/admin/history/record?year=2026',undefined,admin)).status,400);
  const missing=(await call('/admin/history/record?year=2023',undefined,admin)).data;
  assert.equal(missing.exists,false);assert.equal(missing.canConfirm,false);assert.deepEqual(missing.pairs,[]);
  assert.equal((await call('/admin/history/confirm',{year:2025},{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/history/confirm',{year:2025},admin)).status,200);
  const state=(await call('/admin/state',undefined,admin)).data;
  assert.equal(state.year,2026);assert.equal(state.exchange.state,'open');
  assert.ok(state.history.every(h=>h.status==='verified'));
  assert.equal((await call('/admin/history/record?year=2025',undefined,admin)).data.canConfirm,false);
  db.prepare("INSERT INTO people(id,name) VALUES ('missing-historical-person','Missing Guest')").run();
  db.prepare("INSERT INTO enrollments(year,person_id) VALUES (2025,'missing-historical-person')").run();
  assert.equal((await call('/admin/state',undefined,admin)).data.history[0].status,'incomplete');
  assert.equal((await call('/admin/history/record?year=2025',undefined,admin)).data.status,'incomplete');
  assert.equal((await call('/admin/history/confirm',{year:2025},admin)).status,400);
});

test('current test pairings never repeat recorded recent pairs when a former participant leaves and a member is renamed',async t=>{
  const {db,call,admin}=await fixture(t);
  const names=Array.from({length:11},(_,i)=>`Guest ${i+1}`);
  importHistory(db,history(2024,1,names));importHistory(db,history(2025,2,names.slice(0,10)));
  createExchange(db,2026,2025);
  const first=members(db,2026)[0];savePerson(db,2026,{...first,name:'Updated Guest',active:true});
  const previous=new Set(db.prepare('SELECT giver,recipient FROM assignments WHERE year IN (2024,2025)').all().map(p=>JSON.stringify([p.giver,p.recipient])));
  const before=JSON.stringify(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all());
  const report=await call('/admin/matching-test',{year:2026,showPairings:true,confirm:'REVEAL'},admin);
  assert.equal(report.status,200);assert.equal(report.data.year,2026);assert.equal(report.data.checked,100);
  assert.deepEqual(report.data.history.map(h=>h.year),[2025,2024]);
  for(const draw of report.data.testDraws)for(const pair of draw)assert.equal(previous.has(JSON.stringify([pair.giver,pair.recipient])),false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all()),before);
  assert.equal((await call('/admin/state',undefined,admin)).data.people.length,10);
  assert.equal((await call('/admin/history/record?year=2024',undefined,admin)).data.pairs.length,11);
});

test('explicit test pairing results show every validated draw without changing open, draft, finalized or mail data',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const [a,b,inactive]=members(db,2026);savePartners(db,2026,{first:a.id,second:b.id});
  savePerson(db,2026,{...inactive,active:false});prepareMail(db,config,2026,'invite');
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  const verify=async()=>{
    const before=snapshot(),people=members(db,2026).filter(p=>p.active),options=matchingOptions(db,2026);
    const response=await call('/admin/matching-test',{year:2026,showPairings:true,confirm:'REVEAL',draws:1000000},admin);
    assert.equal(response.status,200);assert.equal(response.data.status,'passed');
    assert.equal(response.data.checked,100);assert.equal(response.data.testDraws.length,100);
    for(const pairs of response.data.testDraws){
      assert.deepEqual(validateDraw(pairs,people.map(p=>p.id),options),[]);
      assert.equal(pairs.length,9);assert.ok(pairs.every(p=>p.giver!==inactive.id&&p.recipient!==inactive.id));
      assert.ok(!pairs.some(p=>p.giver===a.id&&p.recipient===b.id||p.giver===b.id&&p.recipient===a.id));
      for(const pair of pairs)assert.deepEqual(Object.keys(pair).sort(),['giver','recipient']);
    }
    const text=JSON.stringify(response.data);
    for(const p of people)for(const privateValue of [p.email,p.wishlist])assert.equal(text.includes(privateValue),false);
    assert.equal(response.data.assignments,undefined);assert.equal(snapshot(),before);
  };
  await verify();draftDraw(db,2026);await verify();lockDraw(db,2026);prepareMail(db,config,2026,'assignment');await verify();
});

test('test pairings need deliberate organizer access and never expose invalid or impossible draws',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const body={year:2026,showPairings:true,confirm:'REVEAL'};
  assert.equal((await call('/admin/matching-test',body)).status,403);
  assert.equal((await call('/admin/matching-test',body,{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/matching-test',body,{...admin,headers:{Origin:'https://attacker.test'}})).status,403);
  const redeemed=await call('/redeem',{token:new URL(inviteLink(db,config,2026,members(db,2026)[0].id)).hash.slice(1)});
  assert.equal((await call('/admin/matching-test',body,{cookie:redeemed.cookie,csrf:redeemed.data.csrf})).status,403);
  const rejected=await call('/admin/matching-test',{year:2026,showPairings:true},admin);
  assert.equal(rejected.status,400);assert.equal(rejected.data.testDraws,undefined);
  const normal=await call('/admin/matching-test',{year:2026,showPairings:'true',confirm:'REVEAL'},admin);
  assert.equal(normal.status,200);assert.equal(normal.data.testDraws,undefined);
  const people=members(db,2026);
  for(const p of people.slice(1))db.prepare('INSERT INTO exclusions(year,giver,recipient) VALUES (2026,?,?)').run(people[0].id,p.id);
  const impossible=await call('/admin/matching-test',body,admin);
  assert.equal(impossible.data.status,'impossible');assert.deepEqual(impossible.data.testDraws,[]);
  createExchange(db,2027);
  db.prepare('UPDATE enrollments SET active=0 WHERE year=2027').run();
  const invalid=await call('/admin/matching-test',{...body,year:2027},admin);
  assert.equal(invalid.data.status,'invalid');assert.deepEqual(invalid.data.testDraws,[]);
});

test('matching diagnostics report impossible rules and unconfirmed history without relaxing rules',async t=>{
  const {db,call,admin}=await fixture(t);seed(db,'provisional');
  const people=members(db,2026);
  for(const recipient of people.filter(p=>p.id!==people[0].id))db.prepare('INSERT INTO exclusions(year,giver,recipient) VALUES (?,?,?)').run(2026,people[0].id,recipient.id);
  const response=await call('/admin/matching-test',{year:2026},admin);
  assert.equal(response.status,200);assert.equal(response.data.status,'impossible');assert.equal(response.data.checked,0);
  assert.match(response.data.issues[0],/none were relaxed/);
  assert.equal(response.data.history.find(h=>h.year===2025).status,'provisional');
  assert.equal(db.prepare('SELECT count(*) AS n FROM assignments WHERE year=2026').get().n,0);
  assert.equal(db.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'open');
});

test('extra exclusions enforce one direction alongside partners in tests, drafts and finalization without exposing the draw',async t=>{
  let sends=0;const {db,config,call,admin}=await fixture(t,{transport:{async sendMail(){sends++;throw new Error('No delivery during rule changes.');}}});seed(db);
  const people=members(db,2026),giver=people[0],recipient=people[3],body={year:2026,giver:giver.id,recipient:recipient.id};
  savePartners(db,2026,{first:giver.id,second:people[5].id});savePartners(db,2026,{first:recipient.id,second:people[8].id});
  prepareMail(db,config,2026,'invite');draftDraw(db,2026);
  const before={people:db.prepare('SELECT * FROM people ORDER BY id').all(),lists:db.prepare('SELECT * FROM enrollments ORDER BY year,person_id').all(),partners:db.prepare('SELECT * FROM partners ORDER BY year,first').all(),mail:db.prepare('SELECT * FROM outbox ORDER BY id').all(),history:db.prepare('SELECT * FROM assignments WHERE year<2026 ORDER BY year,giver').all()};
  assert.equal((await call('/admin/exclusions',body,admin)).data.changed,true);
  let state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal(state.exchange.state,'open');assert.deepEqual(state.assignments,[]);assert.equal(state.draw.count,0);
  assert.deepEqual(state.extraExclusions,[{giver:giver.id,recipient:recipient.id}]);assert.equal(state.partners.length,2);
  const report=await call('/admin/matching-test',{year:2026},admin);
  assert.equal(report.data.status,'passed');assert.equal(report.data.checked,100);assert.equal(report.data.testDraws,undefined);
  assert.ok(report.data.rules.includes('Saved exclusions respected'));
  for(const person of people)for(const value of [person.id,person.name,person.email,person.wishlist])assert.equal(JSON.stringify(report.data).includes(value),false);
  const shown=await call('/admin/matching-test',{year:2026,showPairings:true,confirm:'REVEAL'},admin);
  for(const pairs of shown.data.testDraws)assert.equal(pairs.some(p=>p.giver===giver.id&&p.recipient===recipient.id),false);
  const reverseAllowed=people.map((p,i)=>({giver:p.id,recipient:people[(i+7)%10].id}));
  assert.ok(reverseAllowed.some(p=>p.giver===recipient.id&&p.recipient===giver.id));assert.deepEqual(validateDraw(reverseAllowed,people.map(p=>p.id),matchingOptions(db,2026)),[]);
  assert.equal((await call('/admin/draft',{year:2026},admin)).status,200);
  // A stale or tampered draft must be rechecked before finalization.
  db.prepare('DELETE FROM assignments WHERE year=2026').run();
  for(const [i,p] of people.entries())db.prepare('INSERT INTO assignments(year,giver,recipient) VALUES (2026,?,?)').run(p.id,people[(i+3)%10].id);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,400);
  assert.equal((await call('/admin/draft',{year:2026},admin)).status,200);
  state=(await call('/admin/state?year=2026',undefined,admin)).data;assert.deepEqual(state.assignments,[]);assert.equal(state.draw.passed,true);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,200);
  const finalized=db.prepare('SELECT * FROM assignments WHERE year=2026 ORDER BY giver').all();
  for(const remove of [false,true])assert.equal((await call('/admin/exclusions',{...body,remove},admin)).status,400);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year=2026 ORDER BY giver').all(),finalized);
  assert.deepEqual(db.prepare('SELECT * FROM people ORDER BY id').all(),before.people);assert.deepEqual(db.prepare('SELECT * FROM enrollments ORDER BY year,person_id').all(),before.lists);
  assert.deepEqual(db.prepare('SELECT * FROM partners ORDER BY year,first').all(),before.partners);assert.deepEqual(db.prepare('SELECT * FROM outbox ORDER BY id').all(),before.mail);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year<2026 ORDER BY year,giver').all(),before.history);assert.equal(sends,0);
});

test('extra exclusions require organizer review and valid roster members; only actual rule changes invalidate drafts',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);const people=members(db,2026),body={year:2026,giver:people[0].id,recipient:people[3].id};
  draftDraw(db,2026);const before=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  for(const auth of [{},{...admin,csrf:'wrong'},{...admin,headers:{Origin:'https://attacker.test'}}])assert.equal((await call('/admin/exclusions',body,auth)).status,403);
  for(const invalid of [{giver:body.recipient},{recipient:'unknown'},{year:2025},{remove:'true'},{bothDirections:true}])assert.equal((await call('/admin/exclusions',{...body,...invalid},admin)).status,400);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),before);assert.equal(db.prepare('SELECT count(*) AS n FROM exclusions').get().n,0);
  assert.equal((await call('/admin/exclusions',body,admin)).data.changed,true);draftDraw(db,2026);
  const draft=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  assert.equal((await call('/admin/exclusions',body,admin)).data.changed,false);assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),draft);
  assert.equal((await call('/admin/exclusions',{...body,remove:true},admin)).data.changed,true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM assignments WHERE year=2026').get().n,0);draftDraw(db,2026);
  const unchanged=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  assert.equal((await call('/admin/exclusions',{...body,remove:true},admin)).data.changed,false);assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),unchanged);
});

test('extra exclusions survive reopening and explicit test resets but remain specific to their exchange year',async t=>{
  const {db,dir,call,admin}=await fixture(t);seed(db);const people=members(db,2026),body={year:2026,giver:people[0].id,recipient:people[3].id};
  assert.equal((await call('/admin/exclusions',body,admin)).status,200);
  const reopened=openDatabase(dir);
  try {assert.equal(reopened.prepare('SELECT count(*) AS n FROM exclusions WHERE year=2026').get().n,1);}finally{reopened.close();}
  createExchange(db,2027);assert.equal(db.prepare('SELECT count(*) AS n FROM exclusions WHERE year=2027').get().n,0);
  const state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal((await call('/admin/reset',{year:2026,confirm:'RESET 2026',review:state.reset.review},admin)).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM exclusions WHERE year=2026').get().n,1);
});

test('unmarked pairs may be mutual when the two-year history allows them',async t=>{
  const {db,call,admin}=await fixture(t),names=['Alex','Jamie','Casey','Morgan'];
  importHistory(db,history(2024,1,names));importHistory(db,history(2025,3,names));createExchange(db,2026);
  const people=members(db,2026),personByName=name=>people.find(p=>p.name===name);
  for(const [i,p] of people.entries()) {
    savePerson(db,2026,{...p,email:`member-${i}@example.test`});
    db.prepare("UPDATE enrollments SET wishlist='A book' WHERE year=2026 AND person_id=?").run(p.id);
  }
  assert.equal(db.prepare('SELECT no_reciprocal FROM exchanges WHERE year=2026').get().no_reciprocal,0);
  assert.equal((await call('/admin/settings',{year:2026,title:'Synthetic family',noReciprocal:true},admin)).status,200);
  assert.equal(db.prepare('SELECT no_reciprocal FROM exchanges WHERE year=2026').get().no_reciprocal,0);
  assert.equal((await call('/admin/exclusions',{year:2026,giver:personByName('Alex').id,recipient:personByName('Casey').id,bothDirections:true},admin)).status,400);
  const report=await call('/admin/matching-test',{year:2026},admin);
  assert.equal(report.data.status,'passed');assert.equal(report.data.checked,100);
  assert.ok(report.data.rules.includes('Marked partners cannot draw each other'));
  assert.equal((await call('/admin/draft',{year:2026},admin)).status,200);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,200);
  const pairs=db.prepare('SELECT giver,recipient FROM assignments WHERE year=2026').all();
  for(const [i,name] of names.entries())assert.equal(pairs.find(p=>p.giver===personByName(name).id).recipient,personByName(names[(i+2)%4]).id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal((await call('/admin/settings',{year:2026,title:'Cannot change finalized'},admin)).status,400);
});

test('organizer login, CSRF, and origin restrictions protect private admin data',async t=>{
  const {call,admin}=await fixture(t);
  assert.equal((await call('/admin/state')).status,403);
  assert.equal((await call('/admin/exchanges',{year:2026},{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/exchanges',{year:2026},{...admin,headers:{Origin:'https://attacker.test'}})).status,403);
  assert.equal((await call('/login',{password:'wrong'})).status,401);
  assert.equal((await call('/admin/exchanges',{year:2026},admin)).status,200);
});

test('reviewed invitation dispatch sends only selected waiting members and preserves other delivery records',async t=>{
  const sent=[],transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const people=members(db,2026);
  for(const p of people.slice(0,6))db.prepare("UPDATE enrollments SET wishlist='' WHERE year=2026 AND person_id=?").run(p.id);
  for(const [i,status] of [[2,'failed'],[3,'uncertain'],[4,'sent'],[5,'pending']])db.prepare('INSERT INTO outbox(id,year,giver,kind,recipient_email,subject,body,status) VALUES (?,2026,?,\'invite\',?,\'Test\',\'Private test body\',?)').run(`existing-invite-${i}`,people[i].id,people[i].email,status);
  for(const [kind,id] of [['assignment','queued-assignment'],['revision:test','queued-revision']])db.prepare("INSERT INTO outbox(id,year,giver,kind,recipient_email,subject,body) VALUES (?,2026,?,?,?,'Test','Private other message')").run(id,people[6].id,kind,people[6].email);
  prepareSignIn(db,config,people[7].email);
  const before=db.prepare('SELECT * FROM outbox ORDER BY id').all();
  const recipients=people.slice(0,2).map(p=>({id:p.id,email:p.email}));
  const response=await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients},admin);
  assert.equal(response.status,200);assert.equal(response.data.count,2);assert.equal(response.data.counts.sent,2);
  assert.deepEqual(sent.map(m=>m.to).sort(),recipients.map(p=>p.email).sort());
  for(const row of before)assert.deepEqual(db.prepare('SELECT * FROM outbox WHERE id=?').get(row.id),row);
  for(const p of people.slice(0,2)) {
    const mail=db.prepare("SELECT * FROM outbox WHERE year=2026 AND giver=? AND kind='invite'").get(p.id);
    assert.equal(mail.status,'sent');assert.ok(mail.body.includes('/join#'));
    assert.ok(db.prepare('SELECT expires FROM invite_tokens WHERE year=2026 AND person_id=?').get(p.id).expires>Date.now()+47*3600000);
  }
  assert.equal((await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients},admin)).status,400);
  assert.equal(sent.length,2);
});

test('correcting a dispatched address enables only that invitation, retires old access and preserves sent records and drafts',async t=>{
  const sent=[],transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const people=members(db,2026),person=people[0];
  db.prepare("UPDATE enrollments SET wishlist='' WHERE year=2026").run();
  assert.equal((await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients:people.map(p=>({id:p.id,email:p.email}))},admin)).data.counts.sent,10);
  const original=db.prepare("SELECT * FROM outbox WHERE kind='invite' ORDER BY giver").all();
  const oldLink=sent.find(mail=>mail.to===person.email).text.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0];
  const oldOwner=authFrom(await call('/redeem',{token:new URL(oldLink).hash.slice(1)}));
  const unused=inviteLink(db,config,2026,person.id),signin=prepareSignIn(db,config,person.email),signinLink=signInToken(db,signin).token;
  draftDraw(db,2026);const draw=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  const corrected={...person,year:2026,email:'corrected-guest@example.test'};
  assert.equal((await call('/admin/people',corrected,admin)).status,200);assert.equal(sent.length,10,'Editing never sends email');
  assert.equal((await call('/member/profile',undefined,oldOwner)).status,403);
  assert.equal((await call('/redeem',{token:new URL(unused).hash.slice(1)})).status,401);
  assert.equal((await call('/redeem',{token:signinLink})).status,401);
  const state=(await call('/admin/state',undefined,admin)).data;
  assert.deepEqual(state.people.filter(p=>p.invitation.canSend).map(p=>p.id),[person.id]);
  const updated=state.people.find(p=>p.id===person.id);assert.equal(updated.invitation.addressChanged,true);assert.equal(updated.invitation.canResend,true);
  const response=await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients:[{id:person.id,email:corrected.email,invitationId:updated.invitation.id}]},admin);
  assert.equal(response.status,200);assert.equal(response.data.counts.sent,1);assert.equal(sent.length,11);assert.equal(sent.at(-1).to,corrected.email);
  assert.deepEqual(db.prepare("SELECT * FROM outbox WHERE kind='invite' ORDER BY giver").all(),original);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),draw);
  assert.equal(db.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'drafted');
  assert.equal((await call('/admin/state',undefined,admin)).data.people.some(p=>p.invitation.canSend),false);
});

test('per-person resends replace expired or lost invitations with fresh access while keeping saved lists and every prior delivery',async t=>{
  const sent=[],transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const person=members(db,2026)[0];prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent',sent_at='2026-01-01',attempts=1 WHERE kind='invite'").run();
  db.prepare('UPDATE invite_tokens SET expires=? WHERE person_id=?').run(Date.now()-1,person.id);
  const before=db.prepare('SELECT * FROM outbox ORDER BY id').all(),profile=members(db,2026).find(p=>p.id===person.id);
  const current=()=>(db.prepare("SELECT id FROM outbox WHERE giver=? AND (kind='invite' OR kind LIKE 'invite-resend:%') ORDER BY rowid DESC LIMIT 1").get(person.id).id);
  const request={year:2026,confirm:'RESEND',recipient:{id:person.id,email:person.email,invitationId:current()}};
  const result=await call('/admin/invitations/resend',request,admin);assert.equal(result.status,200);assert.equal(result.data.counts.sent,1);
  assert.equal((await call('/admin/invitations/resend',request,admin)).status,400,'A replay cannot send another invitation');
  const first=sent[0].text.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0];
  const token=db.prepare('SELECT * FROM invite_tokens WHERE person_id=?').get(person.id);assert.equal(token.fresh_start,0);assert.ok(token.expires>Date.now()+47*3600000);
  assert.equal((await call('/admin/invitations/resend',{...request,recipient:{...request.recipient,invitationId:current()}},admin)).status,200);
  assert.equal((await call('/redeem',{token:new URL(first).hash.slice(1)})).status,401,'A new resend retires the earlier unconsumed link');
  const latest=sent.at(-1).text.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0],owner=authFrom(await call('/redeem',{token:new URL(latest).hash.slice(1)}));
  const saved=await call('/member/profile',undefined,owner);assert.equal(saved.status,200);assert.equal(saved.data.person.wishlist,profile.wishlist);
  assert.deepEqual(members(db,2026).find(p=>p.id===person.id),profile);
  assert.equal(sent.length,2);assert.ok(sent.every(mail=>mail.to===person.email));
  for(const row of before)assert.deepEqual(db.prepare('SELECT * FROM outbox WHERE id=?').get(row.id),row);
});

test('resends require recipient review and organizer permissions and block uncertain, pending, inactive and finalized cases',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);const person=members(db,2026)[0];
  prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent' WHERE kind='invite'").run();
  const prior=db.prepare("SELECT * FROM outbox WHERE kind='invite' AND giver=?").get(person.id);
  const request={year:2026,confirm:'RESEND',recipient:{id:person.id,email:person.email,invitationId:prior.id}};
  for(const auth of [{},{...admin,csrf:'wrong'},{...admin,headers:{Origin:'https://attacker.test'}}])assert.equal((await call('/admin/invitations/resend',request,auth)).status,403);
  for(const body of [{...request,confirm:'SEND'},{...request,recipient:undefined},{...request,recipient:{...request.recipient,email:'stale@example.test'}},{...request,recipient:{...request.recipient,invitationId:'stale'}}])assert.equal((await call('/admin/invitations/resend',body,admin)).status,400);
  for(const [kind,status] of [['invite-resend:waiting','pending'],['invite-resend:waiting','uncertain'],['test-invite:waiting','uncertain']]) {
    db.prepare("INSERT INTO outbox(id,year,giver,kind,recipient_email,subject,body,status) VALUES ('blocked',2026,?,?,?,'Test','Test',?)").run(person.id,kind,person.email,status);
    assert.equal((await call('/admin/invitations/resend',request,admin)).status,400);
    db.prepare("DELETE FROM outbox WHERE id='blocked'").run();
  }
  db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(prior.id);
  assert.equal((await call('/admin/invitations/resend',request,admin)).status,400);
  db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(prior.id);
  await call('/admin/participation',{year:2026,id:person.id,active:false},admin);
  assert.equal((await call('/admin/invitations/resend',request,admin)).status,400);
  await call('/admin/participation',{year:2026,id:person.id,active:true},admin);draftDraw(db,2026);lockDraw(db,2026);
  assert.equal((await call('/admin/invitations/resend',request,admin)).status,400);
  assert.deepEqual(db.prepare('SELECT * FROM outbox WHERE id=?').get(prior.id),prior);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'invite-resend:%'").get().n,0);
});

test('preview resends send nothing and retain the same pending resend record when dispatched later',async t=>{
  let sends=0;const {db,config,call,admin}=await fixture(t,{transport:{async sendMail(){sends++;throw new Error('No real SMTP in preview.');}}});seed(db);
  const person=members(db,2026)[0];prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent' WHERE kind='invite'").run();
  const prior=db.prepare("SELECT id FROM outbox WHERE giver=? AND kind='invite'").get(person.id);
  const request={year:2026,confirm:'RESEND',recipient:{id:person.id,email:person.email,invitationId:prior.id}};
  assert.equal((await call('/admin/invitations/resend',request,admin)).data.counts.preview,1);assert.equal(sends,0);
  const resend=db.prepare("SELECT * FROM outbox WHERE kind LIKE 'invite-resend:%'").get();
  assert.equal((await call('/admin/mail/retry',{id:resend.id},admin)).status,200);
  db.prepare('UPDATE invite_tokens SET expires=? WHERE person_id=?').run(Date.now()-1,person.id);
  config.emailMode='smtp';config.smtp.from='sender@example.test';
  const messages=[],mailer=createMailer(db,config,{async sendMail(mail){messages.push(mail);return {accepted:[mail.to],rejected:[]};}});
  await mailer.deliver(2026,{mailIds:[resend.id]});assert.equal(messages.length,1);
  assert.ok(db.prepare('SELECT expires FROM invite_tokens WHERE person_id=?').get(person.id).expires>Date.now()+47*3600000);
  assert.equal(db.prepare('SELECT id,status FROM outbox WHERE id=?').get(resend.id).status,'sent');
});

test('resending an address corrected before the upgrade also retires old-owner access',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);const person=members(db,2026)[0];
  prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent' WHERE kind='invite'").run();
  const original=db.prepare("SELECT * FROM outbox WHERE kind='invite' AND giver=?").get(person.id);
  const owner=authFrom(await call('/redeem',{token:new URL(original.body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]).hash.slice(1)}));
  // Simulate a contact correction made by the previous application version.
  db.prepare('UPDATE people SET email=? WHERE id=?').run('already-corrected@example.test',person.id);
  assert.equal((await call('/member/profile',undefined,owner)).status,200);
  assert.equal((await call('/admin/invitations/resend',{year:2026,confirm:'RESEND',recipient:{id:person.id,email:'already-corrected@example.test',invitationId:original.id}},admin)).data.counts.preview,1);
  assert.equal((await call('/member/profile',undefined,owner)).status,403);
  assert.deepEqual(db.prepare('SELECT * FROM outbox WHERE id=?').get(original.id),original);
});

test('an in-flight resend blocks duplicate dispatch and address edits before any additional records are written',async t=>{
  let started,finish;const entered=new Promise(resolve=>started=resolve),release=new Promise(resolve=>finish=resolve);
  const transport={async sendMail(mail){started();await release;return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const person=members(db,2026)[0];prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent' WHERE kind='invite'").run();
  const prior=db.prepare("SELECT id FROM outbox WHERE giver=? AND kind='invite'").get(person.id),body={year:2026,confirm:'RESEND',recipient:{id:person.id,email:person.email,invitationId:prior.id}};
  const sending=call('/admin/invitations/resend',body,admin);await entered;
  try {
    assert.equal((await call('/admin/invitations/resend',body,admin)).status,400);
    assert.equal((await call('/admin/people',{...person,year:2026,email:'changed@example.test'},admin)).status,400);
    assert.equal((await call('/admin/contact',{id:person.id,year:2026,email:'changed@example.test'},admin)).status,400);
    assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'invite-resend:%'").get().n,1);
    assert.equal(members(db,2026).find(p=>p.id===person.id).email,person.email);
  } finally {finish();}
  assert.equal((await sending).data.counts.sent,1);
});

test('two selected test invitations do not require completing other people or change the roster',async t=>{
  const sent=[],transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const people=members(db,2026);
  db.prepare("UPDATE enrollments SET wishlist='' WHERE year=2026").run();
  for(const p of people.slice(3))db.prepare("UPDATE people SET email='' WHERE id=?").run(p.id);
  const snapshot=()=>JSON.stringify(['people','enrollments','exchanges','assignments'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before=snapshot(),recipients=people.slice(0,2).map(p=>({id:p.id,email:p.email}));
  const request={year:2026,confirm:'SEND',recipients};
  const invalid=await call('/admin/invitations/send',{...request,recipients:[...recipients,{id:people[3].id,email:''}]},admin);
  assert.equal(invalid.status,400);assert.match(invalid.data.error,/selected person/);
  assert.equal(sent.length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  const result=await call('/admin/invitations/send',request,admin);
  assert.equal(result.status,200);assert.equal(result.data.counts.sent,2);
  assert.deepEqual(sent.map(mail=>mail.to).sort(),recipients.map(p=>p.email).sort());
  assert.deepEqual(db.prepare("SELECT giver FROM outbox WHERE kind='invite' ORDER BY giver").all().map(row=>row.giver),recipients.map(p=>p.id).sort());
  assert.equal(db.prepare('SELECT count(*) AS n FROM invite_tokens').get().n,2);
  assert.equal(snapshot(),before);
  const state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal(state.people.length,10);assert.ok(state.people.every(p=>p.active));
  assert.equal(state.people.filter(p=>!p.email).length,7);
});

test('invitation dispatch requires recipient review and blocks changed addresses, submitted or inactive members',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const person=members(db,2026)[0];db.prepare("UPDATE enrollments SET wishlist='' WHERE year=2026 AND person_id=?").run(person.id);
  const body={year:2026,confirm:'SEND',recipients:[{id:person.id,email:person.email}]};
  assert.equal((await call('/admin/invitations/send',body)).status,403);
  assert.equal((await call('/admin/invitations/send',body,{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/invitations/send',{...body,confirm:''},admin)).status,400);
  assert.equal((await call('/admin/invitations/send',{...body,recipients:undefined},admin)).status,400);
  assert.equal((await call('/admin/invitations/send',{...body,recipients:[{id:person.id,email:'changed@example.test'}]},admin)).status,400);
  const completed=members(db,2026)[1];
  assert.equal((await call('/admin/invitations/send',{...body,recipients:[{id:completed.id,email:completed.email}]},admin)).status,400);
  assert.equal((await call('/admin/participation',{year:2026,id:person.id,active:false},admin)).status,200);
  assert.equal((await call('/admin/invitations/send',body,admin)).status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM invite_tokens').get().n,0);
});

test('the simple invitation flow previews without sending, and member submission updates private organizer status',async t=>{
  let sends=0;const transport={async sendMail(){sends++;throw new Error('Preview mode must not call SMTP.');}};
  const {db,config,call,admin}=await fixture(t,{transport});seed(db);
  const person=members(db,2026)[0];db.prepare("UPDATE enrollments SET wishlist='' WHERE year=2026 AND person_id=?").run(person.id);
  const recipients=[{id:person.id,email:person.email}];
  const result=await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients},admin);
  assert.equal(result.status,200);assert.equal(result.data.counts.preview,1);assert.equal(sends,0);
  let state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal(state.people.find(p=>p.id===person.id).validation.submitted,false);
  const mail=db.prepare("SELECT body FROM outbox WHERE year=2026 AND giver=? AND kind='invite'").get(person.id);
  const link=mail.body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0];
  const owner=authFrom(await call('/redeem',{token:new URL(link).hash.slice(1)}));
  assert.equal((await call('/member/profile',{wishlist:'Private new list',message:'Private note',gifts:[]},owner)).status,200);
  state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal(state.people.find(p=>p.id===person.id).validation.submitted,true);
  assert.equal(JSON.stringify(state).includes('Private new list'),false);assert.equal(JSON.stringify(state).includes('Private note'),false);
  assert.equal((await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients},admin)).status,400);
  assert.equal(sends,0);
});
test('fresh test invitations reach selected existing members and open blank forms without clearing saved lists',async t=>{
  const sent=[],transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const people=members(db,2026),recipients=people.slice(0,2).map(p=>({id:p.id,email:p.email}));
  db.prepare("UPDATE enrollments SET message='Original private note',gifts=? WHERE year=2026 AND person_id=?").run(JSON.stringify([{label:'Original gift',url:'https://example.test/gift'}]),people[0].id);
  prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent',sent_at='2026-01-01' WHERE kind='invite'").run();
  db.prepare("INSERT INTO outbox(id,year,giver,kind,recipient_email,subject,body) VALUES ('other-pending',2026,?,'revision:pending',?,'Other','Private other content')").run(people[2].id,people[2].email);
  const originalMail=db.prepare('SELECT * FROM outbox ORDER BY id').all(),originalLists=db.prepare('SELECT * FROM enrollments ORDER BY year,person_id').all();
  const history=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  const request={year:2026,confirm:'TEST',recipients};
  const result=await call('/admin/invitations/test',request,admin);
  assert.equal(result.status,200);assert.equal(result.data.counts.sent,2);
  assert.deepEqual(sent.map(mail=>mail.to).sort(),recipients.map(p=>p.email).sort());
  for(const row of originalMail)assert.deepEqual(db.prepare('SELECT * FROM outbox WHERE id=?').get(row.id),row);
  assert.deepEqual(db.prepare('SELECT * FROM enrollments ORDER BY year,person_id').all(),originalLists);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),history);
  const links=people.slice(0,2).map(p=>sent.find(mail=>mail.to===p.email).text.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]);
  assert.notEqual(links[0],links[1]);
  for(const p of people.slice(0,2))assert.ok(db.prepare('SELECT expires,fresh_start FROM invite_tokens WHERE year=2026 AND person_id=?').get(p.id).expires>Date.now()+47*3600000);
  const owner=authFrom(await call('/redeem',{token:new URL(links[0]).hash.slice(1)}));
  assert.equal((await call('/redeem',{token:new URL(links[0]).hash.slice(1)})).status,401);
  let profile=(await call('/member/profile',undefined,owner)).data;
  assert.equal(profile.freshStart,true);assert.equal(profile.person.wishlist,'');assert.equal(profile.person.message,'');assert.deepEqual(profile.person.gifts,[]);
  const original=members(db,2026).find(p=>p.id===people[0].id);
  assert.equal(original.wishlist,'A book');assert.equal(original.message,'Original private note');
  assert.equal((await call('/member/profile',{wishlist:'',gifts:[]},owner)).status,400);
  assert.equal(members(db,2026).find(p=>p.id===people[0].id).wishlist,'A book');
  assert.equal((await call('/member/profile',undefined,owner)).data.freshStart,true);
  assert.equal((await call('/member/profile',{wishlist:'New private test list',message:'New private note',gifts:[]},owner)).status,200);
  profile=(await call('/member/profile',undefined,owner)).data;
  assert.equal(profile.freshStart,false);assert.equal(profile.person.wishlist,'New private test list');
  assert.equal(members(db,2026).find(p=>p.id===people[1].id).wishlist,'A book');
  const state=(await call('/admin/state?year=2026',undefined,admin)).data;
  for(const privateText of ['New private test list','Original private note','New private note'])assert.equal(JSON.stringify(state).includes(privateText),false);
  const firstTest=db.prepare("SELECT * FROM outbox WHERE kind LIKE 'test-invite:%' ORDER BY id").all();
  assert.equal((await call('/admin/invitations/test',{...request,recipients:[recipients[0]]},admin)).status,200);
  assert.equal(sent.length,3);assert.notEqual(sent[2].text.match(/\/join#[A-Za-z0-9_-]+/)[0],new URL(links[0]).pathname+new URL(links[0]).hash);
  for(const row of firstTest)assert.deepEqual(db.prepare('SELECT * FROM outbox WHERE id=?').get(row.id),row);
});

test('fresh test invitation review enforces permissions, selected emails, uncertain-delivery review, and finalized protection',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const people=members(db,2026),recipients=people.slice(0,2).map(p=>({id:p.id,email:p.email})),body={year:2026,confirm:'TEST',recipients};
  assert.equal((await call('/admin/invitations/test',body)).status,403);
  assert.equal((await call('/admin/invitations/test',body,{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/invitations/test',body,{...admin,headers:{Origin:'https://example.test'}})).status,403);
  assert.equal((await call('/admin/invitations/test',{...body,confirm:'SEND'},admin)).status,400);
  assert.equal((await call('/admin/invitations/test',{...body,recipients:[]},admin)).status,400);
  assert.equal((await call('/admin/invitations/test',{...body,recipients:[recipients[0],recipients[0]]},admin)).status,400);
  assert.equal((await call('/admin/invitations/test',{...body,recipients:[{...recipients[0],email:'changed@example.test'}]},admin)).status,400);
  for(const [kind,status] of [['invite','uncertain'],['test-invite:old','pending'],['test-invite:old','uncertain'],['test-invite:old','sending']]) {
    db.prepare("INSERT INTO outbox(id,year,giver,kind,recipient_email,subject,body,status) VALUES ('blocked',2026,?,?,?,'Test','Private',?)").run(people[1].id,kind,people[1].email,status);
    assert.equal((await call('/admin/invitations/test',body,admin)).status,400);
    assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM invite_tokens').get().n,0);
    assert.equal(db.prepare("SELECT status FROM outbox WHERE id='blocked'").get().status,status);
    db.prepare("DELETE FROM outbox WHERE id='blocked'").run();
  }
  db.prepare('UPDATE enrollments SET active=0 WHERE year=2026 AND person_id=?').run(people[1].id);
  assert.equal((await call('/admin/invitations/test',body,admin)).status,400);
  db.prepare('UPDATE enrollments SET active=1 WHERE year=2026 AND person_id=?').run(people[1].id);
  assert.equal((await call('/admin/invitations/test',body,admin)).status,200);
  const mails=db.prepare("SELECT * FROM outbox WHERE kind LIKE 'test-invite:%' ORDER BY giver").all();
  const owner=authFrom(await call('/redeem',{token:new URL(mails[0].body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]).hash.slice(1)}));
  const unredeemed=new URL(mails[1].body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]).hash.slice(1);
  const lists=db.prepare('SELECT * FROM enrollments ORDER BY year,person_id').all();
  db.prepare("UPDATE exchanges SET state='locked' WHERE year=2026").run();
  assert.equal((await call('/admin/invitations/test',body,admin)).status,400);
  assert.equal((await call('/redeem',{token:unredeemed})).status,401);
  assert.equal((await call('/member/profile',undefined,owner)).status,403);
  assert.equal((await call('/member/profile',{wishlist:'Should not replace',gifts:[]},owner)).status,403);
  assert.equal((await call('/admin/mail/retry',{id:mails[0].id},admin)).status,400);
  assert.deepEqual(db.prepare('SELECT * FROM enrollments ORDER BY year,person_id').all(),lists);
});

test('fresh invitation previews send no email, expire, and only replace older access links for selected members',async t=>{
  let sends=0;const transport={async sendMail(){sends++;throw Error('Preview must not use SMTP.');}};
  const {db,config,call,admin}=await fixture(t,{transport});seed(db);
  const people=members(db,2026),old=people.slice(0,2).map(p=>new URL(inviteLink(db,config,2026,p.id)).hash.slice(1));
  const result=await call('/admin/invitations/test',{year:2026,confirm:'TEST',recipients:[{id:people[0].id,email:people[0].email}]},admin);
  assert.equal(result.status,200);assert.equal(result.data.counts.preview,1);assert.equal(sends,0);
  assert.equal((await call('/redeem',{token:old[0]})).status,401);
  assert.equal((await call('/redeem',{token:old[1]})).status,200);
  const mail=db.prepare("SELECT body FROM outbox WHERE kind LIKE 'test-invite:%'").get(),token=new URL(mail.body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]).hash.slice(1);
  db.prepare('UPDATE invite_tokens SET expires=? WHERE person_id=?').run(Date.now()-1,people[0].id);
  assert.equal((await call('/redeem',{token})).status,401);
  assert.ok(members(db,2026).every(p=>p.wishlist==='A book'));
});

test('fresh invitation schema upgrade keeps existing links, sessions, saved content and delivery records',async t=>{
  const {db,config,call,admin,dir}=await fixture(t);seed(db);const person=members(db,2026)[0];
  prepareMail(db,config,2026,'invite');db.prepare("UPDATE outbox SET status='sent'").run();
  const token=new URL(db.prepare("SELECT body FROM outbox WHERE giver=? AND kind='invite'").get(person.id).body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]).hash.slice(1);
  db.exec('ALTER TABLE invite_tokens DROP COLUMN fresh_start; ALTER TABLE sessions DROP COLUMN fresh_start');
  const snapshot=table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const before={tokens:snapshot('invite_tokens'),sessions:snapshot('sessions'),lists:snapshot('enrollments'),mail:snapshot('outbox')};
  const upgraded=openDatabase(dir);try{
    for(const [table,rows] of [['invite_tokens',before.tokens],['sessions',before.sessions]])assert.deepEqual(upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>{const {fresh_start,...rest}=row;assert.equal(fresh_start,0);return rest;}),rows.map(row=>({...row})));
    assert.deepEqual(upgraded.prepare('SELECT * FROM enrollments ORDER BY rowid').all(),before.lists);
    assert.deepEqual(upgraded.prepare('SELECT * FROM outbox ORDER BY rowid').all(),before.mail);
  }finally{upgraded.close();}
  assert.equal((await call('/admin/state?year=2026',undefined,admin)).status,200);
  const owner=authFrom(await call('/redeem',{token}));
  assert.equal((await call('/member/profile',undefined,owner)).data.freshStart,false);
});

test('artwork caching does not cache authenticated profiles or organizer data',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const artwork=readdirSync(new URL('../public/',import.meta.url)).filter(name=>name.endsWith('.webp'));
  assert.ok(artwork.length);
  const legacy=await fetch(`${config.publicUrl}/christmas-friends.png`,{redirect:'manual'});
  assert.equal(legacy.status,302);
  assert.ok(artwork.includes(legacy.headers.get('location').slice(1)));
  for(const file of artwork) {
    const image=await fetch(`${config.publicUrl}/${file}`);
    assert.equal(image.status,200);
    assert.equal(image.headers.get('content-type'),'image/webp');
    assert.equal(image.headers.get('cache-control'),'public, max-age=31536000, immutable');
    assert.equal(image.headers.get('set-cookie'),null);
    await image.arrayBuffer();
    const conditional=await fetch(`${config.publicUrl}/${file}`,{cache:'force-cache',headers:{'If-None-Match':image.headers.get('etag')}});
    assert.equal(conditional.status,304);
    assert.equal(conditional.headers.get('cache-control'),image.headers.get('cache-control'));
  }
  const link=inviteLink(db,config,2026,members(db,2026)[0].id);
  const member=await call('/redeem',{token:new URL(link).hash.slice(1)});
  for(const [path,cookie,status] of [
    ['/api/admin/state',admin.cookie,200],['/api/member/profile',member.cookie,200],
    ['/api/admin/state','',403],['/api/member/profile','',403],['/','',200],['/app.js','',200],
  ]) {
    const response=await fetch(`${config.publicUrl}${path}`,{headers:{Cookie:cookie}});
    assert.equal(response.status,status);
    assert.equal(response.headers.get('cache-control'),'no-store');
    await response.text();
  }
});
test('personal links scope access to one person, hide unfinalized recipients, and can be revoked',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const people=members(db,2026),person=people[0];
  draftDraw(db,2026);
  const link=inviteLink(db,config,2026,person.id);
  const redeemed=await call('/redeem',{token:new URL(link).hash.slice(1)});
  const member={cookie:redeemed.cookie,csrf:redeemed.data.csrf};
  const before=await call('/member/profile',undefined,member);
  assert.equal(before.data.recipient,null);assert.equal(before.data.person.name,person.name);
  assert.equal(JSON.stringify(before.data).includes(people[1].email),false);
  assert.equal((await call('/admin/state',undefined,member)).status,403);
  assert.equal((await call('/member/profile',{wishlist:'A book',gifts:[{label:'Bad',url:'javascript:alert(1)'}]},member)).status,400);
  assert.equal((await call('/member/profile',{wishlist:'A book',gifts:[{label:'Book',url:'https://example.test/book'}]},member)).status,200);
  lockDraw(db,2026);
  const after=await call('/member/profile',undefined,member);
  assert.ok(after.data.recipient);assert.deepEqual(Object.keys(after.data.recipient).sort(),['gifts','message','name','wishlist']);
  await call('/admin/revoke',{year:2026,personId:person.id},admin);
  assert.equal((await call('/member/profile',undefined,member)).status,403);
  assert.equal((await call('/redeem',{token:new URL(link).hash.slice(1)})).status,401);
});
test('tentative history permits drafts but blocks finalizing; roster changes discard stale drafts',async t=>{
  const {db,call,admin}=await fixture(t);seed(db,'provisional');draftDraw(db,2026);
  assert.throws(()=>lockDraw(db,2026),/Confirm the previous two years/);
  await call('/admin/history/confirm',{year:2025},admin);
  assert.equal(db.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'open');
  draftDraw(db,2026);const first=members(db,2026)[0];savePerson(db,2026,{...first,active:false});
  assert.equal(db.prepare('SELECT count(*) AS n FROM assignments WHERE year=2026').get().n,0);
});
test('imports reconcile alternate names and reject partial history transactionally',async t=>{
  const {db}=await fixture(t);
  importHistory(db,history(2024,1,['Alex','Jamie','Christopher']));
  importHistory(db,{...history(2025,1,['Alex','Jamie','Chris']),aliases:{Christopher:['Chris']},status:'provisional'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,3);
  const previous=db.prepare('SELECT * FROM assignments WHERE year=2025').all();
  assert.throws(()=>importHistory(db,{year:2025,assignments:[{giver:'Alex',recipient:'Jamie'},{giver:'Jamie',recipient:'Stranger'},{giver:'Chris',recipient:'Alex'}]}),/each person once/);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year=2025').all(),previous);
  assert.equal(db.prepare("SELECT count(*) AS n FROM people WHERE name='Stranger'").get().n,0);
});
test('a finalized draw persists after reopening SQLite and cannot be regenerated',async t=>{
  const {db,dir}=await fixture(t);seed(db);draftDraw(db,2026);lockDraw(db,2026);
  const saved=db.prepare('SELECT * FROM assignments WHERE year=2026').all();
  const another=openDatabase(dir);try{assert.deepEqual(another.prepare('SELECT * FROM assignments WHERE year=2026').all(),saved);}finally{another.close();}
  assert.throws(()=>draftDraw(db,2026),/finalized/);
});
test('email previews are durable and real sends skip already successful messages',async t=>{
  const {db,config}=await fixture(t);seed(db);draftDraw(db,2026);lockDraw(db,2026);
  prepareMail(db,config,2026,'assignment');prepareMail(db,config,2026,'assignment');
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,10);
  await createMailer(db,config).deliver(2026);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE status='preview'").get().n,10);
  db.prepare("UPDATE outbox SET status='pending'").run();
  let count=0;
  const smtp=createMailer(db,{...config,emailMode:'smtp'}, {async sendMail(mail){count++;return {accepted:[mail.to],rejected:[]};}});
  await smtp.deliver(2026);await smtp.deliver(2026);assert.equal(count,10);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE status='sent'").get().n,10);
});
test('SMTP ambiguity and process interruptions require review instead of automatic retries',async t=>{
  const {db,config,call,admin,dir}=await fixture(t);seed(db);prepareMail(db,config,2026,'invite');
  let count=0;
  const smtp=createMailer(db,{...config,emailMode:'smtp'},{async sendMail(){count++;throw Object.assign(new Error('Timeout'),{code:'ETIMEDOUT'});}});
  await smtp.deliver(2026);await smtp.deliver(2026);assert.equal(count,10);
  const mail=db.prepare('SELECT * FROM outbox LIMIT 1').get();
  assert.equal(mail.status,'uncertain');
  assert.equal((await call('/admin/mail/retry',{id:mail.id},admin)).status,400);
  assert.equal((await call('/admin/mail/retry',{id:mail.id,confirm:'CHECKED'},admin)).status,200);
  db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(mail.id);
  const reopened=openDatabase(dir);try{assert.equal(reopened.prepare('SELECT status FROM outbox WHERE id=?').get(mail.id).status,'uncertain');}finally{reopened.close();}
});
test('configuration requires strong password hashes and HTTPS for external hosting',()=>{
  assert.throws(()=>readConfig({}),/ADMIN_PASSWORD_HASH/);
  assert.throws(()=>readConfig({PUBLIC_URL:'http://santa.example.test',ADMIN_PASSWORD_HASH:passwordHash('a-valid-test-password')}),/HTTPS/);
  assert.throws(()=>readConfig({PUBLIC_URL:'https://santa.example.test/path',ADMIN_PASSWORD_HASH:passwordHash('a-valid-test-password')}),/origin/);
});

test('new families can explicitly confirm empty prior years without erasing existing history',async t=>{
  const {db,call,admin}=await fixture(t);
  createExchange(db,2026,null);
  for(let i=0;i<5;i++){const id=savePerson(db,2026,{name:`Guest ${i}`,email:`guest-${i}@example.test`});db.prepare("UPDATE enrollments SET wishlist='A book' WHERE year=2026 AND person_id=?").run(id);}
  for(const year of [2024,2025])assert.equal((await call('/admin/history/none',{year,confirm:'NO EXCHANGE'},admin)).status,200);
  draftDraw(db,2026);lockDraw(db,2026);
  assert.equal((await call('/admin/history/none',{year:2026,confirm:'NO EXCHANGE'},admin)).status,400);
  assert.equal((await call('/admin/history/none',{year:2023,confirm:'wrong'},admin)).status,400);
});

test('correcting an email after finalization preserves the draw and updates unsent messages',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);draftDraw(db,2026);lockDraw(db,2026);
  prepareMail(db,config,2026,'assignment');
  const before=db.prepare('SELECT * FROM assignments WHERE year=2026').all();
  const person=members(db,2026)[0];
  assert.equal((await call('/admin/contact',{year:2026,id:person.id,email:'corrected@example.test'},admin)).status,200);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year=2026').all(),before);
  assert.equal(db.prepare('SELECT recipient_email FROM outbox WHERE giver=?').get(person.id).recipient_email,'corrected@example.test');
});

function signInToken(db,id) {
  const mail=id?db.prepare('SELECT * FROM outbox WHERE id=?').get(id):db.prepare("SELECT * FROM outbox WHERE kind LIKE 'signin:%' ORDER BY rowid DESC LIMIT 1").get();
  return {mail,token:new URL(mail.body.match(/http[^\s]+\/join#[A-Za-z0-9_-]+/)[0]).hash.slice(1)};
}

test('the shared link accepts an email without revealing membership and issues a scoped, single-use sign-in',async t=>{
  const {db,config,call}=await fixture(t);seed(db);
  const person=members(db,2026)[0];
  const known=await call('/sign-in',{email:` ${person.email.toUpperCase()} `});
  const unknown=await call('/sign-in',{email:'unlisted@example.test'});
  assert.equal(known.status,202);assert.deepEqual(known.data,unknown.data);assert.equal(known.cookie,undefined);
  assert.equal((await call('/member/profile')).status,403);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'signin:%'").get().n,1);
  const {mail,token}=signInToken(db);
  assert.equal(mail.recipient_email,person.email);assert.equal(mail.status,'preview');
  assert.equal(db.prepare('SELECT hash FROM sign_in_tokens').get().hash,hash(token));
  assert.equal(db.prepare('SELECT hash FROM sign_in_tokens').get().hash.includes(token),false);
  await call('/sign-in',{email:person.email});
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'signin:%'").get().n,1);
  const redeemed=await call('/redeem',{token,personId:members(db,2026)[1].id});
  const member={cookie:redeemed.cookie,csrf:redeemed.data.csrf};
  assert.equal(redeemed.status,200);assert.equal(redeemed.data.year,2026);
  assert.equal((await call('/member/profile',undefined,member)).data.person.name,person.name);
  assert.equal((await call('/admin/state',undefined,member)).status,403);
  assert.equal((await call('/member/profile',{wishlist:'A scarf',gifts:[]},member)).status,200);
  assert.equal((await call('/redeem',{token})).status,401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sign_in_tokens').get().n,0);
  assert.equal(db.prepare('SELECT body FROM outbox WHERE id=?').get(mail.id).body.includes(token),false);
  // Existing organizer-issued links remain compatible with the new login flow.
  assert.equal((await call('/redeem',{token:new URL(inviteLink(db,config,2026,person.id)).hash.slice(1)})).status,200);
});

test('expired, revoked, changed-address, inactive and archived sign-in links cannot create sessions',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const people=members(db,2026);
  const issue=p=>signInToken(db,prepareSignIn(db,config,p.email));
  const expired=issue(people[0]);
  db.prepare('UPDATE sign_in_tokens SET expires=? WHERE mail_id=?').run(Date.now()-1,expired.mail.id);
  assert.equal((await call('/redeem',{token:expired.token})).status,401);
  expireSignIns(db);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(expired.mail.id).status,'expired');
  const revoked=issue(people[1]);
  await call('/admin/revoke',{year:2026,personId:people[1].id},admin);
  assert.equal((await call('/redeem',{token:revoked.token})).status,401);
  const corrected=issue(people[2]);
  await call('/admin/contact',{year:2026,id:people[2].id,email:'new-address@example.test'},admin);
  assert.equal((await call('/redeem',{token:corrected.token})).status,401);
  const inactive=issue(people[3]);
  db.prepare('UPDATE enrollments SET active=0 WHERE year=2026 AND person_id=?').run(people[3].id);
  assert.equal((await call('/redeem',{token:inactive.token})).status,401);
  assert.equal(prepareSignIn(db,config,people[3].email),null);
  const archived=issue(people[4]);
  db.prepare("UPDATE exchanges SET state='archived' WHERE year=2026").run();
  assert.equal((await call('/redeem',{token:archived.token})).status,401);
  assert.equal(prepareSignIn(db,config,people[5].email),null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE role='member'").get().n,0);
});

test('email identities are unique and sign-in cooldown and hourly limits survive a database reopen',async t=>{
  const {db,config,call,admin,dir}=await fixture(t);seed(db);
  const people=members(db,2026),person=people[0],now=Date.now();
  assert.equal((await call('/admin/people',{...people[1],year:2026,email:person.email.toUpperCase()},admin)).status,400);
  assert.equal((await call('/admin/contact',{id:people[1].id,year:2026,email:person.email},admin)).status,400);
  assert.ok(prepareSignIn(db,config,person.email,now));
  const reopened=openDatabase(dir);
  try {
    assert.equal(prepareSignIn(reopened,config,person.email,now+30000),null);
    for (let i=1;i<5;i++)assert.ok(prepareSignIn(reopened,config,person.email,now+i*61000));
    assert.equal(prepareSignIn(reopened,config,person.email,now+5*61000),null);
    assert.ok(prepareSignIn(reopened,config,person.email,now+3600001));
  } finally {reopened.close();}
  // Fail closed for duplicate addresses already present in an older database.
  db.prepare('UPDATE people SET email=? WHERE id=?').run(people[2].email,people[3].id);
  assert.equal(prepareSignIn(db,config,people[2].email),null);
  for(let i=0;i<15;i++)assert.equal((await call('/sign-in',{email:'unlisted@example.test'})).status,202);
  assert.equal((await call('/sign-in',{email:'unlisted@example.test'})).status,429);
});

test('a requested sign-in email sends only that message and cannot trigger a prepared family batch',async t=>{
  const sent=[];
  const transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);
  prepareMail(db,config,2026,'invite');
  const person=members(db,2026)[0];
  const response=await call('/sign-in',{email:person.email});
  assert.equal(response.data.mode,'email');assert.equal(sent.length,1);assert.equal(sent[0].to,person.email);
  const {mail,token}=signInToken(db);
  assert.equal(mail.status,'sent');
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='invite' AND status='pending'").get().n,10);
  const mailer=createMailer(db,config,transport);
  await mailer.deliverSignIn(mail.id);assert.equal(sent.length,1);
  assert.equal((await call('/admin/mail/retry',{id:mail.id},admin)).status,400);
  assert.equal((await call('/redeem',{token})).status,200);
  await mailer.deliver(2026);assert.equal(sent.length,11);
  // Sign-in previews or failed sign-ins are never queued by the organizer's annual mail actions.
  const id=prepareSignIn(db,config,members(db,2026)[1].email);
  await mailer.deliver(2026);assert.equal(sent.length,11);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'pending');
});

test('sign-in delivery ambiguity never retries automatically and unavailable SMTP creates no credentials',async t=>{
  let sends=0;
  const transport={async sendMail(){sends++;throw Object.assign(new Error('Timeout'),{code:'ETIMEDOUT'});}};
  const {db,config,call}=await fixture(t,{emailMode:'smtp',transport});seed(db);
  await call('/sign-in',{email:members(db,2026)[0].email});
  const {mail}=signInToken(db);
  assert.equal(mail.status,'uncertain');
  const mailer=createMailer(db,config,transport);
  await mailer.deliverSignIn(mail.id);await mailer.deliver(2026);assert.equal(sends,1);
  const unavailable=await fixture(t,{emailMode:'smtp'});seed(unavailable.db);
  assert.deepEqual((await unavailable.call('/sign-in',{email:members(unavailable.db,2026)[0].email})).data,{ok:true,mode:'unavailable'});
  assert.equal(unavailable.db.prepare('SELECT count(*) AS n FROM sign_in_tokens').get().n,0);
});

function authFrom(response) {
  return {cookie:response.cookie,csrf:response.data.csrf};
}

test('invites, sign-ins, correction requests and matches compile into private, contextual multipart emails without SMTP',async t=>{
  const sent=[],compiled=[];
  const stream=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows'});
  const transport={async sendMail(mail){sent.push(mail);const result=await stream.sendMail(mail);compiled.push(result);return result;}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);
  config.smtp.from='Ornament <sender@example.test>';
  const person=members(db,2026)[0],exchange=db.prepare('SELECT title FROM exchanges WHERE year=2026').get();
  const mailer=createMailer(db,config,transport);
  prepareMail(db,config,2026,'invite',[person.id]);await mailer.deliver(2026);
  const invitation=sent[0].text.match(/https?:[^\s]+\/join#[A-Za-z0-9_-]+/)[0];
  assert.ok(sent[0].text.includes(`Your organizer invited you to ${exchange.title}`));
  assert.ok(sent[0].html.includes(`href="${invitation}"`));
  const redeemed=await call('/redeem',{token:new URL(invitation).hash.slice(1)});
  assert.equal(redeemed.status,200);const owner=authFrom(redeemed);
  const signin=prepareSignIn(db,config,person.email);await mailer.deliverSignIn(signin);
  assert.ok(sent[1].text.includes(`You requested a sign-in link for ${exchange.title}`));
  const correction=await call('/admin/changes-request',{year:2026,personId:person.id,note:'Please add sizes.'},admin);
  assert.equal(correction.status,200);await mailer.deliver(2026);
  assert.ok(sent[2].text.includes('Please add sizes.'));
  assert.equal((await call('/member/profile',{wishlist:'A medium scarf',gifts:[]},owner)).status,200);
  draftDraw(db,2026);lockDraw(db,2026);
  prepareMail(db,config,2026,'assignment',[person.id]);await mailer.deliver(2026);
  assert.equal(sent.length,4);
  assert.deepEqual(sent.map(mail=>mail.subject),[
    `${exchange.title}: your wish list invitation`,`${exchange.title}: sign in to your wish list`,
    `${exchange.title}: update your wish list`,`${exchange.title}: your Secret Santa match`
  ]);
  for(const [i,mail] of sent.entries()) {
    assert.equal(mail.to,person.email);assert.equal(mail.cc,undefined);assert.equal(mail.bcc,undefined);
    assert.ok(mail.text.includes(`Sent by Ornament for ${exchange.title}.`));
    assert.ok(mail.html.includes('<html lang="en">'));
    assert.equal(/<img|<script|<iframe|<link/.test(mail.html),false);
    assert.equal(compiled[i].envelope.from,'sender@example.test');
    assert.deepEqual(compiled[i].envelope.to,[person.email]);
    const raw=compiled[i].message.toString();
    for(const field of ['From','To','Subject','Date','Message-ID','Auto-Submitted']) {
      assert.equal([...raw.matchAll(new RegExp(`^${field}:`,'gm'))].length,1);
    }
    assert.match(raw,/^Auto-Submitted: auto-generated\r?$/m);
    assert.match(raw,/Content-Type: multipart\/alternative;/);
    assert.match(raw,/Content-Type: text\/plain; charset=utf-8/);
    assert.match(raw,/Content-Type: text\/html; charset=utf-8/);
    assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(mail.messageId.slice(1).split('@')[0]).status,'sent');
  }
  assert.equal(db.prepare("SELECT count(*) AS count FROM outbox WHERE status='sent'").get().count,4);
});

test('a complete exchange goes from shared submissions to reviewed identities, repeat-free matches, delivery, and private edits',async t=>{
  const sent=[];
  const transport={async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin,dir}=await fixture(t,{emailMode:'smtp',transport});
  config.smtp.from='Ornament <sender@example.test>';
  for(const year of [2024,2025]) {
    const record={...history(year,year===2024?1:2),status:year===2024?'verified':'provisional',aliases:{'Person 0':['Guest Zero']}};
    assert.equal((await call('/admin/history',record,admin)).status,200);
  }
  assert.equal((await call('/admin/exchanges',{year:2026},admin)).status,200);
  let state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal(state.people.length,10);
  assert.ok(state.people.every(p=>!p.validation.submitted));
  const identities=state.identities;
  const {token}=await openGroup(call,admin);
  const owners=[];
  for(const [i,person] of identities.entries()) {
    const entry=authFrom(await call('/group/redeem',{token}));
    const fields={...submittedFields(i===0?'Guest Zero':person.name,`guest-${i}@example.test`),
      wishlist:`Wish list ${i}: a warm scarf`,message:`Message ${i}: size medium`,
      gifts:[{label:`Gift ${i}`,url:`https://example.test/gift-${i}`} ]};
    owners.push({person,fields,auth:await submitGroup(call,entry,fields)});
  }
  const newcomer=authFrom(await call('/group/redeem',{token}));
  const newcomerFields=submittedFields('New Guest','new-guest@example.test');
  await submitGroup(call,newcomer,newcomerFields);
  state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.equal(state.people.length,10);assert.ok(state.people.every(p=>!p.validation.submitted));assert.equal(state.submissions.length,11);assert.deepEqual(sent,[]);
  for(const submission of state.submissions) {
    const owner=owners.find(p=>p.fields.email===submission.email);
    assert.equal((await call('/admin/submissions/approve',{id:submission.id,personId:owner?.person.id||'new'},admin)).status,200);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,11);
  const people=members(db,2026),first=people[0],excluded=people.find(p=>p.id!==first.id);
  assert.equal((await call('/admin/exclusions',{year:2026,giver:first.id,recipient:excluded.id},admin)).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM exclusions WHERE year=2026').get().n,1);
  assert.equal((await call('/admin/draft',{year:2026},admin)).status,200);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,400);
  assert.equal((await call('/admin/history/confirm',{year:2025},admin)).status,200);
  assert.equal((await call('/admin/draft',{year:2026},admin)).status,200);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,200);
  const pairs=db.prepare('SELECT giver,recipient FROM assignments WHERE year=2026').all();
  const previous=db.prepare('SELECT giver,recipient FROM assignments WHERE year IN (2024,2025)').all();
  assert.equal(pairs.length,11);assert.equal(new Set(pairs.map(p=>p.recipient)).size,11);
  for(const pair of pairs) {
    assert.notEqual(pair.giver,pair.recipient);
    assert.equal(pair.giver===first.id&&pair.recipient===excluded.id,false);
    assert.equal(previous.some(p=>p.giver===pair.giver&&p.recipient===pair.recipient),false);
  }
  assert.equal((await call('/admin/mail/prepare',{year:2026,kind:'assignment'},admin)).status,200);
  assert.equal((await call('/admin/mail/send',{year:2026},admin)).status,400);
  assert.deepEqual(sent,[]);
  assert.equal((await call('/admin/mail/send',{year:2026,confirm:'SEND'},admin)).status,200);
  assert.equal(sent.length,11);
  for(const pair of pairs) {
    const giver=people.find(p=>p.id===pair.giver),recipient=people.find(p=>p.id===pair.recipient);
    const mail=sent.find(m=>m.to===giver.email);
    assert.ok(mail);assert.equal(mail.from,'"Ornament Secret Santa" <sender@example.test>');
    for(const text of [recipient.name,recipient.wishlist,recipient.message,...recipient.gifts.flatMap(g=>[g.label,g.url])])assert.ok(mail.text.includes(text));
    for(const other of people.filter(p=>p.id!==recipient.id))assert.equal(mail.text.includes(other.wishlist),false);
    assert.ok(mail.text.includes(`${config.publicUrl}/join`));
    assert.equal(mail.text.includes('/join#'),false);
    const signin=prepareSignIn(db,config,giver.email);
    const personal=authFrom(await call('/redeem',{token:signInToken(db,signin).token}));
    const profile=await call('/member/profile',undefined,personal);
    assert.equal(profile.data.person.name,giver.name);assert.equal(profile.data.recipient.name,recipient.name);
    assert.equal(profile.data.recipient.email,undefined);
    assert.equal((await call('/admin/state',undefined,personal)).status,403);
  }
  assert.equal((await call('/admin/mail/prepare',{year:2026,kind:'assignment'},admin)).status,200);
  assert.equal((await call('/admin/mail/send',{year:2026,confirm:'SEND'},admin)).status,200);
  assert.equal(sent.length,11);
  const owner=owners[0];
  await submitGroup(call,owner.auth,{...owner.fields,wishlist:'Updated after the draw',message:'Please choose green'});
  assert.equal((await call('/member/profile',undefined,owner.auth)).status,403);
  const giverId=pairs.find(p=>p.recipient===owner.person.id).giver;
  const link=(await call('/admin/link',{year:2026,personId:giverId},admin)).data.link;
  const verified=authFrom(await call('/redeem',{token:new URL(link).hash.slice(1)}));
  assert.equal((await call('/member/profile',undefined,verified)).data.recipient.wishlist,'Updated after the draw');
  assert.deepEqual(db.prepare('SELECT giver,recipient FROM assignments WHERE year=2026').all(),pairs);
  const reopened=openDatabase(dir);
  try {
    assert.deepEqual(reopened.prepare('SELECT giver,recipient FROM assignments WHERE year=2026').all(),pairs);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM outbox WHERE status='sent'").get().n,11);
  }finally{reopened.close();}
});

test('review can reuse a historical identity absent from the current roster',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const person=members(db,2026)[0];
  createExchange(db,2027,null);
  // Simulate a legacy roster missing one saved identity.
  db.prepare('DELETE FROM enrollments WHERE year=2027 AND person_id=?').run(person.id);
  const state=await call('/admin/state?year=2027',undefined,admin);
  assert.equal(state.data.people.length,9);assert.equal(state.data.people.some(p=>p.id===person.id),false);
  assert.ok(state.data.identities.some(p=>p.id===person.id&&p.name===person.name));
  const {auth}=await openGroup(call,admin,2027);
  await submitGroup(call,auth,submittedFields(person.name,person.email));
  const submission=db.prepare('SELECT id FROM submissions WHERE year=2027').get();
  const result=await call('/admin/submissions/approve',{id:submission.id,personId:person.id},admin);
  assert.equal(result.status,200);
  assert.equal(members(db,2027)[0].id,person.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,10);
});
async function openGroup(call,admin,year=2026) {
  assert.equal((await call('/admin/group-settings',{year,enabled:true},admin)).status,200);
  const created=await call('/admin/group-link',{year},admin);
  assert.equal(created.status,200);
  const token=new URL(created.data.link).hash.slice('#group-'.length);
  const redeemed=await call('/group/redeem',{token});
  assert.equal(redeemed.status,200);assert.equal(redeemed.data.role,'group');
  return {token,auth:authFrom(redeemed)};
}
async function submitGroup(call,auth,fields) {
  const saved=await call('/group/profile',fields,auth);
  assert.equal(saved.status,200);assert.equal(saved.data.role,'submission');
  return saved.cookie?authFrom(saved):{...auth,csrf:saved.data.csrf};
}
const submittedFields=(name='Guest A',email='guest-a@example.test')=>({
  name,email,wishlist:'A blue scarf',message:'Thanks for being my Secret Santa!',
  gifts:[{label:'Scarf',url:'https://example.test/scarf'}]
});

test('the group form needs a private group link and saves without login emails or changes to known identities',async t=>{
  const sent=[];
  const {db,call,admin}=await fixture(t,{emailMode:'smtp',transport:{async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}}});
  seed(db);
  const person=members(db,2026)[0];
  db.prepare('UPDATE enrollments SET wishlist=?,message=?,gifts=? WHERE year=? AND person_id=?').run(
    'Existing private wish list','Existing private message',JSON.stringify([{label:'Private gift',url:'https://example.test/private'}]),2026,person.id);
  const canonicalBefore=db.prepare('SELECT * FROM people WHERE id=?').get(person.id);
  const enrollmentBefore=db.prepare('SELECT * FROM enrollments WHERE year=? AND person_id=?').get(2026,person.id);
  assert.equal((await call('/group/profile')).status,403);
  assert.equal((await call('/group/profile',submittedFields())).status,403);
  assert.equal((await call('/group/redeem',{token:'invalid'})).status,401);
  const {token,auth}=await openGroup(call,admin);
  assert.equal(db.prepare('SELECT hash FROM group_tokens').get().hash,hash(token));
  assert.equal((await call('/redeem',{token})).status,401);
  const initial=await call('/group/profile',undefined,auth);
  assert.deepEqual(Object.keys(initial.data).sort(),['exchange','submission']);
  assert.deepEqual(Object.keys(initial.data.exchange).sort(),['budget','eventDate','state','title','year']);
  assert.equal(initial.data.submission,null);
  assert.equal(JSON.stringify(initial.data).includes(person.email),false);
  assert.equal((await call('/group/profile',submittedFields(),{...auth,csrf:'wrong'})).status,403);
  assert.equal((await call('/group/profile',submittedFields(),{...auth,headers:{Origin:'https://attacker.test'}})).status,403);
  assert.equal((await call('/group/profile',{...submittedFields(),gifts:[{label:'Bad',url:'javascript:alert(1)'}]},auth)).status,400);
  assert.equal((await call('/group/profile',{...submittedFields(),message:'x'.repeat(2001)},auth)).status,400);
  const fields=submittedFields(person.name,` ${person.email.toUpperCase()} `);
  const submissionAuth=await submitGroup(call,auth,fields);
  const profile=await call('/group/profile',undefined,submissionAuth);
  assert.deepEqual(profile.data.submission,{...fields,email:person.email,status:'pending'});
  assert.deepEqual(Object.keys(profile.data.submission).sort(),['email','gifts','message','name','status','wishlist']);
  assert.equal(JSON.stringify(profile.data).includes('Existing private'),false);
  assert.equal((await call('/member/profile',undefined,submissionAuth)).status,403);
  assert.equal((await call('/admin/state',undefined,submissionAuth)).status,403);
  assert.deepEqual(db.prepare('SELECT * FROM people WHERE id=?').get(person.id),canonicalBefore);
  assert.deepEqual(db.prepare('SELECT * FROM enrollments WHERE year=? AND person_id=?').get(2026,person.id),enrollmentBefore);
  assert.equal(db.prepare('SELECT count(*) AS n FROM invite_tokens').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sign_in_tokens').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.deepEqual(sent,[]);
});

test('shared group sessions isolate saved entries and reopening the group link resumes only the same browser entry',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const {token,auth:firstGroup}=await openGroup(call,admin);
  const firstFields=submittedFields();
  let first=await submitGroup(call,firstGroup,firstFields);
  const firstId=db.prepare('SELECT id FROM submissions WHERE email=?').get(firstFields.email).id;
  const secondRedeemed=await call('/group/redeem',{token});
  const secondGroup=authFrom(secondRedeemed);
  assert.equal((await call('/group/profile',undefined,secondGroup)).data.submission,null);
  const secondFields={...submittedFields('Guest B','guest-b@example.test'),wishlist:'A green coat',message:'Guest B note'};
  const second=await submitGroup(call,secondGroup,{...secondFields,id:firstId,personId:firstId});
  assert.equal(db.prepare('SELECT count(*) AS n FROM submissions').get().n,2);
  assert.deepEqual((await call('/group/profile',undefined,first)).data.submission,{...firstFields,status:'pending'});
  assert.deepEqual((await call('/group/profile',undefined,second)).data.submission,{...secondFields,status:'pending'});
  const secondId=db.prepare('SELECT id FROM submissions WHERE email=?').get(secondFields.email).id;
  first=await submitGroup(call,first,{...firstFields,wishlist:'A red scarf',id:secondId,personId:secondId});
  assert.equal((await call('/group/profile',undefined,second)).data.submission.wishlist,secondFields.wishlist);
  const resumed=await call('/group/redeem',{token},first);
  assert.equal(resumed.status,200);assert.equal(resumed.data.role,'submission');
  first=resumed.cookie?authFrom(resumed):{...first,csrf:resumed.data.csrf};
  assert.equal((await call('/group/profile',undefined,first)).data.submission.wishlist,'A red scarf');
  assert.equal((await call('/member/profile',undefined,first)).status,403);
});

test('organizer review maps aliases to stable people, prevents duplicate approvals, and blocks finalizing pending wish lists',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const person=members(db,2026)[0],other=members(db,2026)[1];
  savePerson(db,2026,{...person,aliases:['Alias A']});
  const countBefore=db.prepare('SELECT count(*) AS n FROM people').get().n;
  const historyBefore=db.prepare('SELECT * FROM assignments WHERE year IN (2024,2025)').all();
  const {auth}=await openGroup(call,admin);
  const fields=submittedFields('Alias A','alias-a@example.test');
  const own=await submitGroup(call,auth,fields);
  const state=await call('/admin/state?year=2026',undefined,admin);
  const pending=state.data.submissions.find(s=>s.email===fields.email);
  assert.equal(pending.status,'pending');assert.equal(pending.suggestedPersonId,person.id);
  draftDraw(db,2026);
  const blocked=await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin);
  assert.equal(blocked.status,400);assert.match(blocked.data.error,/review|submitted|pending/i);
  assert.equal(db.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'drafted');
  assert.equal((await call('/admin/submissions/approve',{id:pending.id,personId:person.id},own)).status,403);
  assert.equal((await call('/admin/submissions/approve',{id:pending.id,personId:'new'},admin)).status,400);
  const approved=await call('/admin/submissions/approve',{id:pending.id,personId:person.id},admin);
  assert.equal(approved.status,200);assert.equal(approved.data.personId,person.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,countBefore);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year IN (2024,2025)').all(),historyBefore);
  assert.equal(db.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'open');
  const canonical=members(db,2026).find(p=>p.id===person.id);
  assert.equal(canonical.name,person.name);assert.equal(canonical.email,fields.email);
  assert.equal(canonical.wishlist,fields.wishlist);assert.equal(canonical.message,fields.message);assert.deepEqual(canonical.gifts,fields.gifts);
  assert.equal((await call('/group/profile',undefined,own)).data.submission.status,'approved');
  const secondGroup=await openGroup(call,admin);
  await submitGroup(call,secondGroup.auth,submittedFields('Another A','another-a@example.test'));
  const duplicate=db.prepare('SELECT id FROM submissions WHERE email=?').get('another-a@example.test');
  assert.equal((await call('/admin/submissions/approve',{id:duplicate.id,personId:person.id},admin)).status,400);
  assert.equal(members(db,2026).find(p=>p.id===person.id).email,fields.email);
  const thirdGroup=await openGroup(call,admin);
  await submitGroup(call,thirdGroup.auth,submittedFields('Guest C',other.email));
  const conflicting=db.prepare('SELECT id FROM submissions WHERE email=? AND status=?').get(other.email,'pending');
  assert.equal((await call('/admin/submissions/approve',{id:conflicting.id,personId:'new'},admin)).status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,countBefore);
  assert.equal((await call('/admin/submissions/reject',{id:duplicate.id},admin)).status,200);
  assert.equal((await call('/admin/submissions/reject',{id:conflicting.id},admin)).status,200);
  draftDraw(db,2026);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,200);
});

test('a reviewed entry edits only its own wish list after finalization and never grants access to the secret match',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const person=members(db,2026)[0];
  const {token,auth}=await openGroup(call,admin);
  const fields=submittedFields(person.name,person.email);
  let own=await submitGroup(call,auth,fields);
  const id=db.prepare('SELECT id FROM submissions WHERE email=?').get(person.email).id;
  assert.equal((await call('/admin/submissions/approve',{id,personId:person.id},admin)).status,200);
  assert.equal((await call('/group/profile',{...fields,email:'changed@example.test'},own)).status,400);
  assert.equal((await call('/group/profile',{...fields,name:'Different name'},own)).status,400);
  draftDraw(db,2026);lockDraw(db,2026);
  const pairs=db.prepare('SELECT * FROM assignments WHERE year=2026').all();
  assert.equal((await call('/group/redeem',{token})).status,400);
  const resumed=await call('/group/redeem',{token},own);
  assert.equal(resumed.status,200);assert.equal(resumed.data.role,'submission');
  own=resumed.cookie?authFrom(resumed):{...own,csrf:resumed.data.csrf};
  const edited={...fields,wishlist:'An updated scarf',message:'Please choose wool',gifts:[{label:'Wool scarf',url:'https://example.test/wool'}]};
  own=await submitGroup(call,own,edited);
  const profile=await call('/group/profile',undefined,own);
  assert.deepEqual(profile.data.submission,{...edited,status:'approved'});
  assert.equal('recipient' in profile.data,false);
  assert.equal((await call('/member/profile',undefined,own)).status,403);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year=2026').all(),pairs);
  const canonical=members(db,2026).find(p=>p.id===person.id);
  assert.equal(canonical.wishlist,edited.wishlist);assert.equal(canonical.message,edited.message);assert.deepEqual(canonical.gifts,edited.gifts);
  const personal=await call('/redeem',{token:new URL(inviteLink(db,config,2026,person.id)).hash.slice(1)});
  const verified=await call('/member/profile',undefined,authFrom(personal));
  assert.ok(verified.data.recipient);
  assert.equal(verified.data.person.message,edited.message);
});

test('revoking a group link closes entry sessions while preserving saved entry edits, and declined entries cannot be edited',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const {token,auth}=await openGroup(call,admin);
  const fields=submittedFields();
  let own=await submitGroup(call,auth,fields);
  const unsubmitted=authFrom(await call('/group/redeem',{token}));
  assert.equal((await call('/admin/group-revoke',{year:2026},admin)).status,200);
  assert.equal((await call('/group/redeem',{token})).status,401);
  assert.equal((await call('/group/profile',undefined,unsubmitted)).status,403);
  assert.equal((await call('/group/profile',undefined,own)).status,200);
  own=await submitGroup(call,own,{...fields,message:'Saved after link rotation'});
  const id=db.prepare('SELECT id FROM submissions WHERE email=?').get(fields.email).id;
  assert.equal((await call('/admin/submissions/reject',{id},admin)).status,200);
  assert.equal((await call('/group/profile',undefined,own)).data.submission.status,'rejected');
  assert.equal((await call('/group/profile',{...fields,wishlist:'Rejected edit'},own)).status,400);
  assert.equal((await call('/admin/submissions/approve',{id,personId:'new'},admin)).status,400);
  const fresh=await openGroup(call,admin);
  assert.equal((await call('/group/profile',undefined,fresh.auth)).data.submission,null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,10);
});

test('expired group links cannot issue sessions and individual revocation removes only that approved entry access',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const people=members(db,2026).slice(0,2),owners=[];
  for(const person of people) {
    const {auth}=await openGroup(call,admin);
    owners.push(await submitGroup(call,auth,submittedFields(person.name,person.email)));
    const id=db.prepare('SELECT id FROM submissions WHERE email=?').get(person.email).id;
    assert.equal((await call('/admin/submissions/approve',{id,personId:person.id},admin)).status,200);
  }
  const {token}=await openGroup(call,admin);
  db.prepare('UPDATE group_tokens SET expires=? WHERE hash=?').run(Date.now()-1,hash(token));
  assert.equal((await call('/group/redeem',{token})).status,401);
  assert.equal((await call('/admin/revoke',{year:2026,personId:people[0].id},admin)).status,200);
  assert.equal((await call('/group/profile',undefined,owners[0])).status,403);
  assert.equal((await call('/group/profile',submittedFields(people[0].name,people[0].email),owners[0])).status,403);
  assert.equal((await call('/group/profile',undefined,owners[1])).status,200);
  assert.equal(db.prepare("SELECT count(*) AS n FROM submissions WHERE status='approved'").get().n,2);
});

test('review can add a new participant and assignment emails include only the matched recipient content',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const {auth}=await openGroup(call,admin);
  const fields=submittedFields('Guest New','guest-new@example.test');
  await submitGroup(call,auth,fields);
  const id=db.prepare('SELECT id FROM submissions WHERE email=?').get(fields.email).id;
  const approved=await call('/admin/submissions/approve',{id,personId:'new'},admin);
  assert.equal(approved.status,200);
  const newcomer=members(db,2026).find(p=>p.id===approved.data.personId);
  assert.equal(newcomer.name,fields.name);assert.equal(newcomer.email,fields.email);assert.equal(newcomer.active,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n,11);
  for(const person of members(db,2026))db.prepare('UPDATE enrollments SET wishlist=?,message=?,gifts=? WHERE year=2026 AND person_id=?').run(
    `Wish-${person.id}`,`Note-${person.id}`,JSON.stringify([{label:`Gift-${person.id}`,url:`https://example.test/gift/${person.id}`}]),person.id);
  draftDraw(db,2026);lockDraw(db,2026);
  prepareMail(db,config,2026,'assignment');
  for(const mail of db.prepare("SELECT * FROM outbox WHERE year=2026 AND kind='assignment'").all()) {
    const recipient=db.prepare('SELECT recipient FROM assignments WHERE year=2026 AND giver=?').get(mail.giver).recipient;
    const target=members(db,2026).find(p=>p.id===recipient);
    assert.equal(mail.recipient_email,members(db,2026).find(p=>p.id===mail.giver).email);
    assert.ok(mail.body.includes(`${target.name}'s Secret Santa`));
    assert.ok(mail.body.includes(`Wish-${recipient}`));assert.ok(mail.body.includes(`Note-${recipient}`));
    assert.ok(mail.body.includes(`https://example.test/gift/${recipient}`));
    assert.equal(mail.body.includes(`Note-${mail.giver}`),false);
  }
  const before=db.prepare('SELECT id,body FROM outbox ORDER BY id').all();
  db.prepare("UPDATE enrollments SET message='Changed after preparation' WHERE year=2026").run();
  prepareMail(db,config,2026,'assignment');
  assert.deepEqual(db.prepare('SELECT id,body FROM outbox ORDER BY id').all(),before);
});

test('adding the message field to a legacy database preserves finalized assignments and sent mail',async t=>{
  const {db,config,dir}=await fixture(t);seed(db);draftDraw(db,2026);lockDraw(db,2026);
  const person=members(db,2026)[0];
  db.prepare('UPDATE enrollments SET wishlist=?,gifts=? WHERE year=2026 AND person_id=?').run(
    'Legacy wish list',JSON.stringify([{label:'Legacy book',url:'https://example.test/legacy'}]),person.id);
  prepareMail(db,config,2026,'assignment');
  db.prepare("UPDATE outbox SET status='sent',sent_at='2026-01-01T00:00:00.000Z'").run();
  const pairs=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  const mail=db.prepare('SELECT * FROM outbox ORDER BY id').all();
  // Version 0.2 databases contain these records without an enrollment message column.
  db.exec('ALTER TABLE enrollments DROP COLUMN message');
  const migrated=openDatabase(dir);
  try {
    assert.deepEqual(migrated.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),pairs);
    assert.deepEqual(migrated.prepare('SELECT * FROM outbox ORDER BY id').all(),mail);
    const row=members(migrated,2026).find(p=>p.id===person.id);
    assert.equal(row.wishlist,'Legacy wish list');assert.equal(row.message,'');
    assert.deepEqual(row.gifts,[{label:'Legacy book',url:'https://example.test/legacy'}]);
    assert.equal(migrated.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'locked');
  } finally {migrated.close();}
});

test('known-member invitations are single-use, bounded, email-bound, and reject inactive or archived accounts',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);const person=members(db,2026)[0];
  const create=()=>new URL(inviteLink(db,config,2026,person.id)).hash.slice(1);
  const first=create(),row=db.prepare('SELECT * FROM invite_tokens WHERE hash=?').get(hash(first));
  assert.equal(row.email,person.email);assert.ok(row.expires-Date.now()<=48*3600000);
  assert.equal((await call('/redeem',{token:first})).status,200);
  assert.equal((await call('/redeem',{token:first})).status,401);
  const expired=create();db.prepare('UPDATE invite_tokens SET expires=?').run(Date.now()-1);
  assert.equal((await call('/redeem',{token:expired})).status,401);
  const corrected=create();await call('/admin/contact',{year:2026,id:person.id,email:'new-address@example.test'},admin);
  assert.equal((await call('/redeem',{token:corrected})).status,401);
  const inactive=create();db.prepare('UPDATE enrollments SET active=0 WHERE year=2026 AND person_id=?').run(person.id);
  assert.equal((await call('/redeem',{token:inactive})).status,401);
  db.prepare('UPDATE enrollments SET active=1 WHERE year=2026 AND person_id=?').run(person.id);
  const archived=create();db.prepare("UPDATE exchanges SET state='archived' WHERE year=2026").run();
  assert.equal((await call('/redeem',{token:archived})).status,401);
});

test('organizer metadata excludes wish lists, notes, gift links, current matches and email bodies until confirmed reveal',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);const person=members(db,2026)[0];
  const privateValues=['Private scarf surprise','Private note surprise','Private gift surprise','https://example.test/private-surprise'];
  db.prepare('UPDATE enrollments SET wishlist=?,message=?,gifts=? WHERE year=2026 AND person_id=?').run(privateValues[0],privateValues[1],JSON.stringify([{label:privateValues[2],url:privateValues[3]}]),person.id);
  const {auth}=await openGroup(call,admin);await submitGroup(call,auth,{...submittedFields('Pending Guest','pending@example.test'),wishlist:'Pending private surprise'});
  const pending=db.prepare('SELECT id FROM submissions WHERE email=?').get('pending@example.test').id;
  await call('/admin/submissions/reject',{id:pending},admin);
  const drafted=await call('/admin/draft',{year:2026},admin);assert.equal(drafted.data.assignments,undefined);assert.equal(drafted.data.draw.passed,true);
  lockDraw(db,2026);prepareMail(db,config,2026,'assignment');
  const state=(await call('/admin/state?year=2026',undefined,admin)).data;
  assert.deepEqual(state.assignments,[]);assert.equal(state.draw.count,10);assert.equal(state.people.find(p=>p.id===person.id).validation.passed,true);
  const serialized=JSON.stringify(state);
  for(const value of [...privateValues,'Pending private surprise'])assert.equal(serialized.includes(value),false);
  for(const p of state.people)for(const key of ['wishlist','message','gifts'])assert.equal(key in p,false);
  for(const p of state.submissions)for(const key of ['wishlist','message','gifts'])assert.equal(key in p,false);
  for(const mail of state.outbox)assert.equal('body' in mail,false);
  const payload={year:2026,personId:person.id};
  assert.equal((await call('/admin/wishlist/reveal',payload,admin)).status,400);
  assert.equal((await call('/admin/wishlist/reveal',{...payload,confirm:'REVEAL'},auth)).status,403);
  assert.equal((await call('/admin/wishlist/reveal',{...payload,confirm:'REVEAL'},{...admin,csrf:'bad'})).status,403);
  assert.equal((await call('/admin/wishlist/reveal',{...payload,confirm:'REVEAL'},admin)).data.wishlist,privateValues[0]);
  assert.equal((await call('/admin/submissions/reveal',{id:pending,confirm:'REVEAL'},admin)).data.wishlist,'Pending private surprise');
  assert.equal((await call('/admin/draw/reveal',{year:2026,confirm:'REVEAL'},admin)).data.assignments.length,10);
  const mail=state.outbox.find(m=>db.prepare('SELECT recipient FROM assignments WHERE year=2026 AND giver=?').get(m.giver).recipient===person.id);
  assert.ok((await call('/admin/mail/preview',{id:mail.id,confirm:'REVEAL'},admin)).data.body.includes(privateValues[0]));
  assert.equal(JSON.stringify((await call('/admin/state?year=2026',undefined,admin)).data).includes(privateValues[0]),false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(privateValues[0]),false);
});

test('local validation rejects empty, oversized and unsafe submissions without overwriting saved content',async t=>{
  const {db,config,call}=await fixture(t);seed(db);const person=members(db,2026)[0];
  const auth=authFrom(await call('/redeem',{token:new URL(inviteLink(db,config,2026,person.id)).hash.slice(1)}));
  const valid={wishlist:'A scarf',message:'Size medium',gifts:[{label:'Scarf',url:'https://example.test/scarf'}]};
  assert.equal((await call('/member/profile',valid,auth)).status,200);
  for(const invalid of [
    {...valid,wishlist:' ',gifts:[]},{...valid,wishlist:' ',gifts:[{label:' ',url:' '}]},{...valid,wishlist:'x'.repeat(5001)},
    {...valid,message:'x'.repeat(2001)},{...valid,gifts:Array(6).fill(valid.gifts[0])},
    {...valid,gifts:[{label:'x'.repeat(161),url:''}]},
    {...valid,gifts:[{label:'Bad',url:'javascript:alert(1)'}]},
    {...valid,gifts:[{label:'Bad',url:'http://user:password@example.test'}]},
  ])assert.equal((await call('/member/profile',invalid,auth)).status,400);
  const saved=(await call('/member/profile',undefined,auth)).data.person;
  assert.equal(saved.wishlist,valid.wishlist);assert.deepEqual(saved.gifts,valid.gifts);
  assert.equal(validateWishlist(valid,person.email).passed,true);
  assert.equal(validateWishlist({...valid,message:''},person.email).passed,true);
});

test('correction requests queue an email without revealing content and clear on valid resubmission',async t=>{
  const sent=[];const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport:{async sendMail(mail){sent.push(mail);return {accepted:[mail.to],rejected:[]};}}});seed(db);
  const person=members(db,2026)[0],auth=authFrom(await call('/redeem',{token:new URL(inviteLink(db,config,2026,person.id)).hash.slice(1)}));
  assert.equal((await call('/admin/changes-request',{year:2026,personId:person.id,note:'Please add sizes.'},admin)).status,200);
  assert.deepEqual(sent,[]);
  const mail=db.prepare("SELECT * FROM outbox WHERE kind LIKE 'revision:%'").get();assert.equal(mail.recipient_email,person.email);assert.ok(mail.body.includes('Please add sizes.'));assert.equal(mail.body.includes(person.wishlist),false);
  draftDraw(db,2026);assert.throws(()=>lockDraw(db,2026),/resolve requested changes/);
  assert.equal((await call('/member/profile',undefined,auth)).data.person.changesRequested,'Please add sizes.');
  const status=(await call('/admin/state',undefined,admin)).data.people.find(p=>p.id===person.id);assert.equal(status.changesRequested,'Please add sizes.');assert.equal(status.wishlist,undefined);
  assert.equal((await call('/admin/mail/send',{year:2026,confirm:'SEND'},admin)).status,200);assert.equal(sent.length,1);
  assert.equal((await call('/member/profile',{wishlist:'A medium scarf',gifts:[]},auth)).status,200);
  assert.equal((await call('/member/profile',undefined,auth)).data.person.changesRequested,'');
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(mail.id).status,'sent');
  await call('/admin/changes-request',{year:2026,personId:person.id,note:'Please add a color.'},admin);
  await call('/member/profile',{wishlist:'A medium blue scarf',gifts:[]},auth);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'revision:%' AND status='cancelled'").get().n,1);lockDraw(db,2026);
  assert.equal((await call('/admin/mail/send',{year:2026,confirm:'SEND'},admin)).status,200);assert.equal(sent.length,1);
});

test('approved group owners resolve requests without altering successful or uncertain deliveries',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);const person=members(db,2026)[0];
  const {auth}=await openGroup(call,admin),fields=submittedFields(person.name,person.email);
  const owner=await submitGroup(call,auth,fields),submission=db.prepare("SELECT id FROM submissions WHERE status='pending'").get();
  assert.equal((await call('/admin/submissions/approve',{id:submission.id,personId:person.id},admin)).status,200);
  await call('/admin/changes-request',{year:2026,personId:person.id,note:'Please add a color.'},admin);
  const uncertain=db.prepare("SELECT id FROM outbox WHERE kind LIKE 'revision:%'").get().id;
  db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(uncertain);
  await call('/admin/changes-request',{year:2026,personId:person.id,note:'Please add sizes.'},admin);
  assert.equal((await call('/group/profile',undefined,owner)).data.submission.changesRequested,'Please add sizes.');
  assert.equal((await call('/group/profile',{...fields,wishlist:'A medium blue scarf'},owner)).status,200);
  assert.equal((await call('/group/profile',undefined,owner)).data.submission.changesRequested,undefined);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(uncertain).status,'uncertain');
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox WHERE kind LIKE 'revision:%' AND status='cancelled'").get().n,1);
});

test('group registration requires explicit opt-in and closing it preserves saved-owner edits',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  assert.equal((await call('/admin/group-link',{year:2026},admin)).status,400);
  const {token,auth}=await openGroup(call,admin);const saved=await submitGroup(call,auth,submittedFields());
  assert.equal((await call('/admin/group-settings',{year:2026,enabled:false},admin)).status,200);
  assert.equal((await call('/group/redeem',{token})).status,401);
  assert.equal((await call('/group/profile',{...submittedFields(),wishlist:'A red scarf'},saved)).status,200);
  assert.equal((await call('/group/profile',undefined,saved)).data.submission.wishlist,'A red scarf');
});

test('access-policy migration retires legacy reusable links without changing saved submissions, draws or successful emails',async t=>{
  const {db,config,call,admin,dir}=await fixture(t);seed(db);const person=members(db,2026)[0];
  const {token,auth}=await openGroup(call,admin);await submitGroup(call,auth,submittedFields());
  const pending=db.prepare('SELECT id FROM submissions WHERE status=\'pending\'').get().id;await call('/admin/submissions/reject',{id:pending},admin);
  draftDraw(db,2026);lockDraw(db,2026);prepareMail(db,config,2026,'assignment');
  db.prepare("UPDATE outbox SET status='sent',sent_at='2026-01-01' WHERE kind='assignment'").run();
  const old=inviteLink(db,config,2026,person.id);
  const snapshots={pairs:db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),mail:db.prepare('SELECT * FROM outbox ORDER BY id').all(),submissions:db.prepare('SELECT * FROM submissions ORDER BY id').all()};
  db.exec('ALTER TABLE invite_tokens DROP COLUMN email; ALTER TABLE exchanges DROP COLUMN allow_group_join; ALTER TABLE enrollments DROP COLUMN changes_requested');
  const upgraded=openDatabase(dir);try{
    assert.equal(upgraded.prepare('SELECT count(*) AS n FROM invite_tokens').get().n,0);
    assert.equal(upgraded.prepare('SELECT count(*) AS n FROM group_tokens').get().n,0);
    assert.equal(upgraded.prepare('SELECT allow_group_join FROM exchanges WHERE year=2026').get().allow_group_join,0);
    assert.deepEqual(upgraded.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),snapshots.pairs);
    assert.deepEqual(upgraded.prepare('SELECT * FROM outbox ORDER BY id').all(),snapshots.mail);
    assert.deepEqual(upgraded.prepare('SELECT * FROM submissions ORDER BY id').all(),snapshots.submissions);
  }finally{upgraded.close();}
  assert.equal((await call('/redeem',{token:new URL(old).hash.slice(1)})).status,401);
  assert.equal((await call('/group/redeem',{token})).status,401);
});

test('submission writes and persistent global sign-in budgets bound abuse',async t=>{
  const {db,config,call,dir}=await fixture(t);seed(db);const person=members(db,2026)[0];
  const auth=authFrom(await call('/redeem',{token:new URL(inviteLink(db,config,2026,person.id)).hash.slice(1)}));
  for(let i=0;i<30;i++)assert.equal((await call('/member/profile',{wishlist:'A scarf',gifts:[]},auth)).status,200);
  assert.equal((await call('/member/profile',{wishlist:'One more edit',gifts:[]},auth)).status,429);
  const now=Date.now();for(let i=0;i<20;i++)db.prepare('INSERT INTO sign_in_events(created_at) VALUES (?)').run(now);
  assert.equal(prepareSignIn(db,config,person.email,now),null);
  db.prepare('UPDATE sign_in_events SET created_at=?').run(now-16*60000);
  assert.ok(prepareSignIn(db,config,person.email,now));
  for(let i=0;i<79;i++)db.prepare('INSERT INTO sign_in_events(created_at) VALUES (?)').run(now-16*60000);
  const reopened=openDatabase(dir);try{assert.equal(prepareSignIn(reopened,config,members(db,2026)[1].email,now),null);}finally{reopened.close();}
  const response=await call('/sign-in',{email:'unknown@example.test'});assert.equal(response.status,202);assert.equal(response.cookie,undefined);
});


test('marked partners block both directions in tests, drafts and finalization, and carry to new years',async t=>{
  const {db,call,admin}=await fixture(t);seed(db);
  const people=members(db,2026),[a,b,c]=people;
  draftDraw(db,2026);
  assert.equal((await call('/admin/partners',{year:2026,first:a.id,second:b.id},admin)).status,200);
  assert.equal(db.prepare('SELECT state FROM exchanges WHERE year=2026').get().state,'open');
  assert.equal(db.prepare('SELECT count(*) AS n FROM assignments WHERE year=2026').get().n,0);
  const options=matchingOptions(db,2026);
  for(let i=0;i<100;i++) {
    const pairs=generateDraw(people.map(p=>p.id),options);
    assert.deepEqual(validateDraw(pairs,people.map(p=>p.id),options),[]);
    assert.ok(!pairs.some(p=>p.giver===a.id&&p.recipient===b.id||p.giver===b.id&&p.recipient===a.id));
  }
  const report=await call('/admin/matching-test',{year:2026},admin);
  assert.equal(report.data.status,'passed');assert.equal(report.data.checked,100);
  assert.equal((await call('/admin/partners',{year:2026,first:b.id,second:a.id},admin)).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM partners WHERE year=2026').get().n,1);
  for(const body of [{first:a.id,second:a.id},{first:a.id,second:c.id},{first:c.id,second:'unknown'}])assert.equal((await call('/admin/partners',{year:2026,...body},admin)).status,400);
  assert.equal((await call('/admin/partners',{year:2026,first:a.id,second:c.id})).status,403);
  assert.equal((await call('/admin/partners',{year:2026,first:a.id,second:c.id},{...admin,csrf:'wrong'})).status,403);
  // Even a persisted stale/invalid draft cannot bypass the partner rule at finalization.
  const invalid=people.map((p,i)=>({giver:p.id,recipient:people[(i+1)%people.length].id}));
  for(const p of invalid)db.prepare('INSERT INTO assignments(year,giver,recipient) VALUES (2026,?,?)').run(p.giver,p.recipient);
  db.prepare("UPDATE exchanges SET state='drafted' WHERE year=2026").run();
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,400);
  await call('/admin/draft',{year:2026},admin);
  assert.equal((await call('/admin/finalize',{year:2026,confirm:'FINALIZE'},admin)).status,200);
  const before=db.prepare('SELECT * FROM assignments ORDER BY year,giver').all();
  assert.equal((await call('/admin/partners',{year:2026,first:a.id,second:b.id,remove:true},admin)).status,400);
  createExchange(db,2027);
  assert.deepEqual(matchingOptions(db,2027).partners,options.partners);
  assert.equal((await call('/admin/partners',{year:2027,first:a.id,second:b.id,remove:true},admin)).status,200);
  assert.equal(matchingOptions(db,2027).partners.length,0);
  assert.equal(matchingOptions(db,2026).partners.length,1);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all(),before);
});

test('a partner conflict reports impossible matching without relaxing either direction',async t=>{
  const {db,call,admin}=await fixture(t),names=['Alex','Jamie','Casey','Morgan'];
  importHistory(db,history(2024,1,names));importHistory(db,history(2025,3,names));createExchange(db,2026);
  const people=members(db,2026),id=name=>people.find(p=>p.name===name).id;
  savePartners(db,2026,{first:id('Alex'),second:id('Casey')});
  const result=await call('/admin/matching-test',{year:2026},admin);
  assert.equal(result.data.status,'impossible');assert.equal(result.data.checked,0);
  assert.equal((await call('/admin/draft',{year:2026},admin)).status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM assignments WHERE year=2026').get().n,0);
});

test('reviewed test reset clears only the current exchange, revokes access, preserves history and exact email records, and allows real invitations',async t=>{
  const {db,config,call,admin}=await fixture(t);seed(db);
  const people=members(db,2026),[a,b]=people;savePartners(db,2026,{first:a.id,second:b.id});
  db.prepare("UPDATE exchanges SET title='Synthetic exchange',budget='$20',event_date='December 25',allow_group_join=1 WHERE year=2026").run();
  db.prepare('UPDATE enrollments SET active=0 WHERE year=2026 AND person_id=?').run(b.id);
  db.prepare("UPDATE enrollments SET message='Private note',gifts=?,changes_requested='Please revise' WHERE year=2026").run(JSON.stringify([{label:'Book',url:'https://example.test/book'}]));
  const redeemed=await call('/redeem',{token:new URL(inviteLink(db,config,2026,a.id)).hash.slice(1)});
  const memberAuth={cookie:redeemed.cookie,csrf:redeemed.data.csrf};
  const oldInvite=new URL(inviteLink(db,config,2026,a.id)).hash.slice(1);
  const signinId=prepareSignIn(db,config,a.email),oldSignIn=db.prepare('SELECT body FROM outbox WHERE id=?').get(signinId).body.match(/\/join#([A-Za-z0-9_-]+)/)[1];
  db.prepare("INSERT INTO group_tokens(hash,year,expires) VALUES ('old-group',2026,?)").run(Date.now()+3600000);
  db.prepare("INSERT INTO submissions(id,year,name,email,wishlist) VALUES ('old-entry',2026,'Guest','guest@example.test','Private old submission')").run();
  db.prepare("INSERT INTO sessions(hash,role,csrf,year,person_id,expires) VALUES ('old-owner','submission','csrf',2026,'old-entry',?)").run(Date.now()+3600000);
  prepareMail(db,config,2026,'invite');
  db.prepare("UPDATE outbox SET status='sent',attempts=1,sent_at='2026-10-15 12:00:00' WHERE kind='invite' AND giver=?").run(a.id);
  draftDraw(db,2026);
  const stable={people:db.prepare('SELECT * FROM people ORDER BY id').all(),partners:db.prepare('SELECT * FROM partners').all(),
    past:db.prepare('SELECT * FROM assignments WHERE year<2026 ORDER BY year,giver').all(),years:db.prepare('SELECT * FROM exchanges WHERE year<2026 ORDER BY year').all(),
    rate:db.prepare('SELECT * FROM sign_in_requests').all()};
  const read=async()=>(await call('/admin/state?year=2026',undefined,admin)).data;
  let state=await read(),body={year:2026,confirm:'RESET 2026',review:state.reset.review};
  assert.equal(JSON.stringify(state).includes('Private note'),false);assert.equal(JSON.stringify(state).includes('Private old submission'),false);
  assert.equal((await call('/admin/reset',body)).status,403);
  assert.equal((await call('/admin/reset',body,{...admin,csrf:'wrong'})).status,403);
  assert.equal((await call('/admin/reset',body,{...admin,headers:{Origin:'https://attacker.test'}})).status,403);
  assert.equal((await call('/admin/reset',{...body,confirm:'RESET'},admin)).status,400);
  assert.equal((await call('/admin/reset',{...body,year:2025},admin)).status,400);
  db.prepare("UPDATE enrollments SET wishlist='Changed private list' WHERE year=2026 AND person_id=?").run(a.id);
  assert.match((await call('/admin/reset',body,admin)).data.error,/changed/);
  state=await read();body.review=state.reset.review;
  const oldMail=db.prepare('SELECT * FROM outbox WHERE year=2026 ORDER BY id').all();
  assert.equal((await call('/admin/reset',body,admin)).status,200);
  assert.equal((await call('/admin/reset',body,admin)).status,400);
  for(const table of ['invite_tokens','sign_in_tokens','group_tokens','submissions','assignments','outbox'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE year=2026`).get().n,0,table);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE year=2026 AND role<>'admin'").get().n,0);
  assert.equal((await call('/member/profile',undefined,memberAuth)).status,403);
  assert.equal((await call('/redeem',{token:oldInvite})).status,401);
  assert.equal((await call('/redeem',{token:oldSignIn})).status,401);
  for(const p of members(db,2026)){assert.equal(p.wishlist,'');assert.equal(p.message,'');assert.deepEqual(p.gifts,[]);assert.equal(p.changes_requested,'');}
  assert.deepEqual(db.prepare('SELECT * FROM people ORDER BY id').all(),stable.people);
  assert.deepEqual(db.prepare('SELECT * FROM partners').all(),stable.partners);
  assert.deepEqual(db.prepare('SELECT * FROM assignments WHERE year<2026 ORDER BY year,giver').all(),stable.past);
  assert.deepEqual(db.prepare('SELECT * FROM exchanges WHERE year<2026 ORDER BY year').all(),stable.years);
  assert.deepEqual(db.prepare('SELECT * FROM sign_in_requests').all(),stable.rate);
  assert.equal(members(db,2026).find(p=>p.id===b.id).active,0);
  const exchange=db.prepare('SELECT * FROM exchanges WHERE year=2026').get();
  assert.equal(exchange.state,'open');assert.equal(exchange.title,'Synthetic exchange');assert.equal(exchange.budget,'$20');assert.equal(exchange.event_date,'December 25');assert.equal(exchange.allow_group_join,0);
  const archive=db.prepare('SELECT * FROM exchange_resets WHERE year=2026').get();
  assert.deepEqual(JSON.parse(archive.delivery_records),JSON.parse(JSON.stringify(oldMail)));
  const exported=await call('/admin/export',undefined,admin);
  assert.deepEqual(exported.data.resets[0].delivery_records,JSON.parse(JSON.stringify(oldMail)));
  state=await read();assert.equal(state.outbox.length,0);assert.equal(state.resets.length,1);assert.equal(state.resets[0].delivery_records,undefined);
  assert.equal((await call('/admin/invitations/send',{year:2026,confirm:'SEND',recipients:[{id:a.id,email:a.email}]},admin)).status,200);
  const newMail=db.prepare("SELECT * FROM outbox WHERE year=2026 AND kind='invite'").get();assert.equal(newMail.status,'preview');
  const freshToken=newMail.body.match(/\/join#([A-Za-z0-9_-]+)/)[1];assert.notEqual(freshToken,oldInvite);
  const fresh=await call('/redeem',{token:freshToken});assert.equal(fresh.status,200);
  const freshAuth={cookie:fresh.cookie,csrf:fresh.data.csrf};
  assert.equal((await call('/member/profile',undefined,freshAuth)).data.person.wishlist,'');
  assert.equal((await call('/member/profile',{wishlist:'New real list',message:'New note',gifts:[]},freshAuth)).status,200);
  assert.equal((await read()).people.find(p=>p.id===a.id).validation.submitted,true);
  assert.equal((await call('/member/profile',{wishlist:'Stale overwrite',gifts:[]},memberAuth)).status,403);
  assert.equal(members(db,2026).find(p=>p.id===a.id).wishlist,'New real list');
});

test('reset protects finalized history, uncertain deliveries and an in-flight batch without changing anything',async t=>{
  let accept,started;const begun=new Promise(resolve=>{started=resolve;}),release=new Promise(resolve=>{accept=resolve;});
  const transport={async sendMail(mail){started();await release;return {accepted:[mail.to],rejected:[]};}};
  const {db,config,call,admin}=await fixture(t,{emailMode:'smtp',transport});seed(db);config.smtp.from='sender@example.test';
  const [a]=members(db,2026);prepareMail(db,config,2026,'invite',[a.id]);
  let preview=resetPreview(db,2026);
  const delivery=call('/admin/mail/send',{year:2026,confirm:'SEND'},admin);await begun;
  try {assert.match((await call('/admin/reset',{year:2026,confirm:'RESET 2026',review:preview.review},admin)).data.error,/delivery has finished/);}
  finally {accept();await delivery;}
  db.prepare("UPDATE outbox SET status='uncertain' WHERE year=2026").run();
  const before=JSON.stringify(db.prepare('SELECT * FROM outbox').all());preview=resetPreview(db,2026);
  assert.match(preview.blocked,/uncertain/);
  assert.equal((await call('/admin/reset',{year:2026,confirm:'RESET 2026',review:preview.review},admin)).status,400);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM outbox').all()),before);
  db.prepare("UPDATE outbox SET status='sent' WHERE year=2026").run();draftDraw(db,2026);lockDraw(db,2026);
  preview=resetPreview(db,2026);assert.match(preview.blocked,/Finalized/);
  const locked=JSON.stringify(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all());
  assert.equal((await call('/admin/reset',{year:2026,confirm:'RESET 2026',review:preview.review},admin)).status,400);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM assignments ORDER BY year,giver').all()),locked);
  assert.equal(db.prepare('SELECT count(*) AS n FROM exchange_resets').get().n,0);
});
