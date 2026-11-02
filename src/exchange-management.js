import { randomUUID } from 'node:crypto';
import { audit, getExchange, transaction } from './database.js';
import { mutable, invalidateDraft } from './service.js';
import { hash } from './security.js';

export function savePartners(db,year,{first,second,remove=false}) {
  mutable(db,year);
  const ids=db.prepare('SELECT person_id FROM enrollments WHERE year=?').all(year).map(p=>p.person_id);
  if(first===second||!ids.includes(first)||!ids.includes(second))throw new Error('Choose two different people in this year’s roster.');
  [first,second]=[first,second].sort();
  return transaction(db,()=>{
    if(remove)db.prepare('DELETE FROM partners WHERE year=? AND first=? AND second=?').run(year,first,second);
    else {
      const existing=db.prepare('SELECT first,second FROM partners WHERE year=? AND (first IN (?,?) OR second IN (?,?))').all(year,first,second,first,second);
      if(existing.some(p=>p.first!==first||p.second!==second))throw new Error('One of these people already has a partner. Remove that pair before changing it.');
      db.prepare('INSERT OR IGNORE INTO partners(year,first,second) VALUES (?,?,?)').run(year,first,second);
    }
    invalidateDraft(db,year);
    audit(db,'save-partners',{year,first,second,remove:Boolean(remove)});
  });
}

export function saveExclusion(db,year,{giver,recipient,remove=false,bothDirections=false}) {
  mutable(db,year);
  if(typeof remove!=='boolean'||typeof bothDirections!=='boolean')throw new Error('Choose whether to add or remove this exclusion.');
  if(bothDirections&&!remove)throw new Error('Extra exclusions apply in one direction. Use Partners for couples, or add each direction separately.');
  const ids=db.prepare('SELECT person_id FROM enrollments WHERE year=?').all(year).map(p=>p.person_id);
  if(giver===recipient||!ids.includes(giver)||!ids.includes(recipient))throw new Error('Choose two different people in this year’s roster.');
  return transaction(db,()=>{
    const pairs=[[giver,recipient],...(bothDirections?[[recipient,giver]]:[])];
    let changes=0;
    for(const [from,to] of pairs)changes+=remove
      ?db.prepare('DELETE FROM exclusions WHERE year=? AND giver=? AND recipient=?').run(year,from,to).changes
      :db.prepare('INSERT OR IGNORE INTO exclusions(year,giver,recipient) VALUES (?,?,?)').run(year,from,to).changes;
    if(changes) {
      invalidateDraft(db,year);audit(db,'save-exclusions',{year,giver,recipient,remove,bothDirections});
    }
    return {ok:true,changed:Boolean(changes)};
  });
}

function resetData(db,year) {
  return {exchange:getExchange(db,year),
    enrollments:db.prepare('SELECT * FROM enrollments WHERE year=? ORDER BY person_id').all(year),
    submissions:db.prepare('SELECT * FROM submissions WHERE year=? ORDER BY id').all(year),
    assignments:db.prepare('SELECT * FROM assignments WHERE year=? ORDER BY giver').all(year),
    partners:db.prepare('SELECT * FROM partners WHERE year=? ORDER BY first').all(year),
    outbox:db.prepare('SELECT * FROM outbox WHERE year=? ORDER BY id').all(year)};
}
function summary(data) {
  return {people:data.enrollments.length,
    lists:data.enrollments.filter(p=>p.wishlist.trim()||p.message.trim()||JSON.parse(p.gifts).length||p.changes_requested).length,
    submissions:data.submissions.length,draftMatches:data.assignments.length,emails:data.outbox.length,
    sent:data.outbox.filter(m=>m.status==='sent').length};
}
export function resetPreview(db,year) {
  const data=resetData(db,year);
  const blocked=!['open','drafted'].includes(data.exchange.state)?'Finalized draws and historical years cannot be reset.':
    data.outbox.some(m=>m.status==='sending')?'Wait until email delivery has finished.':
    data.outbox.some(m=>m.status==='uncertain')?'Review uncertain deliveries in Delivery before resetting.':'';
  return {...summary(data),review:hash(JSON.stringify(data)),blocked};
}
export function resetExchange(db,year,{confirm,review}) {
  mutable(db,year);
  if(confirm!==`RESET ${year}`)throw new Error(`Type RESET ${year} to clear this year’s test data.`);
  const preview=resetPreview(db,year);
  if(preview.blocked)throw new Error(preview.blocked);
  if(review!==preview.review)throw new Error('This exchange changed. Close this dialog and review the reset again.');
  return transaction(db,()=>{
    const data=resetData(db,year),id=randomUUID();
    // Retain exact delivery records privately, including successful sends. Old links are revoked below.
    db.prepare('INSERT INTO exchange_resets(id,year,summary,delivery_records) VALUES (?,?,?,?)')
      .run(id,year,JSON.stringify(summary(data)),JSON.stringify(data.outbox));
    db.prepare('DELETE FROM sign_in_tokens WHERE year=?').run(year);
    db.prepare('DELETE FROM invite_tokens WHERE year=?').run(year);
    db.prepare('DELETE FROM group_tokens WHERE year=?').run(year);
    db.prepare("DELETE FROM sessions WHERE year=? AND role<>'admin'").run(year);
    db.prepare('DELETE FROM outbox WHERE year=?').run(year);
    db.prepare('DELETE FROM submissions WHERE year=?').run(year);
    db.prepare('DELETE FROM assignments WHERE year=?').run(year);
    db.prepare("UPDATE enrollments SET wishlist='',message='',gifts='[]',changes_requested='' WHERE year=?").run(year);
    db.prepare("UPDATE exchanges SET state='open',history_status='provisional',allow_group_join=0 WHERE year=?").run(year);
    audit(db,'reset-exchange',{year,id,...summary(data)});
    return {ok:true};
  });
}
