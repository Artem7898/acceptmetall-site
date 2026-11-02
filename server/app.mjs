import http from 'node:http';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isIP } from 'node:net';
import Busboy from 'busboy';
import { fileTypeFromBuffer } from 'file-type';

const MAX_FILE = 5 * 1024 * 1024;
const MAX_BODY = MAX_FILE + 100 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const LIMITS = { name:120, company:200, phone:40, email:254, category:40, product:200, grade:120, sizes:200, quantity:100, unit:40, standard:120, origin:120, deadline:200, comment:5000, message:5000, kind:10, lang:2, consent:3, website:200 };
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a,b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const validMailbox = value => typeof value === 'string' && value.length <= 254 && EMAIL.test(value) && !/[\r\n]/.test(value);

async function parseForm(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw fail(413, 'request_too_large');
  if (!/^multipart\/form-data;/i.test(req.headers['content-type'] || '')) throw fail(415, 'multipart_required');
  return new Promise((resolve,reject) => {
    let parser;
    try { parser = Busboy({ headers:req.headers, limits:{ fileSize:MAX_FILE, files:1, fields:23, fieldSize:20000, parts:24 } }); }
    catch { reject(fail(400,'invalid_multipart')); return; }
    const fields = Object.create(null);
    let file, total = 0, error;
    const bad = (status,code) => { error ||= fail(status,code); };
    parser.on('field',(name,value,info) => {
      if (!Object.hasOwn(LIMITS,name) || Object.hasOwn(fields,name)) bad(400,'unknown_or_duplicate_field');
      if(info.valueTruncated || info.nameTruncated) bad(413,'request_too_large');
      fields[name]=value;
    });
    parser.on('file',(name,stream,info) => {
      if (name !== 'file' || file) bad(400,'invalid_file_field');
      const chunks=[];
      stream.on('limit',()=>bad(413,'file_too_large'));
      stream.on('data',chunk=>chunks.push(chunk));
      stream.on('error',()=>bad(400,'invalid_multipart'));
      stream.on('end',()=> { if(info.filename) file={name:info.filename,declaredType:info.mimeType,buffer:Buffer.concat(chunks)}; });
    });
    for(const event of ['filesLimit','fieldsLimit','partsLimit']) parser.on(event,()=>bad(413,'request_too_large'));
    parser.on('error',()=> { reject(fail(400,'invalid_multipart')); req.resume(); });
    parser.on('close',()=> error ? reject(error) : resolve({fields,file}));
    req.on('data',chunk=> { total+=chunk.length; if(total>MAX_BODY) { bad(413,'request_too_large'); req.unpipe(parser); parser.destroy(); req.resume(); reject(error); } });
    req.on('aborted',()=> { parser.destroy(); reject(fail(400,'request_aborted')); });
    req.pipe(parser);
  });
}

