import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { createOrderService, validMailbox } from './app.mjs';
import { scanWithClamd } from './clamav.mjs';

// Never print process.env, SMTP replies or request bodies.
const required=name=>{const value=process.env[name];if(!value)throw new Error(`Missing required setting: ${name}`);return value;};
const integer=(name,fallback,min,max)=>{const value=Number(process.env[name]||fallback);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid setting: ${name}`);return value;};
const production=process.env.NODE_ENV!=='development';
const smtpPort=integer('SMTP_PORT',465,1,65535);
if(production && ![465,587].includes(smtpPort)) throw new Error('Production SMTP_PORT must be 465 or 587');
const transport=nodemailer.createTransport({
  host:required('SMTP_HOST'),port:smtpPort,secure:smtpPort===465,requireTLS:production,
  auth:{user:required('SMTP_USER'),pass:required('SMTP_PASSWORD')},
  tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
  connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,
  disableFileAccess:true,disableUrlAccess:true,
});
const recipient=process.env.ORDER_TO||'Fedor.fiberflex@gmail.com';
if(!validMailbox(recipient))throw new Error('Invalid ORDER_TO');
const app=await createOrderService({
  dbPath:resolve(required('ORDER_DB_PATH')),
  origins:required('ORDER_ALLOWED_ORIGINS').split(',').map(value=>value.trim()),
  adminToken:required('ORDER_ADMIN_TOKEN'),recipients:{ru:recipient,en:recipient},mailFrom:required('ORDER_FROM'),
  production,retentionDays:integer('ORDER_RETENTION_DAYS',90,1,3650),rateLimit:integer('ORDER_RATE_LIMIT',10,1,10000),
  trustedProxies:(process.env.ORDER_TRUSTED_PROXIES||'').split(',').filter(Boolean),
  sendMail:async(message)=>{
    const result=await transport.sendMail(message);
    if(!result.accepted?.length || result.rejected?.length)throw new Error('notification_not_accepted');
  },
  scanFile:buffer=>scanWithClamd(buffer,{host:process.env.CLAMD_HOST||'127.0.0.1',port:integer('CLAMD_PORT',3310,1,65535)}),
});
const port=integer('ORDER_PORT',8787,1,65535);
app.server.listen(port,process.env.ORDER_HOST||'127.0.0.1',()=>console.log(JSON.stringify({event:'order_api_ready',port})));
app.server.on('error',()=>{console.error(JSON.stringify({event:'order_api_start_failed'}));process.exitCode=1;});
let stopping=false;
const timer=setInterval(()=>app.flushOutbox().catch(()=>console.error(JSON.stringify({event:'outbox_worker_failed'}))),5000);
timer.unref();
await app.flushOutbox();
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);await app.close();transport.close();}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>stop().catch(()=>{process.exitCode=1;}));
