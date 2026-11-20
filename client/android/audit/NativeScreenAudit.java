package com.tarobot.client;

import java.io.*;
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
    static void closedOnPeer(String sid) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(true){JSONArray open=request(new JSONObject().put("action","stats")).getJSONArray("open");boolean found=false;for(int i=0;i<open.length();i++)if(sid.equals(open.getJSONObject(i).getString("id")))found=true;if(!found)return;if(System.nanoTime()>end)throw new Exception("peer remained open");Thread.sleep(10);}
    }
    static JSONObject command(JSONObject join,String type) throws Exception {return new JSONObject().put("type",type).put("sessionId",join.getJSONObject("session").getString("id")).put("generation",join.getJSONObject("session").getString("generation"));}
    static void frame(JSONObject join,int sequence,boolean malformed) throws Exception {request(new JSONObject().put("action","frame").put("id",join.getJSONObject("session").getString("id")).put("sequence",sequence).put("malformed",malformed));}
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
            JSONObject controlling=join(true);String controlId=open(controlling);
            request(new JSONObject().put("action","control-state").put("id",controlling.getJSONObject("session").getString("id")).put("active",true));JSONObject leaseEvent=event(controlId,"screen");transport.screenAck(controlId,leaseEvent.getLong("deliverySequence"));
            JSONObject renew=command(controlling,"renew").put("leaseId",String.join("",Collections.nCopies(43,"L"))).put("challenge",String.join("",Collections.nCopies(43,"C"))).put("frameSequence",1);
            reject(()->transport.screenSend(controlId,renew),"renewRequiresFocus");transport.screenSend(controlId,command(controlling,"input-focus").put("enabled",true));transport.screenSend(controlId,renew);
            transport.screenSend(controlId,command(controlling,"input-focus").put("enabled",false));reject(()->transport.screenSend(controlId,renew),"blurRejectsQueuedRenew");transport.screenClose(controlId);event(controlId,"close");closedOnPeer(controlling.getJSONObject("session").getString("id"));
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