function validate(fields) {
  for (const [name,value] of Object.entries(fields)) {
    if(value.length>LIMITS[name] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fail(422,'invalid_fields');
    fields[name]=value.trim();
  }
  if(!['quote','contact'].includes(fields.kind) || !['ru','en'].includes(fields.lang) || fields.consent!=='yes' || fields.website) throw fail(422,'invalid_fields');
  for(const name of ['name','phone','email',fields.kind==='quote'?'company':'message']) if(!fields[name]) throw fail(422,'invalid_fields');
  if(!validMailbox(fields.email) || !/^[+\d\s().-]{5,40}$/.test(fields.phone) || /[\r\n]/.test(fields.name+ (fields.company||''))) throw fail(422,'invalid_fields');
  if(fields.category && !['stainless','carbon','non-ferrous'].includes(fields.category)) throw fail(422,'invalid_fields');
  delete fields.website;
}

export async function createOrderService(options) {
  const { dbPath, origins, adminToken, recipients, mailFrom, sendMail, scanFile, production=true, clock=()=>Date.now(), rateLimit=10, retentionDays=90, trustedProxies=[] }=options;
  if(!dbPath || !origins?.length || !adminToken || adminToken.length<32 || !validMailbox(mailFrom) || !validMailbox(recipients?.ru) || !validMailbox(recipients?.en) || typeof sendMail!=='function' || !Number.isInteger(retentionDays) || retentionDays<1 || retentionDays>3650) throw new Error('Invalid order service configuration');
  for(const origin of origins) { const url=new URL(origin); if(url.origin!==origin || (url.protocol!=='https:' && (production || !['127.0.0.1','localhost'].includes(url.hostname)))) throw new Error('Invalid allowed origin'); }
  mkdirSync(dirname(dbPath),{ recursive:true,mode:0o700 });
  const db=new DatabaseSync(dbPath);
  chmodSync(dbPath,0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL,
    fields TEXT NOT NULL, created_at INTEGER NOT NULL, attachment BLOB, attachment_type TEXT,
    attachment_name TEXT, notification_status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, notified_at INTEGER
  ); CREATE INDEX IF NOT EXISTS pending_orders ON orders(notification_status,next_attempt);`);
  const requests=new Map();
  let active=0, flushing=null;
  const purge = () => {
    const result=db.prepare('DELETE FROM orders WHERE created_at < ?').run(clock()-retentionDays*86400000);
    if(result.changes) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  };
  purge();
  const summary = row => ({id:row.id, fields:JSON.parse(row.fields), createdAt:new Date(row.created_at).toISOString(), notificationStatus:row.notification_status, attempts:row.attempts, hasAttachment:!!row.has_attachment});
  async function flushOutbox() {
    if(flushing) return flushing;
    flushing=(async()=> {
      purge();
      const rows=db.prepare("SELECT id,fields,created_at,attempts,attachment_name,attachment_type,attachment IS NOT NULL AS has_attachment FROM orders WHERE notification_status='pending' AND next_attempt<=? ORDER BY created_at LIMIT 20").all(clock());
      for(const row of rows) {
        const fields=JSON.parse(row.fields);
        try {
          const attachment=row.has_attachment ? db.prepare('SELECT attachment FROM orders WHERE id=?').get(row.id)?.attachment : null;
          await sendMail({ from:mailFrom, to:recipients[fields.lang], replyTo:fields.email,
            subject:`Website order ${row.id}`, text:`Order: ${row.id}\nReceived: ${new Date(row.created_at).toISOString()}\n\n${Object.entries(fields).map(([key,value])=>`${key}: ${value}`).join('\n')}`,
            messageId:`<order-${row.id}@${mailFrom.split('@')[1]}>`,
            attachments:attachment?[{filename:row.attachment_name,content:Buffer.from(attachment),contentType:row.attachment_type}]:[] });
          db.prepare("UPDATE orders SET notification_status='sent', attempts=attempts+1, notified_at=? WHERE id=?").run(clock(),row.id);
        } catch {
          db.prepare('UPDATE orders SET attempts=attempts+1, next_attempt=? WHERE id=?').run(clock()+Math.min(3600000,30000*2**Math.min(row.attempts,7)),row.id);
          // Intentionally no fields, provider response, addresses or credentials in logs.
          console.error(JSON.stringify({event:'order_notification_retry',orderId:row.id,attempt:row.attempts+1}));
        }
      }
    })().finally(()=>{ flushing=null; });
    return flushing;
  }
  const server=http.createServer(async(req,res)=> {
    const origin=req.headers.origin;
    const allowed=origins.includes(origin);
    const headers={ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'", 'X-Frame-Options':'DENY' };
    if(production) headers['Strict-Transport-Security']='max-age=31536000';
    if(allowed) Object.assign(headers,{'Access-Control-Allow-Origin':origin, Vary:'Origin','Access-Control-Expose-Headers':'Retry-After'});
    const json=(status,value,extra={})=> { if(!res.headersSent) {res.writeHead(status,{...headers,...extra});res.end(JSON.stringify(value));} };
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET' && url.pathname==='/healthz') return json(200,{status:'ok'});
      if(url.pathname.startsWith('/api/admin/')) {
        if(req.method!=='GET') throw fail(405,'method_not_allowed');
        if(!equal(req.headers.authorization||'',`Bearer ${adminToken}`)) throw fail(401,'unauthorized');
        purge();
        if(url.pathname==='/api/admin/orders') {
          const offset=Number(url.searchParams.get('offset')||0);
          if(!Number.isSafeInteger(offset)||offset<0) throw fail(400,'invalid_offset');
          const rows=db.prepare('SELECT id,fields,created_at,notification_status,attempts,attachment IS NOT NULL AS has_attachment FROM orders ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET ?').all(offset);
          const pending=db.prepare("SELECT count(*) AS count FROM orders WHERE notification_status='pending'").get().count;
          return json(200,{orders:rows.map(summary),pendingNotifications:pending,nextOffset:rows.length===100?offset+100:null});
        }
        const match=url.pathname.match(/^\/api\/admin\/orders\/([a-f0-9-]{36})(\/attachment)?$/i);
        if(!match) throw fail(404,'not_found');
        const row=db.prepare(match[2] ? 'SELECT attachment,attachment_type,attachment_name FROM orders WHERE id=?' : 'SELECT id,fields,created_at,notification_status,attempts,attachment IS NOT NULL AS has_attachment FROM orders WHERE id=?').get(match[1]);
        if(!row) throw fail(404,'not_found');
        if(match[2]) {
          if(!row.attachment) throw fail(404,'not_found');
          res.writeHead(200,{...headers,'Content-Type':row.attachment_type,'Content-Disposition':`attachment; filename="${row.attachment_name}"`});res.end(Buffer.from(row.attachment));return;
        }
        return json(200,{order:summary(row)});
      }
      if(url.pathname!=='/api/orders') throw fail(404,'not_found');
      if(!allowed) throw fail(403,'origin_not_allowed');
      if(req.method==='OPTIONS') return json(204,{}, {'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Idempotency-Key','Access-Control-Max-Age':'600'});
      if(req.method!=='POST') throw fail(405,'method_not_allowed');
      const key=req.headers['idempotency-key'];
      if(typeof key!=='string'||!UUID.test(key)) throw fail(400,'invalid_idempotency_key');
      // Trust forwarding headers ONLY from explicitly configured reverse-proxy IPs.
      let ip=req.socket.remoteAddress;
      if(trustedProxies.includes(ip)) { const candidate=(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();if(isIP(candidate))ip=candidate; }
      const now=clock();
      for(const [address,entry] of requests) if(entry.until<=now) requests.delete(address);
      const entry=requests.get(ip)||{count:0,until:now+60000};
      if(++entry.count>rateLimit || requests.size>10000) return json(429,{error:'rate_limited'},{'Retry-After':String(Math.max(1,Math.ceil((entry.until-now)/1000)))});
      requests.set(ip,entry);
      if(active>=8) return json(503,{error:'busy'},{'Retry-After':'5'});
      active++;
      try {
        const {fields,file}=await parseForm(req);
        validate(fields);
        if(file && fields.kind!=='quote') throw fail(422,'invalid_fields');
        let type;
        if(file) {
          if(!file.buffer.length) throw fail(415,'unsupported_file');
          type=await fileTypeFromBuffer(file.buffer).catch(()=>null);
          const extensions={'application/pdf':['pdf'],'image/png':['png'],'image/jpeg':['jpg','jpeg']};
          const ext=file.name.split('.').at(-1).toLowerCase();
          if(!type || !extensions[type.mime]?.includes(ext) || (file.declaredType!=='application/octet-stream' && file.declaredType!==type.mime)) throw fail(415,'unsupported_file');
        }
        const canonical=JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a],[b])=>a.localeCompare(b))));
        const digest=hash(canonical+'\0'+(file?hash(file.buffer)+':'+type.mime+':'+file.name:''));
        purge();
        const old=db.prepare('SELECT id,digest FROM orders WHERE idempotency_key=?').get(key);
        if(old) { if(old.digest!==digest) throw fail(409,'idempotency_conflict');return json(200,{orderId:old.id,status:'received'}); }
        if(file) {
          if(typeof scanFile!=='function') throw fail(503,'scanner_unavailable');
          try { await scanFile(file.buffer); } catch(error) { if(error.code==='infected_file') throw fail(422,'infected_file'); throw fail(503,'scanner_unavailable'); }
        }
        const id=randomUUID();
        // Recheck key after asynchronous scanning to handle simultaneous retries.
        const existing=db.prepare('SELECT id,digest FROM orders WHERE idempotency_key=?').get(key);
        if(existing) { if(existing.digest!==digest) throw fail(409,'idempotency_conflict');return json(200,{orderId:existing.id,status:'received'}); }
        db.prepare('INSERT INTO orders(id,idempotency_key,digest,fields,created_at,attachment,attachment_type,attachment_name) VALUES(?,?,?,?,?,?,?,?)').run(id,key,digest,canonical,clock(),file?.buffer||null,type?.mime||null,file?`specification.${type.ext}`:null);
        json(201,{orderId:id,status:'received'});
      } finally { active--; }
    } catch(error) {
      if(!error.status) console.error(JSON.stringify({event:'order_api_error'}));
      json(error.status||503,{error:error.code||'service_unavailable'});
      req.resume();
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=50;
  return {server,db,flushOutbox,close:async()=>{if(server.listening) await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});if(flushing)await flushing;db.close();}};
}
