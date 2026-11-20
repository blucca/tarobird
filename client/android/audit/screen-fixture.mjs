// Synthetic screen peer: pinned TLS and real binary WebSockets, no capture/input.
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,createHash,sign,X509Certificate} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {createInterface} from 'node:readline';
import {WebSocketServer} from 'ws';
import path from 'node:path';
const sample=process.argv[3]?readFileSync(process.argv[3]):null;
const root=process.argv[2],openssl=args=>execFileSync('openssl',args,{cwd:root,stdio:'ignore'});
openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Synthetic Screen CA','-addext','basicConstraints=critical,CA:TRUE']);
writeFileSync(path.join(root,'leaf.ext'),'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
openssl(['req','-newkey','rsa:2048','-nodes','-keyout','screen.key','-out','screen.csr','-subj','/CN=Synthetic Screen']);
openssl(['x509','-req','-in','screen.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','screen.crt','-days','1','-extfile','leaf.ext']);
const cert=readFileSync(path.join(root,'screen.crt')),der=new X509Certificate(cert).raw;
const caDer=new X509Certificate(readFileSync(path.join(root,'ca.crt'))).raw;
writeFileSync(path.join(root,'ca.der'),caDer);
const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
const wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false}),joins=new Map(),clients=new Map(),paths=[],chatPaths=[],commands=[];
let helloCount=0,proofCount=0,holdProof=false;const held=new Map(),pendingAttach=new Map();
const server=createServer({key:readFileSync(path.join(root,'screen.key')),cert},(req,res)=>{
 const nonce=new URL(req.url,'https://localhost').searchParams.get('nonce');
 if(!req.url.startsWith('/api/tls-identity?')||!nonce) {res.writeHead(404);res.end();return;}
 proofCount++;const respond=()=>{
 const certificateSha256=createHash('sha256').update(der).digest('hex');
 const message=JSON.stringify(['tarocub/tls-identity/v1',publicKey,nonce,certificateSha256]);
 res.end(JSON.stringify({v:1,type:'tls.identity',publicKey,nonce,certificateSha256,signature:sign(null,Buffer.from(message),pair.privateKey).toString('base64')}));};
 if(holdProof){held.set(res,respond);res.once('close',()=>held.delete(res));return;}respond();
});
server.on('upgrade',(req,socket,head)=>{(req.url==='/ws'?chatPaths:paths).push(req.url);if(!['/ws','/screen/v1/control','/screen/v1/media'].includes(req.url)){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
const stream={type:'stream',streamGeneration:1,geometryRevision:1,codec:'h264',codecString:'avc1.42c01e',width:64,height:64,contentRect:{x:0,y:0,width:64,height:64}};
wss.on('connection',(ws,req)=>{if(req.url==='/ws'){ws.on('message',data=>ws.send(data.toString()));return;}let entry,role=req.url.endsWith('media')?'media':'control';ws.on('message',data=>{
 const value=JSON.parse(data.toString()); if(!entry) {
  entry=[...joins.values()].find(j=>(role==='media'?j.mediaTicket:j.controlTicket)===value.ticket);if(value.type!=='hello'||!entry){ws.terminate();return;}helloCount++;
  const group=clients.get(entry.session.id)||{};group[role]=ws;clients.set(entry.session.id,group);
  if(entry.fixtureMode==='no-attach')return;
  // A real Hub sends the session's state on control before 'attached'; these modes send messages first.
  const early=(state,extra={})=>ws.send(JSON.stringify({type:'state',session:{...entry.session,state,...extra},serverTime:Date.now(),controlPending:false,streamGeneration:1}));
  if(role==='control'){
   const mode=entry.fixtureMode;
   if(mode==='state-first')early('connecting');
   if(mode==='state-flood')for(let n=0;n<5;n++)early('connecting');
   if(mode==='state-oversize')for(let n=0;n<2;n++)early('connecting',{deviceName:'x'.repeat(9000)});
   if(mode==='foreign-state-first')ws.send(JSON.stringify({type:'state',session:{...entry.session,id:'other-session',state:'connecting'},serverTime:Date.now()}));
   if(mode==='ready-first')ws.send(JSON.stringify({type:'frame-ready',sessionId:entry.session.id,generation:entry.session.generation,streamGeneration:1,frameSequence:1,expiresAt:Date.now()+1000}));
   if(mode==='wrong-attached'){early('connecting');ws.send(JSON.stringify({type:'attached',sessionId:'other-session'}));return;}
   // A granted state arrives first and 'attached' waits for the 'attach' action (or never comes).
   if(mode==='held-state'){ws.send(JSON.stringify({type:'state',session:{...entry.session,state:'controlling'},serverTime:Date.now(),lease:{id:'L'.repeat(43),challenge:'C'.repeat(43),expiresAt:Date.now()+6000,challengeExpiresAt:Date.now()+6000}}));pendingAttach.set(entry.session.id,ws);return;}
  }
  ws.send(JSON.stringify({type:'attached',sessionId:entry.session.id}));
  if(role==='media'){ws.send(JSON.stringify(stream));if(sample&&entry.fixtureMode==='frame'){const b=Buffer.alloc(32+sample.length);b[0]=1;b[1]=1;b.writeUInt16LE(1,2);b.writeUInt32LE(1,4);b.writeUInt32LE(1,8);b.writeUInt32LE(1,12);b.writeDoubleLE(Date.now(),16);b.writeUInt16LE(64,24);b.writeUInt16LE(64,26);b.writeUInt32LE(sample.length,28);sample.copy(b,32);ws.send(b);}}else ws.send(JSON.stringify({type:'state',session:entry.session,serverTime:Date.now()}));
 } else {commands.push({id:entry.session.id,role,value});if(entry.fixtureMode==='frame'&&entry.session.controlAllowed&&value.type==='control')ws.send(JSON.stringify({type:'state',session:{...entry.session,state:'controlling'},serverTime:Date.now(),lease:{id:'L'.repeat(43),challenge:'C'.repeat(43),expiresAt:Date.now()+6000,challengeExpiresAt:Date.now()+6000}}));}
 });});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({url:`https://127.0.0.1:${server.address().port}`,publicKey,certificateAuthority:caDer.toString('base64')}));
for await(const line of createInterface({input:process.stdin})){
 const input=JSON.parse(line),group=clients.get(input.id);
 if(input.action==='register'){joins.set(input.join.session.id,input.join);console.log('{}');}
 else if(input.action==='frame'){
  const b=Buffer.alloc(input.size??300032,97);b[0]=1;b[1]=1;b.writeUInt16LE(1,2);b.writeUInt32LE(input.sequence??1,4);b.writeUInt32LE(1,8);b.writeUInt32LE(1,12);b.writeDoubleLE(Date.now(),16);b.writeUInt16LE(64,24);b.writeUInt16LE(64,26);b.writeUInt32LE(b.length-32,28);if(input.malformed)b[0]=2;group.media.send(b);console.log('{}');
 } else if(input.action==='json-burst'){for(let n=0;n<input.count;n++)group.control.send(JSON.stringify({type:'frame-ready',sessionId:input.id,generation:joins.get(input.id).session.generation,streamGeneration:1,frameSequence:n+1,expiresAt:Date.now()+1000}));console.log('{}');}
 else if(input.action==='control-state'){const session={...joins.get(input.id).session,state:input.active?'controlling':'viewing'};group.control.send(JSON.stringify({type:'state',session,serverTime:Date.now(),...(input.active?{lease:{id:'L'.repeat(43),challenge:'C'.repeat(43),expiresAt:Date.now()+6000,challengeExpiresAt:Date.now()+6000}}:{})}));console.log('{}');}
 else if(input.action==='message'){group[input.role??'control'].send(JSON.stringify(input.value));console.log('{}');}
 else if(input.action==='close-media'){group.media.terminate();console.log('{}');}
 else if(input.action==='close-host'){if(!input.role){group.control.send(JSON.stringify({type:'state',session:{...joins.get(input.id).session,state:'closed',reason:input.reason},serverTime:Date.now()}));for(const ws of Object.values(group))ws.close(input.code,input.reason);}else group[input.role].close(input.code,input.reason);console.log('{}');}
 else if(input.action==='attach'){pendingAttach.get(input.id).send(JSON.stringify({type:'attached',sessionId:input.id}));pendingAttach.delete(input.id);console.log('{}');}
 else if(input.action==='hold-proof'){holdProof=input.hold;for(const r of held.keys())r.destroy();held.clear();console.log('{}');}
 else if(input.action==='release-proof'){holdProof=false;for(const respond of held.values())respond();held.clear();console.log('{}');}
 else if(input.action==='stats')console.log(JSON.stringify({paths,chatPaths,helloCount,proofCount,commands,open:[...clients].flatMap(([id,g])=>Object.entries(g).filter(([,s])=>s.readyState===1).map(([role])=>({id,role})))}));
 else if(input.action==='stop'){console.log('{}');break;}
}
for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));
