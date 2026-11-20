// Production iOS transport on Apple Foundation, pinned loopback TLS and synthetic
// screen frames. No capture, input injection, system trust or App data changes.
// Usage: node client/scripts/ios-screen-audit.mjs <private-output-directory>
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const repo=fileURLToPath(new URL('../../',import.meta.url));
if(!process.argv[2])throw Error('private output directory required');
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const scratch=await mkdtemp(path.join(output,'screen-audit-'));
async function run(args,name,timeout){
 const log=createWriteStream(path.join(output,name));
 const child=spawn('/usr/bin/xcrun',args,{cwd:repo,env:{...process.env,TMPDIR:scratch},detached:true,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 const stop=()=>{try{if(child.pid)process.kill(-child.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}};
 let expired=false;const timer=setTimeout(()=>{expired=true;stop()},timeout);
 try{const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});if(expired||code!==0)throw Error(`${name}: ${expired?'timeout':`exit ${code}`}`)}
 finally{clearTimeout(timer);stop();await new Promise(resolve=>log.end(resolve))}
}
try{
 const sources=['HubTLS','HubScreenSession','HubTransport'].map(name=>`client/ios/App/App/${name}.swift`);
 const headers=path.join(repo,'client/node_modules/@capacitor/ios/Capacitor/Capacitor'),module=path.join(scratch,'Capacitor');await mkdir(module);
 await writeFile(path.join(module,'BridgeHeaders.h'),`#import <Foundation/Foundation.h>\n@class UIViewController;\n#import "${headers}/CAPBridgedPlugin.h"\n`);
 await writeFile(path.join(module,'module.modulemap'),'module Capacitor { header "BridgeHeaders.h" export * }\n');
 const common=['swiftc','-swift-version','5','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.0`,'-module-cache-path',path.join(scratch,'module-cache')];
 await run([...common,'-typecheck','-I',scratch,'client/ios/tests/CapacitorCompileOverlay.swift',...sources,'client/ios/App/App/HubTransportPlugin.swift'],'plugin-typecheck.log',90000);
 const binary=path.join(scratch,'HubScreenChecks');
 await run([...common,'-parse-as-library',...sources,'client/ios/tests/HubScreenChecks.swift','-o',binary],'compile.log',90000);
 await run([binary,repo,scratch,path.join(output,'ios-screen-foundation-result.json')],'run.log',90000);
 console.log(await readFile(path.join(output,'ios-screen-foundation-result.json'),'utf8'));
}finally{await rm(scratch,{recursive:true,force:true})}
