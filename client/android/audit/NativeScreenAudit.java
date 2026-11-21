package com.tarobot.client;

import java.io.*;
import java.lang.management.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** Production native transport + real pinned TLS / WS, synthetic screen only. */
public final class NativeScreenAudit {
    static final List<JSONObject> events=new ArrayList<>();
    static final JSONObject receipt=new JSONObject();
    static HubTransport transport; static String document; static JSONObject network;
    static BufferedWriter input; static BufferedReader output;
    static void check(boolean value,String name) throws Exception { if(!value) throw new Exception(name); receipt.put(name,true); }
    interface Work {void run() throws Exception;}
    static void reject(Work work,String name) throws Exception { boolean failed=false;try{work.run();}catch(Exception e){failed=true;}check(failed,name); }
    static JSONObject request(JSONObject value) throws Exception {input.write(value.toString()+"\n");input.flush();return new JSONObject(output.readLine());}
    static JSONObject event(String id,String kind) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(12);
        synchronized(events){while(true){for(int i=0;i<events.size();i++){JSONObject e=events.get(i);if(id.equals(e.optString("id"))&&kind.equals(e.optString("kind"))){events.remove(i);return e;}}long left=end-System.nanoTime();if(left<=0)throw new Exception("event timeout "+kind);TimeUnit.NANOSECONDS.timedWait(events,left);}}
    }
    static JSONObject join(boolean control) throws Exception {
        String sid=UUID.randomUUID().toString(); JSONObject display=new JSONObject().put("id","synthetic").put("nativeId","1").put("name","Synthetic").put("revision",1).put("x",0).put("y",0).put("width",64).put("height",64).put("scale",1).put("rotation",0);
        JSONObject session=new JSONObject().put("id",sid).put("generation",UUID.randomUUID().toString()).put("desktopId","synthetic-desktop").put("deviceId","synthetic-device").put("deviceName","Synthetic viewer").put("display",display).put("controlAllowed",control).put("state","viewing").put("createdAt",System.currentTimeMillis());
        String a=Base64.getUrlEncoder().withoutPadding().encodeToString((sid+"-c").substring(0,32).getBytes("UTF-8")),b=Base64.getUrlEncoder().withoutPadding().encodeToString((sid+"-m").substring(1,33).getBytes("UTF-8"));
        return new JSONObject().put("session",session).put("controlTicket",a).put("mediaTicket",b).put("expiresAt",System.currentTimeMillis()+30000).put("serverTime",System.currentTimeMillis()).put("quality","smooth");
    }
    static String open(JSONObject join) throws Exception {
        request(new JSONObject().put("action","register").put("join",join));String id=transport.allocate("screen",document);transport.screenOpen(id,network,join);
        for(int i=0;i<3;i++){JSONObject value=event(id,"screen");check(document.equals(value.getString("document")),"documentStamped");transport.screenAck(id,value.getLong("deliverySequence"));}
        return id;
    }
    /** Registers `join` with a fixture mode (the join itself stays strict) and opens it; a session the peer refuses may already be retired. */
    static String openMode(JSONObject join,String mode) throws Exception {
        request(new JSONObject().put("action","register").put("join",new JSONObject(join.toString()).put("fixtureMode",mode)));
        String id=transport.allocate("screen",document);try{transport.screenOpen(id,network,join);}catch(IOException closing){ }return id;
    }
    static void closedOnPeer(String sid) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(true){JSONArray open=request(new JSONObject().put("action","stats")).getJSONArray("open");boolean found=false;for(int i=0;i<open.length();i++)if(sid.equals(open.getJSONObject(i).getString("id")))found=true;if(!found)return;if(System.nanoTime()>end)throw new Exception("peer remained open");Thread.sleep(10);}
    }
    static JSONObject command(JSONObject join,String type) throws Exception {return new JSONObject().put("type",type).put("sessionId",join.getJSONObject("session").getString("id")).put("generation",join.getJSONObject("session").getString("generation"));}
    static void frame(JSONObject join,long generation,int sequence) throws Exception {request(new JSONObject().put("action","frame").put("id",join.getJSONObject("session").getString("id")).put("sequence",sequence).put("generation",generation).put("size",4096));}
    /** The next `binaries` binary deliveries of `id` in order, or stops at its close (then the last entry is that close). Bounded. */
    static List<JSONObject> deliveries(String id,int binaries) throws Exception {
        List<JSONObject> found=new ArrayList<>();long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);int count=0;
        synchronized(events){while(count<binaries){JSONObject next=null;for(int i=0;i<events.size();i++){JSONObject e=events.get(i);if(id.equals(e.optString("id"))&&("binary".equals(e.optString("kind"))||"close".equals(e.optString("kind")))){next=events.remove(i);break;}}
            if(next!=null){found.add(next);if("close".equals(next.getString("kind")))return found;count++;continue;}long left=end-System.nanoTime();if(left<=0)throw new Exception("binary timeout");TimeUnit.NANOSECONDS.timedWait(events,left);}}
        return found;
    }
    static void consume(String id,JSONObject binary) throws Exception {long n=binary.getLong("deliverySequence");int total=0;while(total<binary.getInt("byteLength"))total+=transport.screenRead(id,n,total,262144).length;transport.screenAck(id,n);}
    static JSONObject restart(JSONObject join,String id,long generation) throws Exception {request(new JSONObject().put("action","stream").put("id",join.getJSONObject("session").getString("id")).put("generation",generation));JSONObject config=event(id,"screen");transport.screenAck(id,config.getLong("deliverySequence"));return config;}
    /** A-5. The target's three-frame credit window belongs to one stream generation: a restart
     * (start control, keyframe request, resume) retires it and the next generation may send three
     * at once, while the page may still be reading packets of the old one. Packets of the current
     * generation stay bounded at three and all retained packets at six. */
    static void streamRestart() throws Exception {
        JSONObject join=join(true);String id=open(join),sid=join.getJSONObject("session").getString("id");
        frame(join,1,1);List<JSONObject> old=deliveries(id,1);
        JSONObject config=restart(join,id,2);check(config.getJSONObject("value").getLong("streamGeneration")==2,"restartConfigDelivered");
        final int w=HubScreenSession.BINARY_WINDOW; // the flight window; the bounds below are one window per generation and two in all
        for(int i=1;i<=w;i++)frame(join,2,i);List<JSONObject> fresh=deliveries(id,w);
        check(fresh.size()==w&&!"close".equals(fresh.get(w-1).getString("kind")),"restartWindowAdmittedBehindUnreadPacket");
        consume(id,old.get(0));for(JSONObject binary:fresh)consume(id,binary);check(transport.screenCurrent(id),"restartedSessionStaysOpen");
        for(int i=w+1;i<=2*w;i++)frame(join,2,i);List<JSONObject> window=deliveries(id,w);check(window.size()==w,"generationWindowRefills");
        frame(join,2,2*w+1);check("screen_viewer_congested".equals(deliveries(id,1).get(0).optString("reason")),"generationWindowStillBounded");closedOnPeer(sid);
        JSONObject chain=join(true);String chainId=open(chain),chainSid=chain.getJSONObject("session").getString("id");
        for(int i=1;i<=w;i++)frame(chain,1,i);deliveries(chainId,w);restart(chain,chainId,2);for(int i=1;i<=w;i++)frame(chain,2,i);deliveries(chainId,w);
        restart(chain,chainId,3);frame(chain,3,1);check("screen_viewer_congested".equals(deliveries(chainId,1).get(0).optString("reason")),"retainedPacketsStillBounded");closedOnPeer(chainSid);
    }
    static void frame(JSONObject join,int sequence,boolean malformed) throws Exception {request(new JSONObject().put("action","frame").put("id",join.getJSONObject("session").getString("id")).put("sequence",sequence).put("malformed",malformed));}
    /** Readers parked on the transport monitor inside HubSocket.onWebsocketPing (its activity report). */
    static List<ThreadInfo> parkedPings() {
        List<ThreadInfo> found=new ArrayList<>();
        for(ThreadInfo info:ManagementFactory.getThreadMXBean().dumpAllThreads(true,false)) {
            LockInfo lock=info.getLockInfo();
            if(info.getThreadState()!=Thread.State.BLOCKED||lock==null||lock.getIdentityHashCode()!=System.identityHashCode(transport)) continue;
            for(StackTraceElement frame:info.getStackTrace()) if(frame.getClassName().equals("com.tarobot.client.HubSocket")&&frame.getMethodName().equals("onWebsocketPing")) { found.add(info); break; }
        }
        return found;
    }
    /** F-AND-1, normal concurrency: the Hub's heartbeat ping is read while the bridge thread
     * holds the transport monitor to send (owner -> socket writes). Deterministic: the bridge
     * holds the monitor until both readers are parked on it inside onWebsocketPing, then sends.
     * Bounded: a wedged send ends this JVM within 5 s with the thread states, never a hang. */
    static void pingDuringSend() throws Exception {
        JSONObject join=join(true);String id=open(join),sid=join.getJSONObject("session").getString("id");
        JSONObject pongs=request(new JSONObject().put("action","stats")).getJSONObject("pongs");
        CountDownLatch holding=new CountDownLatch(1),go=new CountDownLatch(1);
        ExecutorService bridge=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"audit-bridge");t.setDaemon(true);return t;});
        try {
            Future<Boolean> sent=bridge.submit(()->{synchronized(transport){holding.countDown();if(!go.await(10,TimeUnit.SECONDS))return false;transport.screenSend(id,command(join,"control").put("frameSequence",1));return true;}});
            check(holding.await(5,TimeUnit.SECONDS),"bridgeHoldsTransportMonitor");
            request(new JSONObject().put("action","ping").put("id",sid).put("roles",new JSONArray().put("control").put("media")));
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);List<ThreadInfo> parked;
            while((parked=parkedPings()).size()<2){if(System.nanoTime()>until)throw new Exception("pingReadersNotParked");Thread.sleep(5);}
            boolean free=true;for(ThreadInfo info:parked)for(MonitorInfo held:info.getLockedMonitors())if(held.getLockedStackFrame().getClassName().startsWith("com.tarobot.client.HubSocket"))free=false;
            go.countDown();
            try{check(sent.get(5,TimeUnit.SECONDS),"sendDuringPingCompletes");}
            catch(TimeoutException wedged){
                System.err.println("F-AND-1 deadlock: send blocked behind a ping reader holding its socket monitor="+!free);
                for(ThreadInfo info:ManagementFactory.getThreadMXBean().dumpAllThreads(true,false))if(info.getThreadState()==Thread.State.BLOCKED)System.err.print(info);
                System.err.flush();System.exit(3);
            }
            check(free,"pingHoldsNoSocketMonitorWhileAwaitingOwner");
        } finally {go.countDown();bridge.shutdown();}
        // Once the monitor is free both pings are answered, the command reached the Host and frames still flow.
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);JSONObject stats;
        while(true){stats=request(new JSONObject().put("action","stats"));JSONObject now=stats.getJSONObject("pongs");if(now.getInt("control")>pongs.getInt("control")&&now.getInt("media")>pongs.getInt("media"))break;if(System.nanoTime()>until)throw new Exception("pingNotAnswered");Thread.sleep(10);}
        check(true,"pingAnsweredAfterSend");
        boolean delivered=false;JSONArray commands=stats.getJSONArray("commands");for(int i=0;i<commands.length();i++){JSONObject c=commands.getJSONObject(i);if(sid.equals(c.getString("id"))&&"control".equals(c.getString("role"))&&"control".equals(c.getJSONObject("value").getString("type")))delivered=true;}
        check(delivered,"commandDuringPingReachedHost");check(transport.screenCurrent(id),"sessionSurvivesPingDuringSend");
        frame(join,1,false);JSONObject binary=event(id,"binary");long n=binary.getLong("deliverySequence");int total=0;while(total<binary.getInt("byteLength"))total+=transport.screenRead(id,n,total,262144).length;transport.screenAck(id,n);check(true,"framesFlowAfterPingDuringSend");
        check(transport.screenClose(id),"pingDuringSendClosesNormally");event(id,"close");closedOnPeer(sid);
    }
    static String refusal(Work work) { try { work.run(); return null; } catch(Exception error) { return error.getMessage(); } }
    /** F-AND-3. The Hub withdraws control (lease expiry, Host stop, permission change) while the
     * page, which has not processed that state yet, still sends a renew or an input. Native has
     * applied the state: those are refused and never forwarded, as control having ended, not as a
     * protocol error that ends the session. A malformed one still is a protocol error. */
    static void controlWithdrawn() throws Exception {
        JSONObject join=join(true);String id=open(join),sid=join.getJSONObject("session").getString("id");
        request(new JSONObject().put("action","control-state").put("id",sid).put("active",true));JSONObject lease=event(id,"screen");transport.screenAck(id,lease.getLong("deliverySequence"));
        JSONObject renew=command(join,"renew").put("leaseId",String.join("",Collections.nCopies(43,"L"))).put("challenge",String.join("",Collections.nCopies(43,"C"))).put("frameSequence",1);
        JSONObject input=command(join,"input").put("desktopId","synthetic-desktop").put("displayId","synthetic").put("displayRevision",1).put("leaseId",String.join("",Collections.nCopies(43,"L"))).put("sequence",1).put("frameSequence",1).put("expiresAt",System.currentTimeMillis()+1000).put("event",new JSONObject().put("kind","move").put("x",0.5).put("y",0.5));
        transport.screenSend(id,command(join,"input-focus").put("enabled",true));transport.screenSend(id,renew);
        // Withdrawn: native applies the state on arrival; the page has not consumed it yet.
        request(new JSONObject().put("action","control-state").put("id",sid).put("active",false));JSONObject viewing=event(id,"screen");
        check("screen_control_ended".equals(refusal(()->transport.screenSend(id,renew))),"lateRenewRefusedAsControlEnded");
        check("screen_control_ended".equals(refusal(()->transport.screenSend(id,input))),"lateInputRefusedAsControlEnded");
        JSONObject malformed=new JSONObject(renew.toString()).put("challenge","short");
        check("screen_protocol_invalid".equals(refusal(()->transport.screenSend(id,malformed))),"malformedRenewStillProtocolInvalid");
        check("screen_protocol_invalid".equals(refusal(()->transport.screenSend(id,new JSONObject(input.toString()).put("desktopId","other")))),"foreignInputStillProtocolInvalid");
        transport.screenAck(id,viewing.getLong("deliverySequence"));check(transport.screenCurrent(id),"viewingSurvivesWithdrawnControl");
        JSONArray commands=request(new JSONObject().put("action","stats")).getJSONArray("commands");int renews=0,inputs=0;
        for(int i=0;i<commands.length();i++){JSONObject c=commands.getJSONObject(i);if(!sid.equals(c.getString("id")))continue;String type=c.getJSONObject("value").getString("type");if(type.equals("renew"))renews++;if(type.equals("input"))inputs++;}
        check(renews==1&&inputs==0,"withdrawnControlForwardsNothing");
        frame(join,1,false);consume(id,event(id,"binary"));check(transport.screenCurrent(id),"framesFlowAfterWithdrawnControl");
        transport.screenClose(id);event(id,"close");closedOnPeer(sid);
    }
    public static void main(String[] args) throws Exception {
        Process fixture=null; AtomicBoolean active=new AtomicBoolean(true);
        try{
            fixture=new ProcessBuilder("node","client/android/audit/screen-fixture.mjs",args[1]).directory(new File(args[0])).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            input=new BufferedWriter(new OutputStreamWriter(fixture.getOutputStream(),"UTF-8"));output=new BufferedReader(new InputStreamReader(fixture.getInputStream(),"UTF-8"));network=new JSONObject(output.readLine());
            transport=new HubTransport(new HubTls(),e->{synchronized(events){events.add(e);events.notifyAll();}},active::get);document=transport.document();
            JSONObject good=join(false);String id=open(good);frame(good,1,false);JSONObject binary=event(id,"binary");long n=binary.getLong("deliverySequence");
            reject(()->transport.screenAck(id,n),"partialAckRejected");reject(()->transport.screenRead(id,n,1,262144),"nonSequentialReadRejected");reject(()->transport.screenRead(id,n,0,262145),"oversizeReadRejected");
            byte[] a=transport.screenRead(id,n,0,262144),b=transport.screenRead(id,n,a.length,262144);check(a.length==262144&&a.length+b.length==binary.getInt("byteLength")&&b[b.length-1]==97,"binaryReassembledExactly");transport.screenAck(id,n);
            reject(()->transport.screenAck(id,n),"duplicateAckRejected");reject(()->transport.screenRead(id,n,0,1),"ackedPacketUnavailable");
            reject(()->transport.screenSend(id,command(good,"control").put("frameSequence",1)),"viewOnlyControlRejected");
            transport.screenSend(id,command(good,"keyframe"));
            reject(()->transport.screenSend(id,command(good,"keyframe").put("generation","stale")),"generationMismatchRejected");
            check(transport.screenClose(id)&&transport.screenClose(id),"closeIdempotent");event(id,"close");closedOnPeer(good.getJSONObject("session").getString("id"));
            reject(()->transport.screenSend(id,command(good,"keyframe")),"closedInputRejected");
            Object[][] terminations={{4000,"screen_locked","", "screen_locked"},{4000,"screen_permission_changed","media","screen_permission_changed"},{4001,"screen_locked","control","screen_network_closed"},{1000,"screen_locked","","screen_network_closed"},{4000,"screen_bad reason","","screen_network_closed"},{4000,"screen_"+String.join("",Collections.nCopies(58,"x")),"","screen_network_closed"},{4000,"session_expired","","session_expired"},{4000,"device_revoked","media","device_revoked"},{4000,"device_revoked_or_expired","control","device_revoked_or_expired"},{4000,"session_expired\n","","screen_network_closed"},{4000,"session_expire","","screen_network_closed"},{4001,"session_expired","","screen_network_closed"}};
            for(int i=0;i<terminations.length;i++) {
                Object[] item=terminations[i];JSONObject ending=join(false);String endingId=open(ending);
                JSONObject close=new JSONObject().put("action","close-host").put("id",ending.getJSONObject("session").getString("id")).put("code",item[0]).put("reason",item[1]);
                if(!item[2].equals(""))close.put("role",item[2]);request(close);
                check(item[3].equals(event(endingId,"close").getString("reason")),"hostCloseReasonCase"+i);
                closedOnPeer(ending.getJSONObject("session").getString("id"));
            }
            // A real Hub sends the session's state before "attached" on control. Such a state is held,
            // bounded, grants nothing and is delivered only after a matching "attached".
            JSONObject first=join(false);String firstId=openMode(first,"state-first");
            List<String> order=new ArrayList<>();
            for(int i=0;i<3;i++){JSONObject delivered=event(firstId,"screen");order.add(delivered.getJSONObject("value").getString("type"));transport.screenAck(firstId,delivered.getLong("deliverySequence"));}
            check(order.indexOf("attached")>=0&&order.indexOf("attached")<order.indexOf("state"),"earlyStateDeliveredAfterAttached");
            check(transport.screenClose(firstId),"earlyStateSessionStaysOpen");event(firstId,"close");closedOnPeer(first.getJSONObject("session").getString("id"));
            JSONObject granted=join(true);String grantedId=openMode(granted,"held-state");String grantedSid=granted.getJSONObject("session").getString("id");
            JSONObject renewHeld=command(granted,"renew").put("leaseId",String.join("",Collections.nCopies(43,"L"))).put("challenge",String.join("",Collections.nCopies(43,"C"))).put("frameSequence",1);
            long settle=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);boolean helloed=false;
            while(!helloed&&System.nanoTime()<settle){JSONArray open=request(new JSONObject().put("action","stats")).getJSONArray("open");for(int i=0;i<open.length();i++)if(grantedSid.equals(open.getJSONObject(i).getString("id"))&&"control".equals(open.getJSONObject(i).getString("role")))helloed=true;if(!helloed)Thread.sleep(10);}
            check(helloed,"heldStateSessionHelloed");Thread.sleep(300);
            // Media attaches on its own and may already deliver its stream; nothing from control may arrive yet.
            synchronized(events){boolean any=false;for(JSONObject e:events)if(grantedId.equals(e.optString("id"))&&"screen".equals(e.optString("kind"))&&!"stream".equals(e.getJSONObject("value").optString("type")))any=true;check(!any,"heldStateNotDeliveredBeforeAttached");}
            transport.screenSend(grantedId,command(granted,"input-focus").put("enabled",true));
            reject(()->transport.screenSend(grantedId,renewHeld),"heldStateGrantsNoControlBeforeAttached");
            request(new JSONObject().put("action","attach").put("id",grantedSid));
            List<String> controlOrder=new ArrayList<>();
            while(controlOrder.size()<2){JSONObject delivered=event(grantedId,"screen");String kind=delivered.getJSONObject("value").getString("type");transport.screenAck(grantedId,delivered.getLong("deliverySequence"));if(!kind.equals("stream"))controlOrder.add(kind);}
            check(controlOrder.equals(Arrays.asList("attached","state")),"heldStateFollowsAttached");
            transport.screenSend(grantedId,command(granted,"input-focus").put("enabled",true));transport.screenSend(grantedId,renewHeld);check(true,"heldStateGrantsControlOnceAttached");
            transport.screenClose(grantedId);event(grantedId,"close");closedOnPeer(grantedSid);
            JSONObject missing=join(true);String missingId=openMode(missing,"held-state");
            // Its media stream is consumed as the page would; only the absent "attached" ends it.
            String missingReason=null;long missingEnd=System.nanoTime()+TimeUnit.SECONDS.toNanos(14);
            while(missingReason==null&&System.nanoTime()<missingEnd){JSONObject next=null;synchronized(events){for(int i=0;i<events.size();i++)if(missingId.equals(events.get(i).optString("id"))){next=events.remove(i);break;}if(next==null)events.wait(50);}
                if(next==null)continue;if("screen".equals(next.optString("kind")))transport.screenAck(missingId,next.getLong("deliverySequence"));else if("close".equals(next.optString("kind")))missingReason=next.getString("reason");}
            check("screen_connect_timeout".equals(missingReason),"missingAttachedStillTimesOut");closedOnPeer(missing.getJSONObject("session").getString("id"));
            // Nothing else may precede "attached", and what is held is bounded.
            String[][] refused={{"foreign-state-first","foreignStateBeforeAttachedRefused"},{"ready-first","readyBeforeAttachedRefused"},{"wrong-attached","wrongAttachedAfterEarlyStateRefused"},{"state-flood","fifthEarlyStateRefused"},{"state-oversize","earlyStateBytesBounded"}};
            for(String[] item:refused){JSONObject early=join(false);String earlyId=openMode(early,item[0]);
                check("screen_protocol_invalid".equals(event(earlyId,"close").getString("reason")),item[1]);closedOnPeer(early.getJSONObject("session").getString("id"));}
            JSONObject controlling=join(true);String controlId=open(controlling);
            request(new JSONObject().put("action","control-state").put("id",controlling.getJSONObject("session").getString("id")).put("active",true));JSONObject leaseEvent=event(controlId,"screen");transport.screenAck(controlId,leaseEvent.getLong("deliverySequence"));
            JSONObject renew=command(controlling,"renew").put("leaseId",String.join("",Collections.nCopies(43,"L"))).put("challenge",String.join("",Collections.nCopies(43,"C"))).put("frameSequence",1);
            reject(()->transport.screenSend(controlId,renew),"renewRequiresFocus");transport.screenSend(controlId,command(controlling,"input-focus").put("enabled",true));transport.screenSend(controlId,renew);
            transport.screenSend(controlId,command(controlling,"input-focus").put("enabled",false));reject(()->transport.screenSend(controlId,renew),"blurRejectsQueuedRenew");transport.screenClose(controlId);event(controlId,"close");closedOnPeer(controlling.getJSONObject("session").getString("id"));
            pingDuringSend();
            streamRestart();
            controlWithdrawn();
            JSONObject bound=join(false);String bounded=open(bound);for(int i=1;i<=4;i++)frame(bound,i,false);event(bounded,"close");closedOnPeer(bound.getJSONObject("session").getString("id"));check(true,"fourthPacketClosesBoth");
            JSONObject expiry=join(false);String expired=open(expiry);frame(expiry,1,false);event(expired,"binary");event(expired,"close");closedOnPeer(expiry.getJSONObject("session").getString("id"));check(true,"unackedPacketExpiresAndClosesBoth");
            JSONObject json=join(false);String jsonId=open(json);request(new JSONObject().put("action","json-burst").put("id",json.getJSONObject("session").getString("id")).put("count",9));event(jsonId,"close");closedOnPeer(json.getJSONObject("session").getString("id"));check(true,"jsonQueueBounded");
            JSONObject sibling=join(false);String siblingId=open(sibling);request(new JSONObject().put("action","close-media").put("id",sibling.getJSONObject("session").getString("id")));event(siblingId,"close");closedOnPeer(sibling.getJSONObject("session").getString("id"));check(true,"siblingFailureClosesControl");
            JSONObject malformed=join(false);String malformedId=open(malformed);frame(malformed,1,true);event(malformedId,"close");closedOnPeer(malformed.getJSONObject("session").getString("id"));check(true,"malformedFrameClosesBoth");
            String chat=transport.allocate("socket",document);transport.socketOpen(chat,network.getString("url"),network.getString("publicKey"),network.getString("certificateAuthority"));event(chat,"open");
            JSONObject oversize=join(false);String oversizeId=open(oversize);request(new JSONObject().put("action","frame").put("id",oversize.getJSONObject("session").getString("id")).put("size",1048577));event(oversizeId,"close");closedOnPeer(oversize.getJSONObject("session").getString("id"));check(true,"oversizeBinaryClosesBeforeRetention");
            JSONObject largeText=join(false);String largeId=open(largeText);request(new JSONObject().put("action","message").put("id",largeText.getJSONObject("session").getString("id")).put("value",new JSONObject().put("type","unknown").put("data",String.join("",Collections.nCopies(16385,"x")))));event(largeId,"close");closedOnPeer(largeText.getJSONObject("session").getString("id"));check(true,"oversizeControlClosesBeforeDelivery");
            JSONObject background=join(true);String bg=open(background);active.set(false);transport.closeScreens("screen_inactive");event(bg,"close");closedOnPeer(background.getJSONObject("session").getString("id"));reject(()->transport.allocate("screen",document),"inactiveAllocationRejected");transport.socketSend(chat,"main-chat-stays-open");JSONObject chatEvent=event(chat,"message");check("main-chat-stays-open".equals(chatEvent.getString("data")),"backgroundRetiresOnlyScreenNotMainChat");transport.socketAck(chat,chatEvent.getLong("sequence"));transport.cancel(chat);active.set(true);reject(()->transport.screenSend(bg,command(background,"control").put("frameSequence",1)),"foregroundDoesNotRestoreOldControl");
            JSONObject reload=join(false);String reloadId=open(reload);frame(reload,1,false);JSONObject pending=event(reloadId,"binary");String old=document;document=transport.document();event(reloadId,"close");reject(()->transport.screenRead(reloadId,pending.getLong("deliverySequence"),0,1),"documentRetiresPendingBinary");reject(()->transport.allocate("screen",old),"oldDocumentRejected");check(!transport.screenEventCurrent(pending),"retiredQueuedEventFiltered");closedOnPeer(reload.getJSONObject("session").getString("id"));
            JSONObject invalid=join(false).put("expiresAt",0);String invalidId=transport.allocate("screen",document);int before=request(new JSONObject().put("action","stats")).getInt("helloCount");reject(()->transport.screenOpen(invalidId,network,invalid),"expiredJoinRejectedBeforeNetwork");check(request(new JSONObject().put("action","stats")).getInt("helloCount")==before,"invalidJoinSendsNoTicket");
            String wrong=transport.allocate("screen",document);JSONObject wrongNetwork=new JSONObject(network.toString());byte[] key=Base64.getDecoder().decode(network.getString("publicKey"));key[key.length-1]^=1;wrongNetwork.put("publicKey",Base64.getEncoder().encodeToString(key));
            int beforeWrong=request(new JSONObject().put("action","stats")).getInt("helloCount");reject(()->transport.screenOpen(wrong,wrongNetwork,join(false)),"wrongPinRejected");check(request(new JSONObject().put("action","stats")).getInt("helloCount")==beforeWrong,"wrongPinLeaksNoHello");
            request(new JSONObject().put("action","hold-proof").put("hold",true));int proofs=request(new JSONObject().put("action","stats")).getInt("proofCount");
            HubTransport cold=new HubTransport(new HubTls(),e->{},active::get);ExecutorService executor=Executors.newSingleThreadExecutor();
            try {String coldDocument=cold.document(),coldId=cold.allocate("screen",coldDocument);JSONObject coldJoin=join(false);Future<Boolean> started=executor.submit(()->{try{cold.screenOpen(coldId,network,coldJoin);return false;}catch(Exception expected){return true;}});
                long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(request(new JSONObject().put("action","stats")).getInt("proofCount")==proofs){if(System.nanoTime()>until)throw new Exception("proof did not start");Thread.sleep(10);}
                active.set(false);cold.closeScreens("screen_inactive");check(started.get(3,TimeUnit.SECONDS),"backgroundCancelsPendingTlsProof");check(request(new JSONObject().put("action","stats")).getInt("helloCount")==beforeWrong,"pendingProofCancellationLeaksNoHello");
                active.set(true);reject(()->cold.screenOpen(coldId,network,coldJoin),"foregroundCannotReplayCancelledOpen");
            }finally{active.set(true);cold.close();executor.shutdownNow();request(new JSONObject().put("action","hold-proof").put("hold",false));}
            JSONObject stats=request(new JSONObject().put("action","stats"));JSONArray paths=stats.getJSONArray("paths");for(int i=0;i<paths.length();i++)check(Arrays.asList("/screen/v1/control","/screen/v1/media").contains(paths.getString(i)),"onlyFixedViewerRoutes");
            check(stats.getJSONArray("open").length()==0,"allNativePeersClosed");receipt.put("surface","JVM exact Android native transport with synthetic pinned TLS WebSockets; not APK");
            Files.write(Paths.get(args[2]),receipt.toString(2).getBytes("UTF-8"));System.out.println(receipt.toString(2));
        }finally{if(transport!=null)transport.close();if(fixture!=null){try{request(new JSONObject().put("action","stop"));}catch(Exception ignored){}fixture.destroy();if(!fixture.waitFor(5,TimeUnit.SECONDS))fixture.destroyForcibly();}}
    }
}
