import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, audit, getExchange, members, transaction, importHistory } from './database.js';
import { createExchange, savePerson, emailValid, matchingOptions, historyReadiness, mutable, invalidateDraft, draftDraw,
  lockDraw, inviteLink, prepareMail, normalizeEmail, checkEmailIdentity, clearChangesRequest, matchingTest, setParticipation, prepareInvitations, prepareTestInvitations, isHistoricalExchange, invitationStatus, prepareInvitationResend, retireEmailAccess } from './service.js';
import { secret, hash, passwordMatches, readConfig } from './security.js';
import { createMailer } from './mail.js';
import { prepareSignIn, consumeSignIn, expireSignIns } from './signin.js';
import { groupLink, submissionProfile, saveSubmission, listSubmissions, approveSubmission, rejectSubmission } from './submissions.js';
import { checkedWishlist, validateWishlist } from './validation.js';
import { validateDraw } from './matching.js';
import { savePartners, saveExclusion, resetPreview, resetExchange } from './exchange-management.js';

export function createApp(config,db,providedTransport) {
  const app = express();
  const mailer = createMailer(db,config,providedTransport);
  const attempts = new Map();
  app.disable('x-powered-by');
  if(config.trustProxyHops)app.set('trust proxy',config.trustProxyHops);
  app.use((req,res,next)=>{
    res.set({'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
      'Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cache-Control':'no-store'});
    if (config.secure) res.set('Strict-Transport-Security','max-age=31536000');
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      if (req.get('origin') !== config.publicUrl) return res.status(403).json({error:'Request origin is not allowed.'});
      if (!req.is('application/json')) return res.status(415).json({error:'Send JSON requests.'});
    }
    next();
  });
  app.use(express.json({limit:'128kb'}));
  app.get('/health',(_req,res)=>{db.prepare('SELECT 1').get();res.json({ok:true});});
  app.use('/api',(req,res,next)=>{
    const value = (req.headers.cookie || '').split(';').map(p=>p.trim()).find(p=>p.startsWith('santa_session='))?.slice(14);
    req.session = value && db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(hash(value),Date.now());
    if (req.session && ['POST','PUT','PATCH','DELETE'].includes(req.method) && !['/login','/redeem','/sign-in','/group/redeem'].includes(req.path.toLowerCase())) {
      if (req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({error:'Refresh the page and try again.'});
    }
    next();
  });
  const fail = (res,error,status=400)=>res.status(status).json({error:error.message});
  const sessionCookie = (res, token, maxAge)=>res.cookie('santa_session',token,{httpOnly:true,secure:config.secure,sameSite:'strict',path:'/',maxAge});
  const makeSession = (res,role,personId=null,year=null,freshStart=false)=>{
    const token = secret(), csrf = secret(), duration = role==='admin' ? 8*3600000 : 30*86400000;
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('DELETE FROM invite_tokens WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO sessions(hash,role,csrf,person_id,year,expires,fresh_start) VALUES (?,?,?,?,?,?,?)').run(hash(token),role,csrf,personId,year,Date.now()+duration,freshStart?1:0);
    sessionCookie(res,token,duration);
    return {role,csrf,year};
  };
  function limiter(req,res,next) {
    const now = Date.now(), key = `${req.route.path}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    for (const [ip,entry] of attempts) if (entry.until < now) attempts.delete(ip);
    if (!attempts.has(key) && attempts.size >= 1000) return res.status(429).json({error:'Too many login requests. Try again later.'});
    const entry = attempts.get(key) || {count:0,until:now+15*60000};
    attempts.set(key,entry);
    if (++entry.count > 15) return res.status(429).json({error:'Too many login attempts. Try again in fifteen minutes.'});
    next();
  }
  function submissionLimiter(req,res,next) {
    const key=`save:${req.session.hash}`,now=Date.now();
    for(const [id,entry] of attempts)if(entry.until<now)attempts.delete(id);
    if(!attempts.has(key) && attempts.size>=1000)return res.status(429).json({error:'Please try again later.'});
    const entry=attempts.get(key)||{count:0,until:now+15*60000};attempts.set(key,entry);
    if(++entry.count>30)return res.status(429).json({error:'Your list is saved. Wait fifteen minutes before making more changes.'});
    next();
  }
  const confirmReveal=req=>{if(req.body.confirm!=='REVEAL')throw new Error('Confirm that you want to reveal private content.');};
  const drawStatus=year=>{
    const people=members(db,year).filter(p=>p.active),pairs=db.prepare('SELECT giver,recipient FROM assignments WHERE year=?').all(year);
    const issues=pairs.length?validateDraw(pairs,people.map(p=>p.id),matchingOptions(db,year)):['Generate a draft first.'];
    return {count:pairs.length,passed:!issues.length,issues};
  };
  app.post('/api/login',limiter,(req,res)=>{
    if (!passwordMatches(req.body.password,config.password)) return res.status(401).json({error:'Incorrect organizer password.'});
    if (req.session) db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash);
    res.json(makeSession(res,'admin'));
  });
  app.post('/api/sign-in',limiter,(req,res)=>{
    const mode=config.emailMode==='preview'?'preview':mailer.ready?'email':'unavailable';
    const id=mode==='unavailable'?null:prepareSignIn(db,config,req.body.email);
    // Respond before SMTP to keep timing and responses independent of roster membership.
    res.status(202).json({ok:true,mode});
    if (id) mailer.deliverSignIn(id).catch(()=>{
      // Do not log addresses, message bodies, links, or provider credentials.
      console.error('Could not deliver an Ornament sign-in email. Check the organizer email records.');
    });
  });
  app.post('/api/redeem',limiter,(req,res)=>{
    const token = typeof req.body.token==='string' ? req.body.token : '';
    if (token.length!==43) return res.status(401).json({error:'This link is invalid or expired. Request a new link from the homepage.'});
    const result=transaction(db,()=>{
      const tokenHash=hash(token);
      const invite=consumeSignIn(db,tokenHash) || db.prepare(`SELECT t.* FROM invite_tokens t JOIN people p ON p.id=t.person_id
        JOIN enrollments e ON e.person_id=t.person_id AND e.year=t.year JOIN exchanges x ON x.year=t.year
        WHERE t.hash=? AND t.expires>? AND t.email=lower(trim(p.email)) AND e.active=1 AND x.state IN ('open','drafted','locked')
        AND (t.fresh_start=0 OR x.state IN ('open','drafted'))`).get(tokenHash,Date.now());
      if (!invite) return null;
      db.prepare('DELETE FROM invite_tokens WHERE hash=?').run(tokenHash);
      if (req.session) db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash);
      return makeSession(res,'member',invite.person_id,invite.year,Boolean(invite.fresh_start));
    });
    if (!result) return res.status(401).json({error:'This link is invalid or expired. Request a new link from the homepage.'});
    res.json(result);
  });
  app.post('/api/group/redeem',limiter,(req,res)=>{
    const token=typeof req.body.token==='string'?req.body.token:'';
    const invite=token.length===43 && db.prepare('SELECT year FROM group_tokens WHERE hash=? AND expires>?').get(hash(token),Date.now());
    if (!invite) return res.status(401).json({error:'This group link is invalid or expired. Ask your organizer for a new one.'});
    if (req.session?.role==='submission' && req.session.year===invite.year) {
      return res.json({role:'submission',csrf:req.session.csrf,year:invite.year});
    }
    if(!getExchange(db,invite.year).allow_group_join)throw new Error('Group registration is closed. Use your emailed invitation or sign in.');
    mutable(db,invite.year);
    const result=transaction(db,()=>{
      if (req.session) db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash);
      return makeSession(res,'group',null,invite.year);
    });
    res.json(result);
  });
  app.get('/api/session',(req,res)=>{
    if (!req.session) return res.status(401).json({error:'Please sign in.'});
    res.json({role:req.session.role,csrf:req.session.csrf,year:req.session.year});
  });
  app.post('/api/logout',(req,res)=>{
    if (req.session) db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash);
    res.clearCookie('santa_session',{path:'/',secure:config.secure,httpOnly:true,sameSite:'strict'}).json({ok:true});
  });
  app.use('/api/admin',(req,res,next)=>{
    if (req.session?.role!=='admin') return res.status(403).json({error:'Organizer access required.'});
    next();
  });
  app.get('/api/admin/state',(req,res)=>{
    expireSignIns(db);
    const exchanges = db.prepare('SELECT * FROM exchanges ORDER BY year DESC').all();
    const currentYears=exchanges.filter(e=>!isHistoricalExchange(e)).map(e=>e.year);
    const historyYears=exchanges.filter(isHistoricalExchange).map(e=>e.year);
    const year = req.query.year?Number(req.query.year):(currentYears[0]||null);
    const exchange = exchanges.find(e=>e.year===year) || null;
    const people = exchange ? members(db,year).map(p=>({id:p.id,name:p.name,email:p.email,aliases:p.aliases,active:p.active,
      validation:validateWishlist(p,p.email),changesRequested:p.changes_requested,invitation:invitationStatus(db,year,p)})) : [];
    res.json({exchanges,currentYears,historyYears,year,exchange,people,identities:db.prepare('SELECT id,name,email,aliases FROM people ORDER BY name COLLATE NOCASE').all().map(p=>({...p,aliases:JSON.parse(p.aliases)})),submissions:exchange?listSubmissions(db,year):[],
      exclusions:exchange ? matchingOptions(db,year).exclusions : [],
      extraExclusions:exchange ? db.prepare('SELECT giver,recipient FROM exclusions WHERE year=? ORDER BY giver,recipient').all(year) : [],
      partners:exchange ? db.prepare('SELECT first,second FROM partners WHERE year=? ORDER BY first').all(year) : [],
      reset:exchange ? resetPreview(db,year) : null,
      resets:exchange ? db.prepare('SELECT id,summary,created_at FROM exchange_resets WHERE year=? ORDER BY created_at DESC').all(year).map(r=>({...r,summary:JSON.parse(r.summary)})) : [],
      assignments:exchange?.state==='archived' ? db.prepare('SELECT giver,recipient FROM assignments WHERE year=?').all(year) : [],
      draw:exchange?drawStatus(year):null,
      history:exchange ? historyReadiness(db,year) : [],
      outbox:exchange ? db.prepare('SELECT id,giver,kind,recipient_email,subject,status,error,attempts,sent_at FROM outbox WHERE year=? ORDER BY kind,giver').all(year) : [],
      emailMode:config.emailMode,smtpReady:mailer.ready,
      audit:db.prepare('SELECT action,detail,created_at FROM audit ORDER BY id DESC LIMIT 20').all()});
  });
  app.post('/api/admin/wishlist/reveal',(req,res)=>{
    confirmReveal(req);const year=Number(req.body.year),person=members(db,year).find(p=>p.id===req.body.personId);
    if(!person)throw new Error('Choose a participant in this exchange.');
    audit(db,'reveal-wishlist',{year,personId:person.id});
    res.json({name:person.name,wishlist:person.wishlist,message:person.message,gifts:person.gifts});
  });
  app.post('/api/admin/submissions/reveal',(req,res)=>{
    confirmReveal(req);const row=db.prepare('SELECT year,name FROM submissions WHERE id=?').get(req.body.id);
    if(!row)throw new Error('Choose a saved submission.');
    audit(db,'reveal-submission',{year:row.year,id:req.body.id});
    res.json({...submissionProfile(db,row.year,req.body.id),name:row.name});
  });
  app.post('/api/admin/draw/reveal',(req,res)=>{
    confirmReveal(req);const year=Number(req.body.year);getExchange(db,year);
    audit(db,'reveal-draw',{year});res.json({assignments:db.prepare('SELECT giver,recipient FROM assignments WHERE year=?').all(year)});
  });
  app.post('/api/admin/mail/preview',(req,res)=>{
    confirmReveal(req);expireSignIns(db);
    const mail=db.prepare('SELECT subject,recipient_email,body,year FROM outbox WHERE id=?').get(req.body.id);
    if(!mail)throw new Error('Choose a prepared email.');
    audit(db,'reveal-email',{year:mail.year,id:req.body.id});res.json(mail);
  });
  app.post('/api/admin/changes-request',(req,res)=>{
    const year=Number(req.body.year),exchange=getExchange(db,year),person=members(db,year).find(p=>p.id===req.body.personId);
    const note=typeof req.body.note==='string'?req.body.note.trim():'';
    if(!['open','drafted','locked'].includes(exchange.state)||!person?.active||!emailValid(person.email)||!note||note.length>1000)throw new Error('Choose an active person and add a correction request under 1,000 characters.');
    transaction(db,()=>{
      db.prepare('UPDATE enrollments SET changes_requested=? WHERE year=? AND person_id=?').run(note,year,person.id);
      const id=randomUUID();
      db.prepare('INSERT INTO outbox(id,year,giver,kind,recipient_email,subject,body) VALUES (?,?,?,?,?,?,?)').run(id,year,person.id,`revision:${id}`,person.email,
        `${exchange.title}: update your wish list`,`Hi ${person.name},\n\nYour organizer for ${exchange.title} asked for an update to your wish list:\n\n${note}\n\nOpen Ornament and request a sign-in email to edit and submit your wish list again:\n${config.publicUrl}/join\n\nYour sign-in email works once and is valid for 15 minutes.\n\nSent by Ornament for ${exchange.title}.`);
      audit(db,'request-wishlist-changes',{year,personId:person.id});
    });res.json({ok:true});
  });
  app.post('/api/admin/group-settings',(req,res)=>{
    const year=Number(req.body.year);mutable(db,year);
    if(typeof req.body.enabled!=='boolean')throw new Error('Choose whether to allow group registration.');
    transaction(db,()=>{
      db.prepare('UPDATE exchanges SET allow_group_join=? WHERE year=?').run(req.body.enabled?1:0,year);
      if(!req.body.enabled){db.prepare('DELETE FROM group_tokens WHERE year=?').run(year);db.prepare("DELETE FROM sessions WHERE role='group' AND year=?").run(year);}
      audit(db,'group-registration',{year,enabled:req.body.enabled});
    });res.json({ok:true});
  });
  app.get('/api/admin/export',(_req,res)=>{
    const exported = {schema:1,exportedAt:new Date().toISOString(),people:db.prepare('SELECT * FROM people').all(),
      exchanges:db.prepare('SELECT * FROM exchanges').all(),enrollments:db.prepare('SELECT * FROM enrollments').all(),
      assignments:db.prepare('SELECT * FROM assignments').all(),exclusions:db.prepare('SELECT * FROM exclusions').all(),
      partners:db.prepare('SELECT * FROM partners').all(),
      resets:db.prepare('SELECT * FROM exchange_resets').all().map(r=>({...r,summary:JSON.parse(r.summary),delivery_records:JSON.parse(r.delivery_records)}))};
    res.set('Content-Disposition','attachment; filename="secret-santa-history.json"').json(exported);
  });
  app.post('/api/admin/exchanges',(req,res)=>{
    if(Number(req.body.year)<new Date().getFullYear())throw new Error('Add past years from History. New exchanges must be for the current year or later.');
    const result = createExchange(db,Number(req.body.year),Number(req.body.copyFrom)||null);
    res.json(result);
  });
  app.post('/api/admin/history',(req,res)=>{res.json({assignments:importHistory(db,req.body)});});
  app.get('/api/admin/history/record',(req,res)=>{
    const year=Number(req.query.year);
    if(!Number.isInteger(year)||year<2000||year>2200)throw new Error('Choose a valid history year.');
    const exchange=db.prepare('SELECT year,state,history_status,source FROM exchanges WHERE year=?').get(year);
    if(!exchange)return res.json({year,exists:false,state:'missing',history_status:'missing',source:'',pairs:[],participantIds:[],canEdit:true,canConfirm:false});
    if(!isHistoricalExchange(exchange))throw new Error('Current matches stay private. Use the Draw reveal action to view them.');
    const pairs=db.prepare(`SELECT giver.name AS giver,recipient.name AS recipient FROM assignments a
      JOIN people giver ON giver.id=a.giver JOIN people recipient ON recipient.id=a.recipient
      WHERE a.year=? ORDER BY giver.name COLLATE NOCASE`).all(year);
    const readiness=historyReadiness(db,year+1)[0];
    res.json({...exchange,status:readiness.status,exists:true,pairs,participantIds:members(db,year).filter(p=>p.active).map(p=>p.id),
      canEdit:['archived','no_exchange'].includes(exchange.state),
      canConfirm:exchange.state==='archived'&&readiness.status==='provisional'});
  });
  app.post('/api/admin/history/none',(req,res)=>{
    const year=Number(req.body.year);
    if(!Number.isInteger(year)||year<2000||year>2200||req.body.confirm!=='NO EXCHANGE')throw new Error('Enter a valid year and type NO EXCHANGE to confirm that no draw happened.');
    const existing=db.prepare('SELECT state FROM exchanges WHERE year=?').get(year);
    if(existing && existing.state!=='no_exchange')throw new Error('An existing exchange cannot be replaced with an empty year.');
    transaction(db,()=>{
      db.prepare("INSERT OR REPLACE INTO exchanges(year,title,state,history_status,source) VALUES (?,?,'no_exchange','verified','Organizer confirmed that no exchange took place')").run(year,`No exchange — ${year}`);
      for(const row of db.prepare("SELECT year FROM exchanges WHERE state='drafted' AND year IN (?,?)").all(year+1,year+2))invalidateDraft(db,row.year);
      audit(db,'confirm-no-exchange',{year});
    });res.json({ok:true});
  });
  app.post('/api/admin/history/confirm',(req,res)=>{
    const year = Number(req.body.year);
    const exchange = getExchange(db,year);
    if (exchange.state!=='archived') throw new Error('Only imported historical exchanges need confirmation.');
    if (!db.prepare('SELECT giver FROM assignments WHERE year=?').get(year)) throw new Error('No history has been imported.');
    if(historyReadiness(db,year+1)[0].status==='incomplete')throw new Error('The recorded pairings do not match that year’s participant list. Update the history before confirming it.');
    db.prepare("UPDATE exchanges SET history_status='verified' WHERE year=?").run(year);
    // A changed historical rule can invalidate any current draft.
    for (const row of db.prepare("SELECT year FROM exchanges WHERE state='drafted' AND year IN (?,?)").all(year+1,year+2)) invalidateDraft(db,row.year);
    audit(db,'confirm-history',{year});res.json({ok:true});
  });
  app.post('/api/admin/settings',(req,res)=>{
    const year = Number(req.body.year);mutable(db,year);
    transaction(db,()=>{
      db.prepare('UPDATE exchanges SET title=?,budget=?,event_date=?,no_reciprocal=0 WHERE year=?').run(
        String(req.body.title||`Family Christmas ${year}`).slice(0,100),String(req.body.budget||'').slice(0,80),
        String(req.body.event_date||'').slice(0,30),year);
      invalidateDraft(db,year);audit(db,'save-settings',{year});
    });res.json({ok:true});
  });
  app.post('/api/admin/people',(req,res)=>{
    if(mailer.busy)throw new Error('Wait until email delivery has finished before editing people.');
    res.json({id:savePerson(db,Number(req.body.year),req.body)});
  });
  app.post('/api/admin/participation',(req,res)=>{
    if(typeof req.body.active!=='boolean')throw new Error('Choose whether this person is taking part.');
    setParticipation(db,Number(req.body.year),req.body.id,req.body.active);res.json({ok:true});
  });
  app.post('/api/admin/invitations/send',async(req,res)=>{
    if(req.body.confirm!=='SEND')throw new Error('Confirm sending invitations.');
    if(mailer.busy)throw new Error('Wait until email delivery has finished.');
    if(config.emailMode==='smtp'&&!mailer.ready)throw new Error('Configure SMTP before sending invitation emails.');
    const year=Number(req.body.year),mailIds=prepareInvitations(db,config,year,req.body.recipients);
    await mailer.deliver(year,{mailIds});
    const counts={sent:0,preview:0,failed:0,uncertain:0};
    for(const id of mailIds) {
      const row=db.prepare('SELECT status FROM outbox WHERE id=?').get(id);
      if(row?.status in counts)counts[row.status]++;
    }
    res.json({count:mailIds.length,counts});
  });
  app.post('/api/admin/invitations/resend',async(req,res)=>{
    if(req.body.confirm!=='RESEND')throw new Error('Confirm resending this invitation.');
    if(mailer.busy)throw new Error('Wait until email delivery has finished.');
    if(config.emailMode==='smtp'&&!mailer.ready)throw new Error('Configure SMTP before sending invitation emails.');
    const year=Number(req.body.year),id=prepareInvitationResend(db,config,year,req.body.recipient);
    await mailer.deliver(year,{mailIds:[id]});
    const status=db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status;
    res.json({count:1,counts:{sent:status==='sent'?1:0,preview:status==='preview'?1:0,failed:status==='failed'?1:0,uncertain:status==='uncertain'?1:0}});
  });
  app.post('/api/admin/invitations/test',async(req,res)=>{
    if(req.body.confirm!=='TEST')throw new Error('Confirm sending fresh test invitations.');
    if(mailer.busy)throw new Error('Wait until email delivery has finished.');
    if(config.emailMode==='smtp'&&!mailer.ready)throw new Error('Configure SMTP before sending invitation emails.');
    const year=Number(req.body.year),mailIds=prepareTestInvitations(db,config,year,req.body.recipients);
    await mailer.deliver(year,{mailIds});
    const counts={sent:0,preview:0,failed:0,uncertain:0};
    for(const id of mailIds) {
      const row=db.prepare('SELECT status FROM outbox WHERE id=?').get(id);
      if(row?.status in counts)counts[row.status]++;
    }
    res.json({count:mailIds.length,counts});
  });
  app.post('/api/admin/contact',(req,res)=>{
    if(mailer.busy)throw new Error('Wait until email delivery has finished before changing an address.');
    const year=Number(req.body.year),id=req.body.id,email=normalizeEmail(req.body.email);
    if(!emailValid(email)||!db.prepare('SELECT person_id FROM enrollments WHERE year=? AND person_id=?').get(year,id))throw new Error('Choose an existing person and enter a valid email address.');
    checkEmailIdentity(db,email,id);
    transaction(db,()=>{
      const previous=db.prepare('SELECT email FROM people WHERE id=?').get(id);
      db.prepare('UPDATE people SET email=? WHERE id=?').run(email,id);
      if(normalizeEmail(previous.email)!==email)retireEmailAccess(db,year,id);
      audit(db,'correct-contact',{year,id});
    });res.json({ok:true});
  });
  app.post('/api/admin/partners',(req,res)=>{
    savePartners(db,Number(req.body.year),req.body);res.json({ok:true});
  });
  app.post('/api/admin/reset',(req,res)=>{
    if(mailer.busy)throw new Error('Wait until email delivery has finished.');
    res.json(resetExchange(db,Number(req.body.year),req.body));
  });
  app.post('/api/admin/exclusions',(req,res)=>{
    res.json(saveExclusion(db,Number(req.body.year),req.body));
  });
  app.post('/api/admin/draft',(req,res)=>{const year=Number(req.body.year);draftDraw(db,year);res.json({ok:true,draw:drawStatus(year)});});
  app.post('/api/admin/matching-test',(req,res)=>{
    const includePairings=req.body.showPairings===true;
    if(includePairings&&req.body.confirm!=='REVEAL')throw new Error('Confirm revealing test pairings before requesting names.');
    const now=Date.now(),key=`matching-test:${req.session.hash}`;
    for(const [id,entry] of attempts)if(entry.until<now)attempts.delete(id);
    const entry=attempts.get(key)||{count:0,until:now+15*60000};
    if(!attempts.has(key)&&attempts.size>=1000)return res.status(429).json({error:'Please try again later.'});
    attempts.set(key,entry);
    if(++entry.count>5)return res.status(429).json({error:'Wait fifteen minutes before running another matching test.'});
    res.json(matchingTest(db,Number(req.body.year),{includePairings}));
  });
  app.post('/api/admin/finalize',(req,res)=>{
    if (req.body.confirm !== 'FINALIZE') throw new Error('Type FINALIZE to confirm.');
    lockDraw(db,Number(req.body.year));res.json({ok:true});
  });
  app.post('/api/admin/link',(req,res)=>res.json({link:inviteLink(db,config,Number(req.body.year),req.body.personId)}));
  app.post('/api/admin/group-link',(req,res)=>res.json({link:groupLink(db,config,Number(req.body.year))}));
  app.post('/api/admin/group-revoke',(req,res)=>{
    const year=Number(req.body.year);getExchange(db,year);
    transaction(db,()=>{
      db.prepare('DELETE FROM group_tokens WHERE year=?').run(year);
      db.prepare("DELETE FROM sessions WHERE role='group' AND year=?").run(year);
      audit(db,'revoke-group-links',{year});
    });res.json({ok:true});
  });
  app.post('/api/admin/submissions/approve',(req,res)=>res.json({ok:true,personId:approveSubmission(db,req.body.id,req.body.personId)}));
  app.post('/api/admin/submissions/reject',(req,res)=>{rejectSubmission(db,req.body.id);res.json({ok:true});});
  app.post('/api/admin/revoke',(req,res)=>{
    const year = Number(req.body.year);
    transaction(db,()=>{
      db.prepare('DELETE FROM invite_tokens WHERE year=? AND person_id=?').run(year,req.body.personId);
      db.prepare('DELETE FROM sign_in_tokens WHERE year=? AND person_id=?').run(year,req.body.personId);
      db.prepare("DELETE FROM sessions WHERE role='member' AND year=? AND person_id=?").run(year,req.body.personId);
      db.prepare("DELETE FROM sessions WHERE role='submission' AND year=? AND person_id IN (SELECT id FROM submissions WHERE year=? AND person_id=?)").run(year,year,req.body.personId);
      audit(db,'revoke-links',{year,personId:req.body.personId});
    });res.json({ok:true});
  });
  app.post('/api/admin/mail/prepare',(req,res)=>{
    prepareMail(db,config,Number(req.body.year),req.body.kind,Array.isArray(req.body.ids)?req.body.ids:null);res.json({ok:true});
  });
  app.post('/api/admin/mail/send',async(req,res)=>{
    if (config.emailMode==='smtp' && req.body.confirm!=='SEND') throw new Error('Type SEND to confirm sending real emails.');
    await mailer.deliver(Number(req.body.year));res.json({ok:true});
  });
  app.post('/api/admin/mail/retry',(req,res)=>{
    const row = db.prepare('SELECT * FROM outbox WHERE id=?').get(req.body.id);
    if (row?.kind.startsWith('signin:')) throw new Error('Request a new sign-in link from the homepage.');
    if(row?.kind.startsWith('test-invite:')||row?.kind.startsWith('invite-resend:'))mutable(db,row.year);
    if (!row || !['failed','preview','uncertain'].includes(row.status)) throw new Error('Only failed, previewed, or reviewed uncertain messages can be retried.');
    if (row.status==='uncertain' && req.body.confirm!=='CHECKED') throw new Error('Confirm you checked the mailbox before retrying this uncertain email.');
    const person=db.prepare('SELECT email FROM people WHERE id=?').get(row.giver);
    if(!emailValid(person?.email))throw new Error('Correct this person’s email address first.');
    db.prepare("UPDATE outbox SET status='pending',error='',recipient_email=? WHERE id=?").run(person.email,row.id);
    audit(db,'queue-retry',{id:row.id,previous:row.status});res.json({ok:true});
  });
  app.use('/api/group',(req,res,next)=>{
    if (!['group','submission'].includes(req.session?.role)) return res.status(403).json({error:'Open the group link your organizer shared.'});
    if(req.session.role==='group' && !getExchange(db,req.session.year).allow_group_join)return res.status(403).json({error:'Group registration is closed.'});
    next();
  });
  app.get('/api/group/profile',(req,res)=>{
    const {year,role,person_id:id}=req.session;
    const exchange=getExchange(db,year);
    res.json({exchange:{year:exchange.year,title:exchange.title,budget:exchange.budget,eventDate:exchange.event_date,state:exchange.state},
      submission:role==='submission'?submissionProfile(db,year,id):null});
  });
  app.post('/api/group/profile',submissionLimiter,(req,res)=>{
    const {year,role,person_id:id}=req.session;
    const submissionId=saveSubmission(db,year,role==='submission'?id:null,req.body);
    if (role==='submission') return res.json({role,csrf:req.session.csrf,year});
    const result=transaction(db,()=>{
      db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash);
      return makeSession(res,'submission',submissionId,year);
    });res.json(result);
  });
  app.use('/api/member',(req,res,next)=>{
    if (req.session?.role!=='member') return res.status(403).json({error:'Sign in from the homepage.'});
    if(!db.prepare(`SELECT 1 FROM enrollments e JOIN exchanges x ON x.year=e.year WHERE e.year=? AND e.person_id=?
      AND e.active=1 AND x.state IN ('open','drafted','locked')`).get(req.session.year,req.session.person_id))return res.status(403).json({error:'Your participation is no longer active. Ask the organizer.'});
    if(req.session.fresh_start&&!['open','drafted'].includes(getExchange(db,req.session.year).state))return res.status(403).json({error:'The draw has been finalized. Sign in normally to open your saved list.'});
    next();
  });
  app.get('/api/member/profile',(req,res)=>{
    const {year,person_id:id}=req.session;
    const exchange = getExchange(db,year);
    const all = members(db,year);
    const person = all.find(p=>p.id===id);
    if (!person) return res.status(404).json({error:'You are no longer in this exchange.'});
    let recipient = null;
    if (exchange.state==='locked') {
      const pair = db.prepare('SELECT recipient FROM assignments WHERE year=? AND giver=?').get(year,id);
      const target = pair && all.find(p=>p.id===pair.recipient);
      if (target) recipient={name:target.name,wishlist:target.wishlist,message:target.message,gifts:target.gifts};
    }
    const freshStart=Boolean(req.session.fresh_start);
    res.json({exchange:{year:exchange.year,title:exchange.title,budget:exchange.budget,eventDate:exchange.event_date,state:exchange.state},freshStart,
      person:{name:person.name,active:Boolean(person.active),wishlist:freshStart?'':person.wishlist,message:freshStart?'':person.message,gifts:freshStart?[]:person.gifts,changesRequested:freshStart?'':person.changes_requested},recipient});
  });
  app.post('/api/member/profile',submissionLimiter,(req,res)=>{
    const {year,person_id:id}=req.session;
    if (!db.prepare('SELECT person_id FROM enrollments WHERE year=? AND person_id=?').get(year,id)) throw new Error('Participant not found.');
    const current=getExchange(db,year);
    if (current.state==='archived') throw new Error('This exchange is archived.');
    const email=db.prepare('SELECT email FROM people WHERE id=?').get(id).email;
    const content=checkedWishlist(req.body,email),{wishlist,message}=content,gifts=JSON.stringify(content.gifts);
    transaction(db,()=>{
      db.prepare('UPDATE enrollments SET wishlist=?,message=?,gifts=? WHERE year=? AND person_id=?').run(wishlist,message,gifts,year,id);
      db.prepare("UPDATE sessions SET fresh_start=0 WHERE role='member' AND year=? AND person_id=?").run(year,id);
      clearChangesRequest(db,year,id);
      db.prepare("UPDATE submissions SET wishlist=?,message=?,gifts=?,updated_at=CURRENT_TIMESTAMP WHERE year=? AND person_id=? AND status='approved'").run(wishlist,message,gifts,year,id);
      audit(db,'save-wishlist',{year,id});
    });res.json({ok:true});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
  const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
  app.get('/christmas-friends.png',(_req,res)=>res.redirect('/christmas-friends-1200.3ac4a7fd0f0f.webp'));
  app.use(express.static(publicDir,{maxAge:0,setHeaders(res,path){
    // Only fingerprinted public artwork may be reused without revalidation.
    if (/\/christmas-friends-(480|1200)\.[a-f0-9]{12}\.webp$/.test(path)) {
      res.setHeader('Cache-Control','public, max-age=31536000, immutable');
    }
  }}));
  for (const route of ['/','/admin','/join']) app.get(route,(_req,res)=>res.sendFile(resolve(publicDir,'index.html')));
  app.use((error,_req,res,_next)=>{
    if (error.type==='entity.parse.failed') return res.status(400).json({error:'Invalid JSON.'});
    if (error.type==='entity.too.large') return res.status(413).json({error:'The request is too large.'});
    if (error.code?.startsWith('ERR_SQLITE')) return res.status(500).json({error:'The database could not complete the request.'});
    fail(res,error);
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const config=readConfig();
  const db=openDatabase(config.dataDir);
  const server=createApp(config,db).listen(config.port,config.host,()=>console.log(`Ornament: ${config.publicUrl} · email mode: ${config.emailMode}`));
  const stop=()=>{server.close(()=>{db.close();process.exit(0);});};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
